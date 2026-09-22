import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { config } from '../../config';
import { Public } from '../../common/http/decorators';
import { SkipAudit } from '../../common/audit/audit.interceptor';
import { parseBody, requireUuid } from '../../common/http/zod.pipe';
import { PlatformService } from './platform.service';
import { UsageAggregator } from './usage-aggregator.service';
import { platformDbProviders } from './platform-db.service';
import {
  PLATFORM_COOKIE,
  PlatformGuard,
  RequirePlatformRole,
  type PlatformActor,
} from './platform.guard';

/**
 * The operations console.
 *
 * Mounted under /platform and gated by PlatformGuard rather than RbacGuard —
 * a different identity system with a different cookie, reached through a
 * database connection that has no privilege on any clinical table.
 *
 * Every route here is `@Public()` as far as the CLINIC guard is concerned. That
 * reads alarmingly and is exactly right: it means "this is not a clinic
 * session", and PlatformGuard then refuses anything without a platform one.
 * Without it the clinic guard would reject every request before the platform
 * guard ever ran.
 */

type PlatformRequest = FastifyRequest & { platformActor?: PlatformActor };

const StateChange = z.object({
  /**
   * Required, and not a formality.
   *
   * Suspending a clinic stops a doctor mid-consultation. An operator who cannot
   * say why should not be doing it, and the clinic is entitled to an answer
   * that is not "the system did it".
   */
  reason: z.string().trim().min(10, 'Say why, in a sentence someone else can act on'),
});

const PlanChange = StateChange.extend({
  plan: z.string().trim().min(1),
  status: z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED']),
  monthlyPricePaise: z.number().int().min(0),
  maxPractitioners: z.number().int().positive().nullable().optional(),
  maxPatients: z.number().int().positive().nullable().optional(),
  includedMessagesPerMonth: z.number().int().min(0).nullable().optional(),
  trialEndsAt: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

@Controller('platform')
export class PlatformController {
  constructor(
    private readonly platform: PlatformService,
    private readonly usage: UsageAggregator,
  ) {}

  /* ---- Session ---------------------------------------------------------- */

  @Public()
  @SkipAudit()
  @Post('auth/login')
  async login(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseBody(
      z.object({ email: z.string().email(), password: z.string().min(1) }),
      body,
    );

    const result = await this.platform.signIn(
      input.email,
      input.password,
      request.ip ?? null,
      (request.headers['user-agent'] as string | undefined) ?? null,
    );

    reply.setCookie(PLATFORM_COOKIE, result.token, {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
      /*
       * Path '/', not '/v1/platform'.
       *
       * Scoping it to the console reads tighter and does not work: the browser
       * reaches the API through the BFF at /api/platform, so a cookie scoped to
       * the API's own path is never sent and the console cannot sign in at all.
       *
       * The separation that matters is not the path anyway — it is the cookie
       * NAME and the token AUDIENCE. A clinic endpoint receiving this cookie
       * does not look at it, and a platform token fails clinic verification
       * because it was signed for a different audience.
       */
      path: '/',
      maxAge: 60 * 60,
    });

    return { operator: result.operator };
  }

  @Public()
  @SkipAudit()
  @Post('auth/logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) reply: FastifyReply) {
    void reply.clearCookie(PLATFORM_COOKIE, { path: '/' });
  }

  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('SUPPORT')
  @Get('auth/me')
  me(@Req() request: PlatformRequest) {
    return this.platform.operator(request.platformActor!.userId);
  }

  /* ---- The estate ------------------------------------------------------- */

  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('SUPPORT')
  @Get('overview')
  overview() {
    return this.platform.overview();
  }

  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('SUPPORT')
  @Get('tenants')
  async tenants() {
    return { items: await this.platform.tenants() };
  }

  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('SUPPORT')
  @Get('tenants/:id')
  tenant(@Param('id') id: string) {
    return this.platform.tenant(requireUuid(id, 'Clinic'));
  }

  /* ---- Changes ---------------------------------------------------------- */

  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('OPERATOR')
  @Post('tenants/:id/suspend')
  suspend(@Req() request: PlatformRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parseBody(StateChange, body);
    return this.platform.suspend(
      request.platformActor!,
      requireUuid(id, 'Clinic'),
      input.reason,
    );
  }

  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('OPERATOR')
  @Post('tenants/:id/restore')
  restore(@Req() request: PlatformRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parseBody(StateChange, body);
    return this.platform.restore(
      request.platformActor!,
      requireUuid(id, 'Clinic'),
      input.reason,
    );
  }

  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('OPERATOR')
  @Post('tenants/:id/plan')
  setPlan(@Req() request: PlatformRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parseBody(PlanChange, body);
    return this.platform.setPlan(request.platformActor!, requireUuid(id, 'Clinic'), input);
  }

  /**
   * Recomputes usage.
   *
   * Exposed so a scheduler can call it rather than the API holding its own
   * cron — one fewer thing that behaves differently across replicas. Safe to
   * call repeatedly: a day recomputes in place.
   */
  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('OPERATOR')
  @Post('usage/aggregate')
  aggregate(@Body() body: { day?: string }) {
    return this.usage.aggregateAll(body?.day);
  }

  /* ---- What operators did ----------------------------------------------- */

  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('SUPPORT')
  @Get('audit')
  async audit(@Query('clinicId') clinicId?: string) {
    return {
      items: await this.platform.auditTrail(
        clinicId ? requireUuid(clinicId, 'Clinic') : undefined,
      ),
    };
  }
}

@Module({
  controllers: [PlatformController],
  providers: [...platformDbProviders, PlatformService, PlatformGuard, UsageAggregator],
  exports: [UsageAggregator],
})
export class PlatformModule {}
