import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { LoginInput, MfaInput } from '@emr/contracts';
import { config } from '../../config';
import { parseBody } from '../../common/http/zod.pipe';
import { Authenticated, Public, SkipAudit } from '../../common/http/decorators';
import { TenantContext } from '../../common/tenancy/tenant-context';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
} from '../../common/tenancy/tenant-context.middleware';
import { AuthService } from './auth.service';

type Cookied = FastifyRequest & { cookies?: Record<string, string> };

/**
 * Authentication.
 *
 * Tokens travel in httpOnly cookies and never in a response body, so no script
 * on the page can read them. Four of the system's small number of
 * unauthenticated routes live here.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  async login(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const input = parseBody(LoginInput, body);

    const result = await this.auth.signIn({
      email: input.email,
      password: input.password,
      clinicSlug: clinicSlugFrom(req),
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    setSessionCookies(res, result.accessToken, result.refreshToken, result.refreshTtlSeconds);
    return { mfaRequired: result.mfaRequired, session: result.session };
  }

  /**
   * Two-factor verification.
   *
   * The enrolment flow is not built yet, so this accepts the session that
   * sign-in already issued rather than pretending to check a code it cannot
   * check. That is stated plainly rather than hidden: a verification step that
   * silently passes is worse than no verification step, because it implies a
   * control that is not running.
   */
  @Public()
  @Post('mfa/verify')
  async verifyMfa(@Body() body: unknown) {
    parseBody(MfaInput, body);
    throw new UnauthorizedException(
      'Two-factor enrolment is not yet available on this deployment. ' +
        'Ask a clinic administrator to complete sign-in setup.',
    );
  }

  @Public()
  @Post('refresh')
  async refresh(
    @Req() req: Cookied,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw new UnauthorizedException('Please sign in again.');

    const result = await this.auth.refresh(token);
    setSessionCookies(res, result.accessToken, result.refreshToken, result.refreshTtlSeconds);
    return { session: result.session };
  }

  @Authenticated()
  @Post('logout')
  async logout(@Req() req: Cookied, @Res({ passthrough: true }) res: FastifyReply) {
    const ctx = TenantContext.get();
    if (ctx) await this.auth.signOut(ctx.jti, req.cookies?.[REFRESH_COOKIE]);

    void res.clearCookie(ACCESS_COOKIE, { path: '/' });
    void res.clearCookie(REFRESH_COOKIE, { path: '/' });
    void res.status(204);
  }

  /** Polled by every screen, so it is exempt from the audit trail. */
  @SkipAudit()
  @Authenticated()
  @Get('me')
  async me() {
    const ctx = TenantContext.get();
    if (!ctx) throw new UnauthorizedException('Please sign in.');
    return this.auth.sessionFor(ctx.clinicId, ctx.userId);
  }
}

/**
 * The clinic, from the subdomain.
 *
 * This is the documented exception to "the clinic comes from the verified token
 * and nowhere else": at sign-in there is no token, and email is unique per
 * clinic rather than globally. The value is only ever used to look up a clinic
 * row — it is never trusted as an identity.
 */
function clinicSlugFrom(req: FastifyRequest): string | null {
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.hostname;
  if (!host) return null;

  const [name] = host.split(':');
  const labels = (name ?? '').split('.');
  if (labels.length < 3) return null;

  const first = labels[0]!;
  return first === 'www' || first === 'app' ? null : first;
}

function setSessionCookies(
  res: FastifyReply,
  accessToken: string,
  refreshToken: string,
  refreshTtlSeconds: number,
) {
  const base = {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax' as const,
    path: '/',
  };

  void res.setCookie(ACCESS_COOKIE, accessToken, {
    ...base,
    maxAge: config.ACCESS_TOKEN_TTL_SECONDS,
  });
  void res.setCookie(REFRESH_COOKIE, refreshToken, {
    ...base,
    maxAge: refreshTtlSeconds,
  });
}
