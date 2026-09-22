/**
 * Establishes tenant context for every request.
 *
 * Registered globally, so nothing reaches a controller without passing through
 * it. Ordering is security-critical: nothing may touch the database before this
 * has run, because `TenantDb` refuses to open a transaction without a context.
 *
 * The access token is read from an httpOnly cookie, never from a header the
 * page's JavaScript could reach. `clinic_id` comes from the VERIFIED token and
 * from nowhere else — there is no endpoint shaped
 * `/v1/clinics/:clinicId/patients`, because that shape invites an IDOR and the
 * tenant is already unambiguous from the token.
 *
 * NOTE ON TYPES. Nest runs middleware through middie, which is below the layer
 * where Fastify builds its request and reply wrappers. So what arrives here is
 * the raw Node pair, not FastifyRequest/FastifyReply: there is no `req.cookies`
 * even though @fastify/cookie is registered, no `req.ip`, and no `res.header`.
 * Typing these as Fastify objects compiles perfectly and then finds no cookie on
 * any request, which fails closed and therefore fails silently — every caller
 * looks unauthenticated. Hence the raw types and the hand-rolled accessors.
 */

import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type NestMiddleware,
} from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import { TenantContext, type TenantContextData } from './tenant-context';
import { ClinicStatusCache } from './clinic-status.cache';
import { TokenRevocationCache } from '../auth/token-revocation.cache';
import { TokenService } from '../auth/token.service';

export const ACCESS_COOKIE = 'emr_access';
export const REFRESH_COOKIE = 'emr_refresh';

@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(
    private readonly tokens: TokenService,
    private readonly clinicStatus: ClinicStatusCache,
    private readonly revocation: TokenRevocationCache,
  ) {}

  async use(req: IncomingMessage, res: ServerResponse, next: () => void) {
    const requestId = header(req, 'x-request-id') ?? randomUUID();
    res.setHeader('x-request-id', requestId);

    const token = readCookie(req, ACCESS_COOKIE);

    // No token means either a public route or an unauthenticated caller. Public
    // routes never reach a tenant-scoped handler, and TenantDb refuses any
    // database access without a context — so proceeding is safe here.
    if (!token) return next();

    const claims = await this.tokens.verifyAccessToken(token);
    if (!claims) return next();

    /*
     * Re-check the clinic on EVERY request rather than trusting the token. A
     * clinic suspended for non-payment or placed on a security hold must stop
     * working immediately, not when its users' ten-minute tokens expire.
     */
    const clinic = await this.clinicStatus.get(claims.clinic_id);
    if (!clinic) throw new UnauthorizedException('That clinic no longer exists.');
    if (!clinic.isActive) {
      throw new ForbiddenException(
        'This clinic account is suspended. Please contact support.',
      );
    }

    /*
     * Instant revocation. A dismissed employee's token dies when the session is
     * revoked, not when it happens to expire.
     */
    if (await this.revocation.isRevoked(claims.jti)) {
      throw new UnauthorizedException('That session has ended. Sign in again.');
    }

    const context: TenantContextData = {
      clinicId: claims.clinic_id,
      userId: claims.sub,
      userName: claims.name,
      role: claims.role,
      jti: claims.jti,
      requestId,
      ipAddress: clientIp(req),
      userAgent: header(req, 'user-agent'),
    };

    // Bound for the entire async call tree of this request.
    TenantContext.run(context, () => next());
  }
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

/**
 * The audited client address.
 *
 * Fastify's trustProxy does this for the routes it serves, but that decoration
 * does not exist down here. Behind a load balancer the real address is the FIRST
 * entry of X-Forwarded-For; without this, every audit row in production records
 * the balancer's address and the trail is worthless.
 */
function clientIp(req: IncomingMessage): string | null {
  const forwarded = header(req, 'x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? null;
}

/**
 * One cookie, by name, from the raw header.
 *
 * Deliberately narrow: it reads a single value rather than parsing the header
 * into an object, because the only cookies this application reads are its own
 * two and neither carries a value that needs anything cleverer.
 */
function readCookie(req: IncomingMessage, name: string): string | null {
  const jar = req.headers.cookie;
  if (!jar) return null;

  for (const part of jar.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // A malformed cookie is an unauthenticated request, not a 500.
      return null;
    }
  }
  return null;
}
