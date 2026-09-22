import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { DatabaseModule } from './database/database.module';
import { CommonModule } from './common/common.module';
import { TenantContextMiddleware } from './common/tenancy/tenant-context.middleware';
import { RbacGuard } from './common/rbac/rbac.guard';
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
import { TasksModule } from './modules/tasks/tasks.module';
import { BillingModule } from './modules/billing/billing.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SettingsModule } from './modules/settings/settings.module';
import { AuditModule } from './modules/audit/audit.module';
import { PortabilityModule } from './modules/portability/portability.module';
import { HealthModule } from './modules/health/health.module';
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
    TasksModule,
    BillingModule,
    ReportsModule,
    SettingsModule,
    AuditModule,
    PortabilityModule,
    HealthModule,
    NavModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: RbacGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}
