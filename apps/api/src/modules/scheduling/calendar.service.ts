import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, lt } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import type {
  AppointmentStatus,
  Calendar,
  CalendarColumn,
  CalendarDay,
  CalendarEntry,
  DayAnalytics,
} from '@emr/contracts';

import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { AvailabilityService, localDateIn } from './availability.service';

/**
 * The calendar: what is booked, what is free, and what the day adds up to.
 *
 * WHY THIS IS ONE ENDPOINT and not the client joining `/appointments` to
 * `/availability/slots`. Because the analytics strip has to agree with the grid
 * beneath it. Filter the calendar to one doctor and the strip must count that
 * doctor's day — not the clinic's, and not a stale copy of either. Two round
 * trips reconciled on the client are two chances to disagree, and the number
 * that disagrees is the one somebody reads out in a meeting.
 *
 * WHAT IS DERIVED AND WHAT IS STORED. Appointments are rows. Slots are not —
 * they are recomputed from the pattern on every read (see `AvailabilityService`).
 * So the calendar is one query for appointments, one derivation for slots, and a
 * fold that puts them in the same shape.
 *
 * THE DAY BOUNDARY IS THE CLINIC'S, NOT UTC'S. An appointment at 19:00 UTC is
 * half past midnight the next morning in Kolkata. Grouping by the UTC date puts
 * every evening appointment in India on the wrong day — which is not a rounding
 * error, it is a receptionist looking at tomorrow's list for a patient standing
 * in front of them.
 */
@Injectable()
export class CalendarService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly availability: AvailabilityService,
  ) {}

  async calendar(options: {
    from: string;
    to: string;
    practitionerId?: string;
    locationId?: string;
    statuses?: AppointmentStatus[];
    /** `true` walk-ins only, `false` booked only, undefined both. */
    walkInsOnly?: boolean;
    /**
     * Whether to derive slots.
     *
     * The month view draws thirty cells containing counts. Deriving slots for it
     * would build five doctors × thirty days × forty slots — six thousand
     * objects — to render numbers that do not use them.
     */
    includeSlots: boolean;
  }): Promise<Calendar> {
    const timezone = await this.availability.timezone();
    const dates = eachLocalDate(options.from, options.to);

    const entriesByDate = await this.entries(options, timezone);
    const columnsByDate = options.includeSlots
      ? await this.columns(options)
      : new Map<string, CalendarColumn[]>();

    const days: CalendarDay[] = dates.map((date) => {
      const entries = entriesByDate.get(date) ?? [];
      const columns = columnsByDate.get(date) ?? [];
      return {
        date,
        columns,
        entries,
        analytics: analyse(entries, options.includeSlots ? columns : null),
      };
    });

    return { from: options.from, to: options.to, days };
  }

  /* ---- Appointments ------------------------------------------------------- */

  /**
   * The booked rows, filtered and grouped by clinic-local date.
   *
   * The window is widened by a day at each end before querying. An appointment
   * at 23:30 local on the last requested date is 18:00 UTC that day — inside the
   * range — but one at 00:30 local on the FIRST date is 19:00 UTC the evening
   * before, and a query bounded by the plain UTC dates would miss it. Widening
   * and then filtering on the local date is cheaper and more obviously correct
   * than doing the offset arithmetic in SQL.
   */
  private async entries(
    options: {
      from: string;
      to: string;
      practitionerId?: string;
      locationId?: string;
      statuses?: AppointmentStatus[];
      walkInsOnly?: boolean;
    },
    timezone: string,
  ): Promise<Map<string, CalendarEntry[]>> {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({
          appointment: schema.appointment,
          patientName: schema.patient.fullName,
          patientMrn: schema.patient.mrn,
          patientMobile: schema.patient.mobileE164,
          practitionerName: schema.appUser.fullName,
        })
        .from(schema.appointment)
        .innerJoin(schema.patient, eq(schema.patient.id, schema.appointment.patientId))
        .leftJoin(schema.appUser, eq(schema.appUser.id, schema.appointment.practitionerId))
        .where(
          and(
            gte(schema.appointment.scheduledStart, dayBefore(options.from)),
            lt(schema.appointment.scheduledStart, dayAfter(options.to)),
            options.practitionerId
              ? eq(schema.appointment.practitionerId, options.practitionerId)
              : undefined,
            options.locationId
              ? eq(schema.appointment.locationId, options.locationId)
              : undefined,
            options.statuses?.length
              ? inArray(schema.appointment.status, options.statuses)
              : undefined,
            options.walkInsOnly === undefined
              ? undefined
              : eq(schema.appointment.isWalkIn, options.walkInsOnly),
          ),
        )
        .orderBy(asc(schema.appointment.scheduledStart)),
    );

    const byDate = new Map<string, CalendarEntry[]>();

    for (const row of rows) {
      const date = localDateIn(row.appointment.scheduledStart, timezone);
      if (date < options.from || date >= options.to) continue;

      /*
       * A null `scheduledEnd` is filled in rather than passed through.
       *
       * The calendar draws a block, and a block needs a height. Fifteen minutes
       * is the product's default slot and the commonest outpatient consultation
       * in India — and an appointment drawn too short overlaps nothing, which is
       * the safer error for a grid whose whole job is showing conflicts.
       */
      const start = row.appointment.scheduledStart;
      const end =
        row.appointment.scheduledEnd ?? new Date(start.getTime() + 15 * 60_000);
      const minutes = Math.max(1, Math.round((end.getTime() - start.getTime()) / 60_000));

      const entry: CalendarEntry = {
        id: row.appointment.id,
        patientId: row.appointment.patientId,
        patientName: row.patientName,
        patientMrn: row.patientMrn,
        patientMobile: row.patientMobile,
        practitionerId: row.appointment.practitionerId,
        practitionerName: row.practitionerName ?? null,
        locationId: row.appointment.locationId,
        status: row.appointment.status,
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
        minutes,
        isWalkIn: row.appointment.isWalkIn,
        reasonText: row.appointment.reasonText,
        version: row.appointment.version,
      };

      const bucket = byDate.get(date);
      if (bucket) bucket.push(entry);
      else byDate.set(date, [entry]);
    }

    return byDate;
  }

  /* ---- Columns ------------------------------------------------------------ */

  /**
   * One column per doctor per day, from the derived slots.
   *
   * MERGED, because `slots()` returns one `DaySchedule` per SESSION and a doctor
   * who works mornings and evenings has two sessions on that weekday. Rendering
   * them as two columns would show the same doctor twice with half a day each,
   * which is not what the clinic said when it entered two sessions — it said one
   * doctor, two sittings.
   */
  private async columns(options: {
    from: string;
    to: string;
    practitionerId?: string;
    locationId?: string;
  }): Promise<Map<string, CalendarColumn[]>> {
    const schedules = await this.availability.slots({
      from: options.from,
      to: options.to,
      practitionerId: options.practitionerId,
      locationId: options.locationId,
    });

    const byDate = new Map<string, Map<string, CalendarColumn>>();

    for (const day of schedules) {
      let columns = byDate.get(day.date);
      if (!columns) byDate.set(day.date, (columns = new Map()));

      const existing = columns.get(day.practitionerId);
      if (!existing) {
        columns.set(day.practitionerId, {
          practitionerId: day.practitionerId,
          practitionerName: day.practitionerName,
          closedReason: day.closedReason,
          slots: [...day.slots],
        });
        continue;
      }

      existing.slots.push(...day.slots);
      /*
       * A closure applies to the date, not to one session, so a doctor with an
       * afternoon session is still closed if the morning one says so. Keeping
       * the reason means an empty column can still explain itself; dropping it
       * the moment a second session merges in would leave the column blank with
       * no account of why.
       */
      existing.closedReason ??= day.closedReason;
    }

    return new Map(
      [...byDate].map(([date, columns]) => [
        date,
        [...columns.values()]
          .map((column) => ({
            ...column,
            slots: column.slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
          }))
          .sort((a, b) => a.practitionerName.localeCompare(b.practitionerName)),
      ]),
    );
  }
}

/* -------------------------------------------------------------------------- */

/**
 * The day's numbers, counted over the rows that produced the grid.
 *
 * `columns` is null when slots were not derived, and then the two slot-dependent
 * figures are null rather than zero. Zero would read as "no free slots" — a full
 * day — when the truth is "not asked for", and a month cell claiming every day
 * is fully booked is worse than one claiming nothing.
 */
function analyse(entries: CalendarEntry[], columns: CalendarColumn[] | null): DayAnalytics {
  const count = (...statuses: AppointmentStatus[]) =>
    entries.filter((e) => statuses.includes(e.status)).length;

  const analytics: DayAnalytics = {
    booked: count('SCHEDULED', 'CONFIRMED'),
    arrived: count('ARRIVED'),
    inConsultation: count('IN_PROGRESS'),
    completed: count('FULFILLED'),
    checkedOut: count('CHECKED_OUT'),
    noShow: count('NOSHOW'),
    cancelled: count('CANCELLED'),
    walkIns: entries.filter((e) => e.isWalkIn).length,
    freeSlots: null,
    utilisationPct: null,
  };

  if (!columns) return analytics;

  analytics.freeSlots = columns.reduce(
    (sum, column) => sum + column.slots.filter((s) => s.isAvailable).length,
    0,
  );

  /*
   * Utilisation is minutes of LIVE appointments over minutes offered.
   *
   * Cancellations and no-shows are excluded. A doctor is not busy during an
   * appointment nobody attended, and counting them would make the worst day of
   * the month — six no-shows — read as the busiest. The number exists so a
   * clinic can see whether it is actually full.
   */
  const offered = columns.reduce(
    (sum, column) => sum + column.slots.reduce((m, s) => m + s.minutes, 0),
    0,
  );
  if (offered === 0) {
    analytics.utilisationPct = null;
    return analytics;
  }

  const used = entries
    .filter((e) => e.status !== 'CANCELLED' && e.status !== 'NOSHOW')
    .reduce((sum, e) => sum + e.minutes, 0);

  // Capped at 100: overbooking a session past its own length is real, and a
  // utilisation of 140% in a summary strip reads as a bug rather than as news.
  analytics.utilisationPct = Math.min(100, Math.round((used / offered) * 100));
  return analytics;
}

/** Every date from `from` inclusive to `to` exclusive. Bounded by the controller. */
function eachLocalDate(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor < end && dates.length < 120) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** One day either side of the requested window — see `entries`. */
function dayBefore(isoDate: string): Date {
  return new Date(new Date(`${isoDate}T00:00:00Z`).getTime() - 86_400_000);
}
function dayAfter(isoDate: string): Date {
  return new Date(new Date(`${isoDate}T00:00:00Z`).getTime() + 86_400_000);
}
