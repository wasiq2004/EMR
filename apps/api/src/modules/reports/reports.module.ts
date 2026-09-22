import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { ReportSummary } from '@emr/contracts';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { RequirePermission } from '../../common/http/decorators';

/**
 * Reports.
 *
 * Deliberately small: visits, collections, appointments and no-shows over a
 * period. Anything that needs a finance team is out of scope.
 *
 * Note for the AUDITOR role: what it receives here is aggregate-only, and that
 * is enforced by this response shape rather than by the UI choosing not to ask.
 * No figure below can be traced to an individual patient.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly tenantDb: TenantDb) {}

  async summary(days = 14): Promise<ReportSummary> {
    return this.tenantDb.runReadOnly(async (tx) => {
      const from = new Date(Date.now() - days * 86_400_000);

      const [totals] = (
        await tx.execute<{
          visits: number; new_patients: number; collections: number;
          outstanding: number; appointments: number; no_shows: number;
        }>(sql`
          SELECT
            (SELECT count(*)::int FROM encounter WHERE started_at >= ${from}) AS visits,
            (SELECT count(*)::int FROM patient WHERE created_at >= ${from}) AS new_patients,
            (SELECT coalesce(sum(amount_paise), 0)::bigint FROM payment WHERE received_at >= ${from}) AS collections,
            (SELECT coalesce(sum(total_paise - paid_paise), 0)::bigint FROM invoice WHERE status = 'ISSUED') AS outstanding,
            (SELECT count(*)::int FROM appointment WHERE scheduled_start >= ${from}) AS appointments,
            (SELECT count(*)::int FROM appointment WHERE scheduled_start >= ${from} AND status = 'NOSHOW') AS no_shows
        `)
      ).rows;

      const series = await tx.execute<{ date: string; visits: number; collections: number }>(sql`
        SELECT d::date::text AS date,
               (SELECT count(*)::int FROM encounter e WHERE e.started_at::date = d::date) AS visits,
               (SELECT coalesce(sum(p.amount_paise), 0)::bigint FROM payment p WHERE p.received_at::date = d::date) AS collections
        FROM generate_series(${from}::date, current_date, interval '1 day') d
        ORDER BY d
      `);

      const byPractitioner = await tx.execute<{
        id: string; name: string; visits: number; collections: number;
      }>(sql`
        SELECT u.id, u.full_name AS name,
               count(e.id)::int AS visits,
               coalesce(sum(inv.paid_paise), 0)::bigint AS collections
        FROM app_user u
        LEFT JOIN encounter e ON e.practitioner_id = u.id AND e.started_at >= ${from}
        LEFT JOIN invoice inv ON inv.encounter_id = e.id
        WHERE u.role = 'DOCTOR' AND u.is_active = true
        GROUP BY u.id, u.full_name
        ORDER BY visits DESC
      `);

      return {
        rangeFrom: from.toISOString(),
        rangeTo: new Date().toISOString(),
        visits: Number(totals?.visits ?? 0),
        newPatients: Number(totals?.new_patients ?? 0),
        collectionsPaise: Number(totals?.collections ?? 0),
        outstandingPaise: Number(totals?.outstanding ?? 0),
        appointmentsBooked: Number(totals?.appointments ?? 0),
        noShows: Number(totals?.no_shows ?? 0),
        series: (series.rows ?? []).map((r) => ({
          date: r.date,
          visits: Number(r.visits),
          collectionsPaise: Number(r.collections),
        })),
        byPractitioner: (byPractitioner.rows ?? []).map((r) => ({
          practitionerId: r.id,
          practitionerName: r.name,
          visits: Number(r.visits),
          collectionsPaise: Number(r.collections),
        })),
      };
    });
  }
}

@Controller('reports')
class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @RequirePermission('report:read')
  @Get('summary')
  summary(@Query('days') days?: string) {
    return this.reports.summary(days ? Number(days) : 14);
  }
}

@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
