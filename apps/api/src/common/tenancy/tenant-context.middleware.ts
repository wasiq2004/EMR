/**
 * Establishes tenant context for every authenticated request.
 *
 * Registered GLOBALLY in main.ts. Runs after JwtAuthGuard (which verifies the
 * token signature) and before every controller.
 *
 * Ordering is security-critical: nothing may touch the database before this has
 * run, because TenantDb refuses to open a transaction without a context.
 */

import {
  ForbiddenException,
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';

import { TenantContext, type TenantContextData, type UserRole } from './tenant-context';
import { ClinicStatusCache } from './clinic-status.cache';
import { TokenRevocationCache } from '../auth/token-revocation.cache';

/** Claims carried by the access token. Populated by JwtAuthGuard. */
export interface AuthenticatedRequest extends FastifyRequest {
  user?: {
    sub: string;
    name: string;
    clinic_id: string;
    role: UserRole;
    jti: string;
  };
}

@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(
    private readonly clinicStatus: ClinicStatusCache,
    private readonly revocation: TokenRevocationCache,
  ) {}

  async use(req: AuthenticatedRequest, res: FastifyReply, next: () => void) {
    const claims = req.user;

    // No claims means JwtAuthGuard did not run or the route is @Public().
    // Public routes never reach a tenant-scoped handler, so proceeding without
    // a context is correct here — TenantDb will refuse any DB access.
    if (!claims) {
      return next();
    }

    if (!claims.clinic_id || !claims.sub || !claims.role) {
      throw new UnauthorizedException('Access token is missing required claims.');
    }

    /**
     * Re-check clinic status on EVERY request rather than trusting the token.
     *
     * A clinic suspended for non-payment or placed on a security hold must stop
     * working immediately, not when its users' 10-minute tokens happen to
     * expire. Backed by a 30-second Redis cache, so this costs ~0.1 ms.
     */
    const clinic = await this.clinicStatus.get(claims.clinic_id);
    if (!clinic) {
      throw new UnauthorizedException('Clinic not found.');
    }
    if (!clinic.isActive) {
      throw new ForbiddenException(
        'This clinic account is suspended. Please contact support.',
      );
    }

    /**
     * Instant revocation. The refresh-session store is authoritative; a stolen
     * or dismissed-employee token is dead as soon as the session is revoked,
     * without waiting for expiry.
     */
    if (await this.revocation.isRevoked(claims.jti)) {
      throw new UnauthorizedException('Session has been revoked. Please sign in again.');
    }

    const requestId =
      (req.headers['x-request-id'] as string | undefined) ?? randomUUID();

    const context: TenantContextData = {
      clinicId: claims.clinic_id,
      userId: claims.sub,
      userName: claims.name,
      role: claims.role,
      jti: claims.jti,
      requestId,
      // Behind an ALB, the client IP is the first entry of X-Forwarded-For.
      // Fastify's trustProxy must be configured, or this reports the LB.
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    };

    res.header('x-request-id', requestId);

    // Bind for the entire async call tree of this request.
    TenantContext.run(context, () => next());
  }
}
