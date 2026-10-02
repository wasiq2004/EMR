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
import { PlatformAdminService } from './platform-admin.service';
import { PlatformSupportService } from './platform-support.service';
import { platformDbProviders } from './platform-db.service';
import { ClinicDirectoryService } from './clinic-directory.service';
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
  /**
   * A catalogue id, not a name.
   *
   * The free-text version of this field is what let a clinic sit on a plan
   * called "clinic " with a trailing space, matching nothing, features all off.
   */
  planId: z.string().uuid('Choose a plan from the catalogue'),
  status: z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED']),

  /*
   * Everything below is an OVERRIDE, and omitting it means "whatever the plan
   * says". That is why none of these are required: the ordinary case is a
   * clinic on list terms, and the console should not make an operator retype
   * five numbers to achieve it.
   */
  monthlyPricePaise: z.number().int().min(0).optional(),
  maxPractitioners: z.number().int().positive().nullable().optional(),
  maxPatients: z.number().int().positive().nullable().optional(),
  includedMessagesPerMonth: z.number().int().min(0).nullable().optional(),
  trialEndsAt: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});


const FeatureMap = z.record(z.string(), z.boolean());

const PlanInput = z.object({
  id: z.string().uuid().optional(),
  code: z
    .string()
    .trim()
    .min(2)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Lower-case letters, digits and hyphens'),
  name: z.string().trim().min(2),
  description: z.string().nullable().optional(),
  monthlyPricePaise: z.number().int().min(0),
  annualPricePaise: z.number().int().min(0).nullable().optional(),
  // Null is unlimited, which is a different thing from zero.
  maxPractitioners: z.number().int().positive().nullable().optional(),
  maxPatients: z.number().int().positive().nullable().optional(),
  maxLocations: z.number().int().positive().nullable().optional(),
  includedMessagesPerMonth: z.number().int().min(0).nullable().optional(),
  storageGb: z.number().int().positive().nullable().optional(),
  features: FeatureMap,
  isActive: z.boolean().default(true),
  isPrivate: z.boolean().default(false),
  trialDays: z.number().int().min(0).default(0),
  displayOrder: z.number().int().min(0).default(0),
});

const OperatorInput = z.object({
  fullName: z.string().trim().min(2),
  email: z.string().email(),
  role: z.enum(['SUPPORT', 'OPERATOR', 'PLATFORM_ADMIN']),
});

const OnboardInput = z.object({
  name: z.string().trim().min(2, 'Enter the clinic name'),
  slug: z
    .string()
    .trim()
    .min(3)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'The slug is the subdomain: lower-case and hyphens'),
  adminName: z.string().trim().min(2),
  adminEmail: z.string().email(),
  planId: z.string().uuid().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  contactEmail: z.string().email().nullable().optional(),
  contactPhoneE164: z.string().nullable().optional(),
  timezone: z.string().optional(),
});

@Controller('platform')
export class PlatformController {
  constructor(
    private readonly platform: PlatformService,
    private readonly usage: UsageAggregator,
    private readonly admin: PlatformAdminService,
    private readonly support: PlatformSupportService,
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


  /* ---- The plan catalogue ------------------------------------------------ */

  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('SUPPORT')
  @Get('plans')
  async plans() {
    return { items: await this.admin.plans() };
  }

  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('OPERATOR')
  @Post('plans')
  savePlan(@Req() request: PlatformRequest, @Body() body: unknown) {
    return this.admin.savePlan(request.platformActor!, parseBody(PlanInput, body));
  }

  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('OPERATOR')
  @Post('plans/:id/retire')
  retirePlan(@Req() request: PlatformRequest, @Param('id') id: string) {
    return this.admin.retirePlan(request.platformActor!, requireUuid(id, 'Plan'));
  }

  /* ---- Per-clinic features ------------------------------------------------ */

  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('OPERATOR')
  @Post('tenants/:id/features')
  setFeatures(@Req() request: PlatformRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parseBody(StateChange.extend({ features: FeatureMap }), body);
    return this.admin.setFeatureOverrides(
      request.platformActor!,
      requireUuid(id, 'Clinic'),
      input.features,
      input.reason,
    );
  }

  /* ---- Onboarding and support -------------------------------------------- */

  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('OPERATOR')
  @Post('tenants')
  onboard(@Req() request: PlatformRequest, @Body() body: unknown) {
    return this.support.onboardClinic(request.platformActor!, parseBody(OnboardInput, body));
  }

  /**
   * Rescues a locked-out clinic administrator.
   *
   * PLATFORM_ADMIN only. It is the most sensitive thing in this console — it
   * hands someone a working credential for a clinic — so it sits above the role
   * that does day-to-day operations.
   */
  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('PLATFORM_ADMIN')
  @Post('tenants/:id/reset-admin-password')
  resetClinicAdmin(
    @Req() request: PlatformRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parseBody(
      StateChange.extend({ adminEmail: z.string().email() }),
      body,
    );
    return this.support.resetClinicAdminPassword(
      request.platformActor!,
      requireUuid(id, 'Clinic'),
      input.adminEmail,
      input.reason,
    );
  }

  /* ---- Operators ---------------------------------------------------------- */

  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('PLATFORM_ADMIN')
  @Get('operators')
  async operators() {
    return { items: await this.admin.operators() };
  }

  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('PLATFORM_ADMIN')
  @Post('operators')
  createOperator(@Req() request: PlatformRequest, @Body() body: unknown) {
    return this.admin.createOperator(request.platformActor!, parseBody(OperatorInput, body));
  }

  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('PLATFORM_ADMIN')
  @Post('operators/:id')
  updateOperator(
    @Req() request: PlatformRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parseBody(
      z.object({
        role: z.enum(['SUPPORT', 'OPERATOR', 'PLATFORM_ADMIN']).optional(),
        isActive: z.boolean().optional(),
      }),
      body,
    );
    return this.admin.updateOperator(request.platformActor!, requireUuid(id, 'Operator'), input);
  }

  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('PLATFORM_ADMIN')
  @Post('operators/:id/reset-password')
  resetOperator(@Req() request: PlatformRequest, @Param('id') id: string) {
    return this.admin.resetOperatorPassword(
      request.platformActor!,
      requireUuid(id, 'Operator'),
    );
  }

  /* ---- Deployment settings ------------------------------------------------ */

  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('SUPPORT')
  @Get('settings')
  async settings() {
    return { items: await this.admin.settings() };
  }

  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('PLATFORM_ADMIN')
  @Post('settings')
  saveSetting(@Req() request: PlatformRequest, @Body() body: unknown) {
    const input = parseBody(
      z.object({ key: z.string().min(1), value: z.unknown() }),
      body,
    );
    return this.admin.saveSetting(request.platformActor!, input.key, input.value);
  }

  /* ---- Monitoring ---------------------------------------------------------- */

  @Public()
  @SkipAudit()
  @UseGuards(PlatformGuard)
  @RequirePlatformRole('SUPPORT')
  @Get('health')
  health() {
    return this.support.health();
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
  providers: [
    ...platformDbProviders,
    PlatformService,
    PlatformAdminService,
    PlatformSupportService,
    PlatformGuard,
    UsageAggregator,
    ClinicDirectoryService,
  ],
  /*
   * `ClinicDirectoryService` is exported; the raw platform connection is not.
   *
   * Background work across every tenant needs a clinic list and `emr_app`
   * cannot produce one. Exporting the BYPASSRLS connection itself would spread
   * it through the codebase, so what leaves this module is one method returning
   * one column.
   */
  exports: [UsageAggregator, ClinicDirectoryService],
})
export class PlatformModule {}
