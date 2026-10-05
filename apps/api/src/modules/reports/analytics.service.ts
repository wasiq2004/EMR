import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type {
  AnalyticsBreakdown,
  AnalyticsFilters,
  AppointmentAnalytics,
  ClinicAnalytics,
  InvoiceAgeing,
  PatientAnalytics,
  RevenueAnalytics,
} from '@emr/contracts';

import { TenantDb, type TenantTx } from '../../common/tenancy/tenant-db.service';
import { AvailabilityService } from '../scheduling/availability.service';

/**
 * The administrator's view of the practice.
 *
 * THREE DISTINCTIONS THIS MAKES THAT THE DASHBOARD DOES NOT, and each one is a
 * number somebody would otherwise read wrongly:
 *
 *   * COLLECTED is not INVOICED. One is money that arrived, the other money that
 *     was billed. Reporting either alone as "revenue" is how a clinic budgets
 *     against money it has not received, so both are given.
 *   * OUTSTANDING IS NOT RANGE-FILTERED. A debt from March is still a debt in
 *     June; scoping it to the window would make it shrink as the window moved,
 *     which is the opposite of what a dues report is for.
 *   * A NO-SHOW RATE NEEDS A DENOMINATOR THAT HAS CLOSED. Over all appointments
 *     it counts tomorrow's bookings as attended; the rate here is over
 *     appointments that reached a terminal state, and that count is reported
 *     alongside so the reader can see what it is a share of.
 *
 * NOTHING HERE CAN NAME A PATIENT. Every figure is a count or a sum, and the
 * breakdowns group by the clinic's own staff, services and payment methods. That
 * is a property of the queries rather than of the screen choosing not to ask —
 * the same rule `ReportsService` follows for the AUDITOR role.
 */
@Injectable()
export class AnalyticsService {
  /**
   * The longest range a single report may cover.
   *
   * Matches the availability cap, because utilisation derives slots over the
   * range and the two limits should not disagree. A clinic wanting a full year
   * takes four exports, which is a worse experience than one query and a better
   * one than a request that times out.
   */
  private static readonly MAX_RANGE_DAYS = 120;

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly availability: AvailabilityService,
  ) {}

  async analytics(filters: AnalyticsFilters): Promise<ClinicAnalytics> {
    /*
     * One read-only transaction for everything.
     *
     * Not for speed — for consistency. Six separate queries can straddle a
     * payment being recorded, and a report whose revenue and ageing disagree
     * about the same invoice is a report somebody loses faith in.
     */
    const [revenue, patients, appointments, ageing] = await this.tenantDb.runReadOnly(
      async (tx) =>
        Promise.all([
          this.revenue(tx, filters),
          this.patients(tx, filters),
          this.appointments(tx, filters),
          this.ageing(tx),
        ]),
    );

    // Utilisation needs the derived schedules, which is its own set of reads.
    appointments.offeredMinutes = await this.offeredMinutes(filters);
    appointments.utilisationPct =
      appointments.offeredMinutes && appointments.offeredMinutes > 0
        ? Math.min(
            100,
            Math.round((appointments.bookedMinutes / appointments.offeredMinutes) * 100),
          )
        : null;

    return {
      from: filters.from,
      to: filters.to,
      revenue,
      patients,
      appointments,
      ageing,
    };
  }

  /* ---- Money ------------------------------------------------------------- */

  private async revenue(tx: TenantTx, f: AnalyticsFilters): Promise<RevenueAnalytics> {
    const from = startOf(f.from);
    const to = startOf(f.to);

    /*
     * Payments are filtered, where they can be.
     *
     * A payment has a method of its own; it reaches a doctor and a service only
     * through its invoice's encounter. So a `practitionerId` filter restricts to
     * payments whose invoice is linked to that doctor's encounter, and a payment
     * on an invoice with no encounter — a walk-in sale, a correction — drops out
     * of a doctor-filtered report rather than being attributed to everybody.
     * That is the honest answer and it is why `byPractitioner` carries a null-id
     * row for the rest.
     */
    const paymentScope = sql`
      p.received_at >= ${from} AND p.received_at < ${to}
      AND ${f.paymentMethod ? sql`p.method = ${f.paymentMethod}` : sql`true`}
      AND ${
        f.practitionerId || f.serviceItemId || f.locationId
          ? sql`EXISTS (
              SELECT 1 FROM invoice i
              LEFT JOIN encounter e ON e.id = i.encounter_id
              LEFT JOIN appointment a ON a.id = e.appointment_id
              WHERE i.id = p.invoice_id
                AND ${f.practitionerId ? sql`e.practitioner_id = ${f.practitionerId}` : sql`true`}
                AND ${f.locationId ? sql`a.location_id = ${f.locationId}` : sql`true`}
                AND ${
                  f.serviceItemId
                    ? sql`EXISTS (
                        SELECT 1 FROM jsonb_array_elements(i.line_items) AS l
                        WHERE l->>'serviceItemId' = ${f.serviceItemId}
                      )`
                    : sql`true`
                }
            )`
          : sql`true`
      }
    `;

    const [totals] = (
      await tx.execute<{
        collected: string;
        refunded: string;
        invoiced: string;
        outstanding: string;
      }>(sql`
        SELECT
          (SELECT coalesce(sum(p.amount_paise), 0)::bigint
             FROM payment p WHERE ${paymentScope} AND p.is_refund = false) AS collected,
          (SELECT coalesce(sum(-p.amount_paise), 0)::bigint
             FROM payment p WHERE ${paymentScope} AND p.is_refund = true) AS refunded,
          (SELECT coalesce(sum(i.total_paise), 0)::bigint
             FROM invoice i
             WHERE i.created_at >= ${from} AND i.created_at < ${to}
               AND i.status <> 'CANCELLED') AS invoiced,
          -- Deliberately NOT range-filtered. See the class comment.
          (SELECT coalesce(sum(i.total_paise - i.paid_paise), 0)::bigint
             FROM invoice i
             WHERE i.status = 'ISSUED' AND i.total_paise > i.paid_paise) AS outstanding
      `)
    ).rows;

    const byMethod = await tx.execute<{ id: null; label: string; count: number; amount: string }>(sql`
      SELECT NULL::uuid AS id, p.method::text AS label,
             count(*)::int AS count, coalesce(sum(p.amount_paise), 0)::bigint AS amount
      FROM payment p
      WHERE ${paymentScope} AND p.is_refund = false
      GROUP BY p.method
      ORDER BY amount DESC
    `);

    /*
     * Per doctor, from PAYMENTS rather than from `invoice.paid_paise`.
     *
     * The dashboard's own per-doctor figure sums `invoice.paid_paise` over a
     * join to encounter, so its total does not reconcile with the collections
     * figure above it on the same screen — two numbers for the same money. This
     * one comes from the payment rows, which is where money actually is.
     */
    const byPractitioner = await tx.execute<{
      id: string | null; label: string; count: number; amount: string;
    }>(sql`
      SELECT u.id AS id,
             coalesce(u.full_name, 'Not attributed to a doctor') AS label,
             count(p.id)::int AS count,
             coalesce(sum(p.amount_paise), 0)::bigint AS amount
      FROM payment p
      LEFT JOIN invoice i ON i.id = p.invoice_id
      LEFT JOIN encounter e ON e.id = i.encounter_id
      LEFT JOIN app_user u ON u.id = e.practitioner_id
      WHERE ${paymentScope} AND p.is_refund = false
      GROUP BY u.id, u.full_name
      ORDER BY amount DESC
    `);

    /*
     * Per service, from the INVOICE LINES.
     *
     * Lines are what carry a service, and an invoice can hold several — so this
     * sums line amounts, not payments. It therefore measures what was BILLED per
     * service rather than what was collected, which is the only answerable
     * version of the question: a part-payment against a three-line invoice
     * cannot be apportioned between the lines without inventing a rule.
     */
    /*
     * Invoice lines live in a JSONB column, not a table, so they are unnested
     * here. `serviceItemId` is optional on a line — a one-off charge is typed as
     * free text — so those group under their own description rather than being
     * dropped, which would make the breakdown quietly fail to add up to the
     * invoiced total.
     */
    const byService = await tx.execute<{
      id: string | null; label: string; count: number; amount: string;
    }>(sql`
      SELECT (l->>'serviceItemId')::uuid AS id,
             coalesce(s.name, l->>'description', 'Unlisted') AS label,
             count(*)::int AS count,
             coalesce(sum((l->>'amountPaise')::bigint), 0)::bigint AS amount
      FROM invoice i
      CROSS JOIN LATERAL jsonb_array_elements(i.line_items) AS l
      LEFT JOIN service_item s ON s.id = (l->>'serviceItemId')::uuid
      WHERE i.created_at >= ${from} AND i.created_at < ${to}
        AND i.status <> 'CANCELLED'
        AND ${f.serviceItemId ? sql`l->>'serviceItemId' = ${f.serviceItemId}` : sql`true`}
      GROUP BY (l->>'serviceItemId')::uuid, s.name, l->>'description'
      ORDER BY amount DESC
      LIMIT 50
    `);

    const series = await tx.execute<{ date: string; amount: string }>(sql`
      SELECT d::date::text AS date,
             coalesce((
               SELECT sum(p.amount_paise) FROM payment p
               WHERE p.received_at::date = d::date
                 AND p.is_refund = false
                 AND ${f.paymentMethod ? sql`p.method = ${f.paymentMethod}` : sql`true`}
             ), 0)::bigint AS amount
      FROM generate_series(${from}::date, (${to}::date - interval '1 day'), interval '1 day') d
      ORDER BY d
    `);

    return {
      collectedPaise: Number(totals?.collected ?? 0),
      invoicedPaise: Number(totals?.invoiced ?? 0),
      outstandingPaise: Number(totals?.outstanding ?? 0),
      refundedPaise: Number(totals?.refunded ?? 0),
      byMethod: (byMethod.rows ?? []).map(toBreakdown),
      byPractitioner: (byPractitioner.rows ?? []).map(toBreakdown),
      byService: (byService.rows ?? []).map(toBreakdown),
      series: (series.rows ?? []).map((r) => ({
        date: r.date,
        collectedPaise: Number(r.amount),
      })),
    };
  }

  /* ---- Patients ---------------------------------------------------------- */

  private async patients(tx: TenantTx, f: AnalyticsFilters): Promise<PatientAnalytics> {
    const from = startOf(f.from);
    const to = startOf(f.to);

    /*
     * New counts by REGISTRATION; returning is "registered before the range and
     * seen inside it".
     *
     * A patient registered and seen in the same range counts as new only — if
     * both counted them, the two would add up to more than the number of people
     * who came, and somebody would eventually notice and stop trusting the page.
     */
    const [counts] = (
      await tx.execute<{ new_count: number; returning_count: number; seen_count: number }>(sql`
        WITH seen AS (
          SELECT DISTINCT e.patient_id
          FROM encounter e
          LEFT JOIN appointment a ON a.id = e.appointment_id
          WHERE e.started_at >= ${from} AND e.started_at < ${to}
            AND ${f.practitionerId ? sql`e.practitioner_id = ${f.practitionerId}` : sql`true`}
            AND ${f.locationId ? sql`a.location_id = ${f.locationId}` : sql`true`}
        )
        SELECT
          (SELECT count(*)::int FROM patient
            WHERE created_at >= ${from} AND created_at < ${to}) AS new_count,
          (SELECT count(*)::int FROM seen s
            JOIN patient p ON p.id = s.patient_id
            WHERE p.created_at < ${from}) AS returning_count,
          (SELECT count(*)::int FROM seen) AS seen_count
      `)
    ).rows;

    const registrations = await tx.execute<{ date: string; count: number }>(sql`
      SELECT d::date::text AS date,
             (SELECT count(*)::int FROM patient p WHERE p.created_at::date = d::date) AS count
      FROM generate_series(${from}::date, (${to}::date - interval '1 day'), interval '1 day') d
      ORDER BY d
    `);

    return {
      newCount: Number(counts?.new_count ?? 0),
      returningCount: Number(counts?.returning_count ?? 0),
      seenCount: Number(counts?.seen_count ?? 0),
      registrations: (registrations.rows ?? []).map((r) => ({
        date: r.date,
        count: Number(r.count),
      })),
    };
  }

  /* ---- Appointments ------------------------------------------------------ */

  private async appointments(
    tx: TenantTx,
    f: AnalyticsFilters,
  ): Promise<AppointmentAnalytics> {
    const from = startOf(f.from);
    const to = startOf(f.to);

    const [row] = (
      await tx.execute<{
        booked: number; completed: number; no_show: number; cancelled: number;
        walk_in: number; booked_minutes: number;
      }>(sql`
        SELECT
          count(*)::int AS booked,
          count(*) FILTER (WHERE a.status IN ('FULFILLED', 'CHECKED_OUT'))::int AS completed,
          count(*) FILTER (WHERE a.status = 'NOSHOW')::int AS no_show,
          count(*) FILTER (WHERE a.status = 'CANCELLED')::int AS cancelled,
          count(*) FILTER (WHERE a.is_walk_in)::int AS walk_in,
          -- Cancellations and no-shows contribute NO minutes: a doctor is not
          -- busy during an appointment nobody attended, and counting them would
          -- make the worst month of the year read as the busiest.
          coalesce(sum(
            CASE WHEN a.status IN ('CANCELLED', 'NOSHOW') THEN 0
                 ELSE greatest(
                   1,
                   round(extract(epoch FROM (
                     coalesce(a.scheduled_end, a.scheduled_start + interval '15 minutes')
                     - a.scheduled_start
                   )) / 60)
                 )
            END
          ), 0)::int AS booked_minutes
        FROM appointment a
        WHERE a.scheduled_start >= ${from} AND a.scheduled_start < ${to}
          AND ${f.practitionerId ? sql`a.practitioner_id = ${f.practitionerId}` : sql`true`}
          AND ${f.locationId ? sql`a.location_id = ${f.locationId}` : sql`true`}
          /*
           * The service filter applies here now.
           *
           * appointment.service_item_id did not exist when this was written: the
           * booking path used the chosen service to compute the end time and
           * then discarded it, so "appointments for a service" was unanswerable
           * and this filter was deliberately not applied rather than applied
           * wrongly. The column exists now.
           *
           * Appointments booked BEFORE it exists carry null and drop out of a
           * service-filtered count, which is correct. They are genuinely
           * uncategorised, and attributing them to a service would be inventing
           * history to make a chart look complete.
           */
          AND ${f.serviceItemId ? sql`a.service_item_id = ${f.serviceItemId}` : sql`true`}
      `)
    ).rows;

    const completed = Number(row?.completed ?? 0);
    const noShow = Number(row?.no_show ?? 0);
    const cancelled = Number(row?.cancelled ?? 0);
    const closed = completed + noShow + cancelled;

    return {
      bookedCount: Number(row?.booked ?? 0),
      completedCount: completed,
      noShowCount: noShow,
      cancelledCount: cancelled,
      walkInCount: Number(row?.walk_in ?? 0),
      closedCount: closed,
      /*
       * Null, not zero, when nothing has closed.
       *
       * A rate over an empty denominator is unknown. Reporting 0% for a range
       * where every appointment is still in the future would read as a perfect
       * attendance record.
       */
      noShowPct: closed > 0 ? Math.round((noShow / closed) * 100) : null,
      cancellationPct: closed > 0 ? Math.round((cancelled / closed) * 100) : null,
      utilisationPct: null,
      offeredMinutes: null,
      bookedMinutes: Number(row?.booked_minutes ?? 0),
    };
  }

  /**
   * Minutes the clinic actually offered in the range.
   *
   * REUSES THE SLOT DERIVATION rather than re-deriving from the pattern, which
   * is the whole point: pattern minus exceptions minus leave is subtle enough
   * that a second implementation would disagree with the calendar, and a
   * utilisation figure that disagrees with the grid it describes is worse than
   * no figure. The cost is one derivation over at most 120 days, for a report
   * nobody runs in a loop.
   *
   * Returns null when nothing is scheduled, so a clinic that has not entered its
   * working hours is told the number is unknown rather than shown 0%.
   */
  private async offeredMinutes(f: AnalyticsFilters): Promise<number | null> {
    const days = await this.availability.slots({
      from: f.from,
      to: f.to,
      practitionerId: f.practitionerId ?? undefined,
      locationId: f.locationId ?? undefined,
    });

    if (days.length === 0) return null;

    let minutes = 0;
    for (const day of days) {
      for (const slot of day.slots) minutes += slot.minutes * slot.capacity;
    }
    return minutes > 0 ? minutes : null;
  }

  /* ---- Ageing ------------------------------------------------------------ */

  /**
   * Outstanding invoices by age.
   *
   * Aged from `issued_at` rather than `created_at`: an invoice drafted in March
   * and issued in June has been owed since June, and ageing a draft would show a
   * debt nobody has been asked to pay yet.
   *
   * Not range-filtered, for the same reason `outstanding` is not — a dues report
   * that shrinks as the window moves is answering a different question from the
   * one anybody asks it.
   */
  private async ageing(tx: TenantTx): Promise<InvoiceAgeing> {
    const rows = await tx.execute<{ bucket: string; count: number; amount: string }>(sql`
      SELECT
        CASE
          WHEN now() - i.issued_at < interval '8 days'  THEN '0-7 days'
          WHEN now() - i.issued_at < interval '31 days' THEN '8-30 days'
          WHEN now() - i.issued_at < interval '61 days' THEN '31-60 days'
          ELSE 'Over 60 days'
        END AS bucket,
        count(*)::int AS count,
        coalesce(sum(i.total_paise - i.paid_paise), 0)::bigint AS amount
      FROM invoice i
      WHERE i.status = 'ISSUED'
        AND i.total_paise > i.paid_paise
        AND i.issued_at IS NOT NULL
      GROUP BY bucket
    `);

    const [oldest] = (
      await tx.execute<{ days: number | null }>(sql`
        SELECT max(extract(day FROM now() - i.issued_at))::int AS days
        FROM invoice i
        WHERE i.status = 'ISSUED' AND i.total_paise > i.paid_paise AND i.issued_at IS NOT NULL
      `)
    ).rows;

    /*
     * Every bucket is present, including the empty ones.
     *
     * A table that omits "Over 60 days" when nothing is that old looks the same
     * as one where the column was forgotten. Showing a zero says it was checked.
     */
    const ORDER = ['0-7 days', '8-30 days', '31-60 days', 'Over 60 days'];
    const found = new Map(
      (rows.rows ?? []).map((r) => [r.bucket, { count: Number(r.count), amount: Number(r.amount) }]),
    );

    const buckets = ORDER.map((label) => ({
      label,
      count: found.get(label)?.count ?? 0,
      amountPaise: found.get(label)?.amount ?? 0,
    }));

    return {
      buckets,
      totalPaise: buckets.reduce((sum, b) => sum + b.amountPaise, 0),
      oldestDays: oldest?.days === null || oldest?.days === undefined ? null : Number(oldest.days),
    };
  }

  /* ---- Export ------------------------------------------------------------ */

  /**
   * One view as CSV.
   *
   * Built from the same `analytics()` result the screen shows, so an export can
   * never disagree with the figures somebody is looking at — which is the whole
   * reason it is not a second set of queries.
   */
  async exportCsv(view: string, filters: AnalyticsFilters): Promise<{ filename: string; csv: string }> {
    const data = await this.analytics(filters);
    const stamp = `${filters.from}_to_${filters.to}`;

    const breakdown = (rows: AnalyticsBreakdown[], head: string) =>
      toCsv([head, 'Count', 'Amount (INR)'], rows.map((r) => [r.label, r.count, rupees(r.amountPaise)]));

    switch (view) {
      case 'revenue-by-method':
        return { filename: `revenue-by-method_${stamp}.csv`, csv: breakdown(data.revenue.byMethod, 'Method') };
      case 'revenue-by-doctor':
        return { filename: `revenue-by-doctor_${stamp}.csv`, csv: breakdown(data.revenue.byPractitioner, 'Doctor') };
      case 'revenue-by-service':
        return { filename: `revenue-by-service_${stamp}.csv`, csv: breakdown(data.revenue.byService, 'Service') };
      case 'collections-daily':
        return {
          filename: `collections-daily_${stamp}.csv`,
          csv: toCsv(
            ['Date', 'Collected (INR)'],
            data.revenue.series.map((r) => [r.date, rupees(r.collectedPaise)]),
          ),
        };
      case 'registrations-daily':
        return {
          filename: `registrations-daily_${stamp}.csv`,
          csv: toCsv(
            ['Date', 'Registrations'],
            data.patients.registrations.map((r) => [r.date, r.count]),
          ),
        };
      case 'invoice-ageing':
        return {
          filename: `invoice-ageing_${stamp}.csv`,
          csv: toCsv(
            ['Age', 'Invoices', 'Outstanding (INR)'],
            data.ageing.buckets.map((b) => [b.label, b.count, rupees(b.amountPaise)]),
          ),
        };
      default:
        // Unreachable: the controller validates `view` against the contract's
        // list first. Named rather than silently returning an empty file.
        throw new Error(`Unknown export view: ${view}`);
    }
  }

  /** The cap, exposed so the controller can refuse before any query runs. */
  static get maxRangeDays(): number {
    return AnalyticsService.MAX_RANGE_DAYS;
  }
}

/* -------------------------------------------------------------------------- */

function toBreakdown(r: {
  id: string | null;
  label: string;
  count: number;
  amount: string;
}): AnalyticsBreakdown {
  return {
    id: r.id,
    label: r.label,
    count: Number(r.count),
    amountPaise: Number(r.amount),
  };
}

function startOf(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00Z`);
}

/** Paise to rupees, as a string, for a spreadsheet. */
function rupees(paise: number): string {
  return (paise / 100).toFixed(2);
}

/**
 * CSV with the quoting actually done.
 *
 * A service called "Consultation, follow-up" or a doctor with an apostrophe
 * breaks a naive join, and the result opens in Excel with columns shifted — a
 * failure that looks like bad data rather than a bad export. Everything is
 * quoted and internal quotes are doubled, which is what RFC 4180 asks for.
 */
function toCsv(header: string[], rows: (string | number)[][]): string {
  const cell = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
  return [header.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n');
}
