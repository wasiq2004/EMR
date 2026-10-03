import {
  Controller,
  Get,
  Injectable,
  Module,
  Query,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { ANALYTICS_EXPORTS, AnalyticsFilters, type ReportSummary } from '@emr/contracts';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { Audit, RequirePermission, SkipAudit } from '../../common/http/decorators';
import { parseBody } from '../../common/http/zod.pipe';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { AnalyticsService } from './analytics.service';
import { RequiresFeature } from '../../common/features/feature.guard';

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

@RequiresFeature('reports')
@Controller('reports')
class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  @RequirePermission('report:read')
  @Get('summary')
  summary(@Query('days') days?: string) {
    return this.reports.summary(days ? Number(days) : 14);
  }

  /* --- Clinic analytics --------------------------------------------------- */

  /**
   * The filtered, grouped view an administrator works from.
   *
   * `report:read` like the dashboard, and aggregate-only for the same reason —
   * no figure it returns can be traced to one patient, which is a property of
   * the queries rather than of this screen choosing not to ask.
   *
   * Exempt from the audit trail: every filter change asks for it, and it reads
   * no clinical content. The same reasoning as the queue and the calendar.
   */
  @RequirePermission('report:read')
  @SkipAudit()
  @Get('analytics')
  analytics(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('practitionerId') practitionerId?: string,
    @Query('locationId') locationId?: string,
    @Query('serviceItemId') serviceItemId?: string,
    @Query('paymentMethod') paymentMethod?: string,
  ) {
    return this.analyticsService.analytics(
      parseAnalyticsQuery({ from, to, practitionerId, locationId, serviceItemId, paymentMethod }),
    );
  }

  /**
   * One view of the same numbers as CSV.
   *
   * Built from the same `analytics()` result, so an export can never disagree
   * with what somebody is looking at on screen. Audited, unlike the read: a file
   * leaving the clinic is a different act from looking at a figure, even when
   * the figures are aggregates.
   */
  @RequirePermission('report:read')
  @Audit('ANALYTICS_EXPORTED', 'clinic')
  @Get('analytics/export')
  async exportAnalytics(
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query('view') view: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('practitionerId') practitionerId?: string,
    @Query('locationId') locationId?: string,
    @Query('serviceItemId') serviceItemId?: string,
    @Query('paymentMethod') paymentMethod?: string,
  ) {
    // Validated against the contract's list, so `exportCsv` never has to guess
    // and an unknown view is a 422 naming the field rather than an empty file.
    const parsedView = parseBody(
      z.enum(ANALYTICS_EXPORTS.map((e) => e.value) as [string, ...string[]]),
      view,
    );
    const filters = parseAnalyticsQuery({
      from,
      to,
      practitionerId,
      locationId,
      serviceItemId,
      paymentMethod,
    });

    const { filename, csv } = await this.analyticsService.exportCsv(parsedView, filters);

    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${filename}"`);
    return csv;
  }
}

/**
 * The query string, validated once for both routes.
 *
 * The range is bounded before any query runs. Utilisation derives slots across
 * it, so an unbounded range is how a report becomes a denial of service — and
 * the cap matches the availability endpoint's, because two limits that disagree
 * are two limits somebody has to discover separately.
 */
function parseAnalyticsQuery(raw: Record<string, string | undefined>): AnalyticsFilters {
  const filters = parseBody(AnalyticsFilters, {
    from: raw.from,
    to: raw.to,
    practitionerId: raw.practitionerId || null,
    locationId: raw.locationId || null,
    serviceItemId: raw.serviceItemId || null,
    paymentMethod: raw.paymentMethod || null,
  });

  if (filters.to <= filters.from) {
    throw new UnprocessableEntityException({
      errors: { to: ['The range has to end after it starts'] },
    });
  }

  const days =
    (Date.parse(`${filters.to}T00:00:00Z`) - Date.parse(`${filters.from}T00:00:00Z`)) /
    86_400_000;
  if (days > AnalyticsService.maxRangeDays) {
    throw new UnprocessableEntityException({
      errors: {
        to: [`Ask for at most ${AnalyticsService.maxRangeDays} days at a time`],
      },
    });
  }

  return filters;
}

@Module({
  /*
   * `SchedulingModule` for `AvailabilityService`: utilisation reuses the slot
   * derivation rather than re-deriving from the pattern, because a second
   * implementation of pattern-minus-exceptions would eventually disagree with
   * the calendar — and a utilisation figure that contradicts the grid it
   * describes is worse than no figure at all.
   */
  imports: [SchedulingModule],
  controllers: [ReportsController],
  providers: [ReportsService, AnalyticsService],
  exports: [ReportsService, AnalyticsService],
})
export class ReportsModule {}
