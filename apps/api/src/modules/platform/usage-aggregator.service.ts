import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';

import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { PlatformDbService } from './platform-db.service';

/**
 * Turns a day of clinical activity into a row of integers.
 *
 * THIS IS THE ONLY BRIDGE between the clinical plane and the platform plane,
 * and it is deliberately one-way and lossy. It runs as the APPLICATION role,
 * inside each clinic's own tenant context, so the aggregation is subject to the
 * same row-level security as every other read. What crosses the boundary is a
 * count.
 *
 * The console cannot do this itself: `emr_platform` has no privilege on
 * `encounter` or `patient`, so there is no query it could run to derive these
 * numbers. That is the point — the console consumes what this writes and has no
 * way to go and look for itself.
 *
 * Yesterday, not today. A partial day would show a clinic apparently collapsing
 * every morning, and the console's whole job is spotting a clinic that has
 * actually stopped.
 */
@Injectable()
export class UsageAggregator {
  private readonly logger = new Logger(UsageAggregator.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly platform: PlatformDbService,
  ) {}

  /**
   * Computes and stores one clinic's usage for a day.
   *
   * Idempotent: re-running it for the same day overwrites rather than
   * duplicating, so a failed run can simply be run again.
   */
  async aggregate(clinicId: string, day: string): Promise<void> {
    await this.tenantDb.runAs(clinicId, null, async (tx) => {
      /*
       * One statement, not eight round trips.
       *
       * Each scalar subquery is scoped by the tenant policy already in force on
       * this transaction — none of them carries a clinic_id predicate, because
       * writing one would suggest the isolation came from the query rather than
       * from the database.
       */
      await tx.execute(sql`
        INSERT INTO clinic_usage_daily (
          clinic_id, day,
          active_users, patients_registered, patients_total,
          appointments, encounters, prescriptions,
          messages_sent, messages_failed, documents_uploaded, storage_bytes
        )
        SELECT
          ${clinicId}::uuid,
          ${day}::date,
          (SELECT count(DISTINCT actor_user_id) FROM audit_event
             WHERE created_at::date = ${day}::date AND actor_user_id IS NOT NULL),
          (SELECT count(*) FROM patient WHERE created_at::date = ${day}::date),
          (SELECT count(*) FROM patient WHERE merged_into_patient_id IS NULL),
          (SELECT count(*) FROM appointment WHERE created_at::date = ${day}::date),
          (SELECT count(*) FROM encounter WHERE started_at::date = ${day}::date),
          (SELECT count(*) FROM medication_request WHERE created_at::date = ${day}::date),
          (SELECT count(*) FROM communication
             WHERE created_at::date = ${day}::date AND direction = 'OUTBOUND' AND status <> 'FAILED'),
          (SELECT count(*) FROM communication
             WHERE created_at::date = ${day}::date AND status = 'FAILED'),
          (SELECT count(*) FROM document_reference WHERE created_at::date = ${day}::date),
          (SELECT coalesce(sum(size_bytes), 0) FROM document_reference)
        ON CONFLICT (clinic_id, day) DO UPDATE SET
          active_users        = EXCLUDED.active_users,
          patients_registered = EXCLUDED.patients_registered,
          patients_total      = EXCLUDED.patients_total,
          appointments        = EXCLUDED.appointments,
          encounters          = EXCLUDED.encounters,
          prescriptions       = EXCLUDED.prescriptions,
          messages_sent       = EXCLUDED.messages_sent,
          messages_failed     = EXCLUDED.messages_failed,
          documents_uploaded  = EXCLUDED.documents_uploaded,
          storage_bytes       = EXCLUDED.storage_bytes,
          updated_at          = now()
      `);
    });
  }

  /**
   * Every clinic, for one day.
   *
   * One clinic failing does not stop the rest. A console that silently stops
   * updating for everyone because one tenant has a bad row is worse than one
   * with a visible gap for that tenant.
   */
  async aggregateAll(day = yesterday()): Promise<{ clinics: number; failed: number }> {
    /*
     * The clinic list comes from the PLATFORM connection, the counting from the
     * application one.
     *
     * Each role does only what it is for: `emr_platform` may read `clinic` and
     * nothing clinical, `emr_app` may count clinical rows inside one tenant and
     * cannot see the list of tenants. Neither could do this alone, which is the
     * shape the boundary is supposed to have.
     */
    const clinics = await this.platform.db
      .select({ id: schema.clinic.id, name: schema.clinic.name })
      .from(schema.clinic)
      .where(sql`${schema.clinic.isActive} AND ${schema.clinic.slug} <> '__system__'`);

    let failed = 0;
    for (const clinic of clinics) {
      try {
        await this.aggregate(clinic.id, day);
      } catch (error) {
        failed += 1;
        this.logger.error(`Usage aggregation failed for ${clinic.name}: ${String(error)}`);
      }
    }

    this.logger.log(`Usage aggregated for ${clinics.length - failed}/${clinics.length} clinics (${day})`);
    return { clinics: clinics.length, failed };
  }
}

function yesterday(): string {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return date.toISOString().slice(0, 10);
}
