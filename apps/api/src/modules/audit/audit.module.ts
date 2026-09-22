import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import { ELEVATED_VISIBILITY_PERMISSIONS, type AuditEvent } from '@emr/contracts';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { RequirePermission } from '../../common/http/decorators';

/**
 * The activity log.
 *
 * Who did what, to which record, and whether it succeeded — never what was
 * recorded. Free-text clinical values are hashed rather than copied into this
 * table, so the log does not become a second, uncontrolled copy of the clinical
 * record with different retention rules.
 *
 * Administrator access to a record they did not author is marked distinctly.
 * That is a transparency measure rather than a restriction: a practice can show
 * its clinicians exactly when management viewed a record, which is what makes
 * that access acceptable to them.
 */
@Injectable()
export class AuditService {
  constructor(private readonly tenantDb: TenantDb) {}

  async list(filter: {
    actorUserId?: string;
    action?: string;
    patientId?: string;
    outcome?: string;
    from?: string;
    to?: string;
    q?: string;
  }): Promise<AuditEvent[]> {
    const rows = await this.tenantDb.runReadOnly((tx) => {
      const conditions = [];
      if (filter.actorUserId) conditions.push(eq(schema.auditEvent.actorUserId, filter.actorUserId));
      if (filter.action) conditions.push(eq(schema.auditEvent.action, filter.action));
      if (filter.patientId) conditions.push(eq(schema.auditEvent.patientId, filter.patientId));
      if (filter.outcome) conditions.push(eq(schema.auditEvent.outcome, filter.outcome as 'SUCCESS'));
      if (filter.from) conditions.push(gte(schema.auditEvent.occurredAt, new Date(filter.from)));
      if (filter.to) conditions.push(lte(schema.auditEvent.occurredAt, new Date(filter.to)));
      if (filter.q) {
        conditions.push(
          sql`(${schema.auditEvent.actorName} ILIKE ${'%' + filter.q + '%'}
               OR ${schema.auditEvent.action} ILIKE ${'%' + filter.q + '%'})`,
        );
      }

      return tx
        .select()
        .from(schema.auditEvent)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(schema.auditEvent.occurredAt))
        .limit(500);
    });

    const elevated = new Set(
      [...ELEVATED_VISIBILITY_PERMISSIONS].map((p) =>
        p.replace(':', '_').replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase(),
      ),
    );

    return rows.map((row) => ({
      ...row,
      occurredAt: row.occurredAt.toISOString(),
      isElevatedVisibility:
        row.actorRole === 'OWNER_ADMIN' && elevated.has(row.action),
    })) as unknown as AuditEvent[];
  }
}

@Controller('audit-events')
class AuditController {
  constructor(private readonly audit: AuditService) {}

  @RequirePermission('auditEvent:read')
  @Get()
  async list(
    @Query('actorUserId') actorUserId?: string,
    @Query('action') action?: string,
    @Query('patientId') patientId?: string,
    @Query('outcome') outcome?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('q') q?: string,
  ) {
    return {
      items: await this.audit.list({ actorUserId, action, patientId, outcome, from, to, q }),
    };
  }
}

@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
