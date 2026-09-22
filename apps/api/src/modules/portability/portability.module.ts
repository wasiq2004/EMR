import { Controller, Get, Injectable, Module, Post } from '@nestjs/common';
import { desc } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { Audit, RequirePermission } from '../../common/http/decorators';

/**
 * Import and export.
 *
 * Two rules govern both, and they come from the same observation: a
 * half-imported patient registry is worse than no import, because staff cannot
 * tell which records to trust.
 *
 *   - Nothing commits until the whole batch validates.
 *   - No row is dropped silently. Every rejection produces a row-level reason
 *     in a file the clinic can correct and re-upload, and that file keeps the
 *     original row so they edit their own data rather than ours.
 *
 * Export is self-service and complete: no ticket, no developer, no delay. A
 * clinic that knows it can leave is considerably more willing to arrive. Every
 * export writes an audit row, because a full clinical export is precisely the
 * action a departing employee would take.
 */
@Injectable()
export class PortabilityService {
  constructor(private readonly tenantDb: TenantDb) {}

  async importJobs() {
    return this.tenantDb.runReadOnly((tx) =>
      tx.select().from(schema.importJob).orderBy(desc(schema.importJob.createdAt)).limit(50),
    );
  }

  async exportJobs() {
    return this.tenantDb.runReadOnly((tx) =>
      tx.select().from(schema.exportJob).orderBy(desc(schema.exportJob.createdAt)).limit(50),
    );
  }

  /** Records the request. A background worker builds the bundle. */
  async requestExport() {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const [job] = await tx
        .insert(schema.exportJob)
        .values({
          clinicId: ctx.clinicId,
          exportType: 'FULL_CLINIC',
          status: 'PENDING',
          // The bundle self-destructs: patient data must not accumulate in
          // storage indefinitely.
          downloadExpiresAt: new Date(Date.now() + 7 * 86_400_000),
          requestedBy: ctx.userId,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();
      return job!;
    });
  }
}

@Controller()
class PortabilityController {
  constructor(private readonly portability: PortabilityService) {}

  @RequirePermission('import:read')
  @Get('imports')
  async imports() {
    return { items: await this.portability.importJobs() };
  }

  @RequirePermission('export:read')
  @Get('exports')
  async exports() {
    return { items: await this.portability.exportJobs() };
  }

  @RequirePermission('export:create')
  @Audit('EXPORT_REQUESTED', 'export')
  @Post('exports')
  request() {
    return this.portability.requestExport();
  }
}

@Module({
  controllers: [PortabilityController],
  providers: [PortabilityService],
  exports: [PortabilityService],
})
export class PortabilityModule {}
