import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { DatabaseModule } from './database/database.module';
import { CommonModule } from './common/common.module';
import { TenantContextMiddleware } from './common/tenancy/tenant-context.middleware';
import { RbacGuard } from './common/rbac/rbac.guard';
import { FeatureGuard } from './common/features/feature.guard';
import { AuditInterceptor } from './common/audit/audit.interceptor';
import { ProblemDetailsFilter } from './common/http/problem-details.filter';

import { AuthModule } from './modules/auth/auth.module';
import { PatientsModule } from './modules/patients/patients.module';
import { SchedulingModule } from './modules/scheduling/scheduling.module';
import { ClinicalModule } from './modules/clinical/clinical.module';
import { PrescribingModule } from './modules/prescribing/prescribing.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { CommsModule } from './modules/comms/comms.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { EventsModule } from './modules/events/events.module';
import { PlatformModule } from './modules/platform/platform.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { BillingModule } from './modules/billing/billing.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SettingsModule } from './modules/settings/settings.module';
import { AuditModule } from './modules/audit/audit.module';
import { PharmacyModule } from './modules/pharmacy/pharmacy.module';
import { ResearchModule } from './modules/research/research.module';
import { PortabilityModule } from './modules/portability/portability.module';
import { HealthModule } from './modules/health/health.module';
import { RemindersModule } from './modules/reminders/reminders.module';
import { NavModule } from './modules/nav/nav.module';

/**
 * The application.
 *
 * Four things are registered GLOBALLY and never per-controller, so a reviewer
 * can verify enforcement from this one file instead of grepping every route:
 *
 *   - tenant context, before anything touches the database
 *   - the RBAC guard, which denies by default
 *   - the audit interceptor, so coverage does not depend on feature code
 *   - the problem-details filter, so no internal detail ever leaves
 *
 * Opting out requires an explicit decorator, and every use of one is listed in
 * the security review checklist.
 */
@Module({
  imports: [
    DatabaseModule,
    CommonModule,
    AuthModule,
    PatientsModule,
    SchedulingModule,
    ClinicalModule,
    PrescribingModule,
    DocumentsModule,
    CommsModule,
    MessagingModule,
    EventsModule,
    PlatformModule,
    TasksModule,
    BillingModule,
    ReportsModule,
    SettingsModule,
    AuditModule,
    PharmacyModule,
    ResearchModule,
    PortabilityModule,
    HealthModule,
    RemindersModule,
    NavModule,
  ],
  providers: [
    /*
     * `useClass` is correct here: RbacGuard holds no state beyond a logger, and
     * it is not provided anywhere else for `useExisting` to point at. Contrast
     * the feature guard below, which owns a cache.
     */
    { provide: APP_GUARD, useClass: RbacGuard },
    /*
     * AFTER RbacGuard. Someone who is not permitted to broadcast should be told
     * that, not that their plan lacks broadcasting — the second answer tells a
     * receptionist something about the clinic's contract.
     *
     * `useExisting`, NOT `useClass`, and this is not a style choice. `useClass`
     * makes Nest construct a SECOND instance under the APP_GUARD token, so the
     * guard that decides requests and the guard the operations console calls
     * `invalidate()` on are different objects holding different caches. The
     * console would report a feature change saved, the clinic would keep its
     * old features until the TTL lapsed, and the only symptom is a support call
     * saying the upgrade did not work.
     */
    { provide: APP_GUARD, useExisting: FeatureGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}
