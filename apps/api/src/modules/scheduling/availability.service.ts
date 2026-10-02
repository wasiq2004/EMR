import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gte, lt, or, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import type { DaySchedule, SaveSchedule, SaveScheduleException, Slot } from '@emr/contracts';

import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';

/**
 * When a doctor is bookable.
 *
 * SLOTS ARE DERIVED, NEVER STORED. The pattern says Monday nine to one in
 * fifteens; the exceptions say not this Monday; the appointments say 09:30 is
 * taken. A free slot is what survives all three, computed on read.
 *
 * The alternative — generating slot rows ahead — fills the database with records
 * whose only purpose is to be absent, and makes changing a doctor's Thursday an
 * unbounded retroactive update. The cost of deriving is a handful of rows per
 * doctor per day; a week for three doctors is still under a hundred.
 *
 * ALL ARITHMETIC IS IN THE CLINIC'S OWN TIMEZONE. A session is "nine in the
 * morning" where the clinic is, not an instant. Doing it in UTC and converting at
 * the edges is how a 9am session becomes 8:30 for half the year in a country that
 * does not observe daylight saving — Asia/Kolkata is UTC+5:30 and the half hour
 * is exactly the kind of offset that looks like a rounding bug.
 */
@Injectable()
export class AvailabilityService {
  constructor(private readonly tenantDb: TenantDb) {}

  /* ---- The pattern -------------------------------------------------------- */

  async schedulesFor(practitionerId?: string) {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({
          schedule: schema.practitionerSchedule,
          practitionerName: schema.appUser.fullName,
          locationName: schema.clinicLocation.name,
        })
        .from(schema.practitionerSchedule)
        .innerJoin(
          schema.appUser,
          eq(schema.appUser.id, schema.practitionerSchedule.practitionerId),
        )
        .leftJoin(
          schema.clinicLocation,
          eq(schema.clinicLocation.id, schema.practitionerSchedule.locationId),
        )
        .where(
          practitionerId
            ? eq(schema.practitionerSchedule.practitionerId, practitionerId)
            : undefined,
        )
        .orderBy(
          asc(schema.appUser.fullName),
          asc(schema.practitionerSchedule.weekday),
          asc(schema.practitionerSchedule.startsAt),
        ),
    );

    return rows.map(({ schedule, practitionerName, locationName }) => ({
      ...schedule,
      practitionerName,
      locationName,
    }));
  }

  /**
   * Saves one recurring session.
   *
   * REFUSES AN OVERLAP with another session for the same doctor on the same
   * weekday. Two overlapping patterns produce duplicate slots at the overlap, and
   * a patient can then be booked into both — which reads at the counter as the
   * software double-booking on its own.
   */
  async saveSchedule(input: SaveSchedule & { id?: string }) {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const siblings = await tx
        .select()
        .from(schema.practitionerSchedule)
        .where(
          and(
            eq(schema.practitionerSchedule.practitionerId, input.practitionerId),
            eq(schema.practitionerSchedule.weekday, input.weekday),
            eq(schema.practitionerSchedule.isActive, true),
          ),
        );

      const clash = siblings.find(
        (row) =>
          row.id !== input.id &&
          // Half-open comparison: a session ending at 13:00 does not overlap one
          // starting at 13:00, which is how clinics actually describe a break.
          input.startsAt < row.endsAt &&
          row.startsAt < input.endsAt,
      );

      if (clash) {
        throw new ConflictException(
          `That overlaps an existing session on the same day (${clash.startsAt.slice(0, 5)}–${clash.endsAt.slice(0, 5)}). ` +
            'A morning and an evening clinic are two sessions; extend one or move the other.',
        );
      }

      const values = {
        practitionerId: input.practitionerId,
        locationId: input.locationId ?? null,
        weekday: input.weekday,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        slotMinutes: input.slotMinutes,
        capacityPerSlot: input.capacityPerSlot,
        effectiveFrom: input.effectiveFrom ?? null,
        effectiveTo: input.effectiveTo ?? null,
        isActive: input.isActive,
        updatedBy: ctx.userId,
      };

      if (input.id) {
        const [updated] = await tx
          .update(schema.practitionerSchedule)
          .set(values)
          .where(eq(schema.practitionerSchedule.id, input.id))
          .returning();
        if (!updated) throw new NotFoundException('That session could not be found.');
        return updated;
      }

      const [created] = await tx
        .insert(schema.practitionerSchedule)
        .values({ ...values, clinicId: ctx.clinicId, createdBy: ctx.userId })
        .returning();
      return created!;
    });
  }

  async deleteSchedule(id: string) {
    const ctx = TenantContext.require();
    return this.tenantDb.run(async (tx) => {
      /*
       * Deactivated, not deleted. Appointments already booked under this pattern
       * keep their meaning, and a clinic that removes a Thursday session should
       * still be able to see that Thursdays used to exist.
       */
      const [updated] = await tx
        .update(schema.practitionerSchedule)
        .set({ isActive: false, updatedBy: ctx.userId })
        .where(eq(schema.practitionerSchedule.id, id))
        .returning({ id: schema.practitionerSchedule.id });
      if (!updated) throw new NotFoundException('That session could not be found.');
      return { removed: true };
    });
  }

  /* ---- Exceptions --------------------------------------------------------- */

  async exceptions(from: string, to: string) {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({
          exception: schema.scheduleException,
          practitionerName: schema.appUser.fullName,
        })
        .from(schema.scheduleException)
        .leftJoin(
          schema.appUser,
          eq(schema.appUser.id, schema.scheduleException.practitionerId),
        )
        .where(
          and(
            gte(schema.scheduleException.onDate, from),
            lt(schema.scheduleException.onDate, to),
          ),
        )
        .orderBy(asc(schema.scheduleException.onDate)),
    );

    return rows.map(({ exception, practitionerName }) => ({
      ...exception,
      practitionerName,
    }));
  }

  async saveException(input: SaveScheduleException & { id?: string }) {
    const ctx = TenantContext.require();

    const values = {
      practitionerId: input.practitionerId ?? null,
      onDate: input.onDate,
      isAvailable: input.isAvailable,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      slotMinutes: input.slotMinutes ?? null,
      reason: input.reason.trim(),
      updatedBy: ctx.userId,
    };

    return this.tenantDb.run(async (tx) => {
      if (input.id) {
        const [updated] = await tx
          .update(schema.scheduleException)
          .set(values)
          .where(eq(schema.scheduleException.id, input.id))
          .returning();
        if (!updated) throw new NotFoundException('That entry could not be found.');
        return updated;
      }

      const [created] = await tx
        .insert(schema.scheduleException)
        .values({ ...values, clinicId: ctx.clinicId, createdBy: ctx.userId })
        .returning()
        .catch((error: Error) => {
          if (/schedule_exception_uq/.test(error.message)) {
            throw new ConflictException(
              'There is already an entry for that doctor on that date. Edit it rather than adding a second — two entries for one day cannot both be true.',
            );
          }
          throw error;
        });
      return created!;
    });
  }

  async deleteException(id: string) {
    return this.tenantDb.run(async (tx) => {
      const deleted = await tx
        .delete(schema.scheduleException)
        .where(eq(schema.scheduleException.id, id))
        .returning({ id: schema.scheduleException.id });
      if (deleted.length === 0) throw new NotFoundException('That entry could not be found.');
      /*
       * Genuinely deleted, unlike a session. An exception is a statement about one
       * date that has either been made or not; a "cancelled day off" that lingers
       * as an inactive row would be a day nobody can tell the status of.
       */
      return { removed: true };
    });
  }

  /* ---- Derivation --------------------------------------------------------- */

  /**
   * Bookable slots for a date range.
   *
   * The whole of Stage A in one method. Reads the pattern, the exceptions and the
   * booked appointments once each, then folds them per day — rather than querying
   * per day, which turns a month view into ninety round trips.
   */
  async slots(options: {
    from: string;
    to: string;
    practitionerId?: string;
    locationId?: string;
  }): Promise<DaySchedule[]> {
    const { timezone } = await this.clinicSettings();

    return this.tenantDb.runReadOnly(async (tx) => {
      const patterns = await tx
        .select({
          schedule: schema.practitionerSchedule,
          practitionerName: schema.appUser.fullName,
        })
        .from(schema.practitionerSchedule)
        .innerJoin(
          schema.appUser,
          eq(schema.appUser.id, schema.practitionerSchedule.practitionerId),
        )
        .where(
          and(
            eq(schema.practitionerSchedule.isActive, true),
            eq(schema.appUser.isActive, true),
            options.practitionerId
              ? eq(schema.practitionerSchedule.practitionerId, options.practitionerId)
              : undefined,
            options.locationId
              ? or(
                  eq(schema.practitionerSchedule.locationId, options.locationId),
                  sql`${schema.practitionerSchedule.locationId} IS NULL`,
                )
              : undefined,
          ),
        );

      if (patterns.length === 0) return [];

      const exceptions = await tx
        .select()
        .from(schema.scheduleException)
        .where(
          and(
            gte(schema.scheduleException.onDate, options.from),
            lt(schema.scheduleException.onDate, options.to),
          ),
        );

      /*
       * Booked appointments in the window.
       *
       * Cancellations and no-shows DO NOT hold a slot — the point of marking a
       * no-show is that the time became available again, and a clinic that cannot
       * rebook it loses the half hour twice.
       */
      const booked = await tx
        .select({
          practitionerId: schema.appointment.practitionerId,
          scheduledStart: schema.appointment.scheduledStart,
          scheduledEnd: schema.appointment.scheduledEnd,
        })
        .from(schema.appointment)
        .where(
          and(
            gte(schema.appointment.scheduledStart, new Date(`${options.from}T00:00:00Z`)),
            lt(schema.appointment.scheduledStart, new Date(`${options.to}T00:00:00Z`)),
            sql`${schema.appointment.status} NOT IN ('CANCELLED', 'NOSHOW')`,
          ),
        );

      const days: DaySchedule[] = [];

      for (const date of eachDate(options.from, options.to)) {
        const weekday = weekdayOf(date);

        for (const { schedule, practitionerName } of patterns) {
          if (schedule.weekday !== weekday) continue;
          if (schedule.effectiveFrom && date < schedule.effectiveFrom) continue;
          if (schedule.effectiveTo && date > schedule.effectiveTo) continue;

          /*
           * The most specific exception wins: one for this doctor beats a
           * clinic-wide one. A clinic closed for a holiday where one doctor has
           * agreed to come in is a real arrangement, and the doctor's own entry
           * is the later, more deliberate statement.
           */
          const mine = exceptions.find(
            (e) => e.onDate === date && e.practitionerId === schedule.practitionerId,
          );
          const clinicWide = exceptions.find(
            (e) => e.onDate === date && e.practitionerId === null,
          );
          const exception = mine ?? clinicWide;

          if (exception && !exception.isAvailable) {
            days.push({
              date,
              practitionerId: schedule.practitionerId,
              practitionerName,
              slots: [],
              closedReason: exception.reason,
            });
            continue;
          }

          const startsAt = exception?.startsAt ?? schedule.startsAt;
          const endsAt = exception?.endsAt ?? schedule.endsAt;
          const slotMinutes = exception?.slotMinutes ?? schedule.slotMinutes;

          const taken = booked.filter((b) => b.practitionerId === schedule.practitionerId);

          const slots: Slot[] = [];
          for (const [start, end] of divide(date, startsAt, endsAt, slotMinutes, timezone)) {
            /*
             * `scheduledEnd` is nullable, and treating null as "no overlap" would
             * leave the slot bookable on top of a real appointment. An appointment
             * with no stated end occupies one slot of this session — the shortest
             * defensible assumption, and the one that errs toward not
             * double-booking.
             */
            const overlapping = taken.filter((b) => {
              const bookedEnd =
                b.scheduledEnd ?? new Date(b.scheduledStart.getTime() + slotMinutes * 60_000);
              return b.scheduledStart < end && start < bookedEnd;
            }).length;

            slots.push({
              startsAt: start.toISOString(),
              endsAt: end.toISOString(),
              practitionerId: schedule.practitionerId,
              practitionerName,
              locationId: schedule.locationId,
              minutes: slotMinutes,
              bookedCount: overlapping,
              capacity: schedule.capacityPerSlot,
              isAvailable: overlapping < schedule.capacityPerSlot,
            });
          }

          days.push({
            date,
            practitionerId: schedule.practitionerId,
            practitionerName,
            slots,
            closedReason: null,
          });
        }
      }

      return days;
    });
  }

  /** The clinic's timezone, which all slot arithmetic is done in. */
  private async clinicSettings(): Promise<{ timezone: string }> {
    const [row] = await this.tenantDb.runReadOnly((tx) =>
      tx.select({ timezone: schema.clinic.timezone }).from(schema.clinic).limit(1),
    );
    return { timezone: row?.timezone ?? 'Asia/Kolkata' };
  }

  /**
   * The clinic's timezone, for callers doing their own day arithmetic.
   *
   * Exposed because the calendar has to group appointments into clinic-local
   * days, and a second place reading `clinic.timezone` is a second place to get
   * the fallback wrong.
   */
  async timezone(): Promise<string> {
    return (await this.clinicSettings()).timezone;
  }
}

/**
 * Which clinic-local date an instant falls on.
 *
 * `toISOString().slice(0, 10)` is the wrong answer and a tempting one: an
 * appointment at 19:00 UTC is half past midnight the next morning in Kolkata, so
 * every evening appointment in India lands on the previous day. That is not a
 * rounding error — it is a receptionist searching tomorrow's list for a patient
 * standing in front of them.
 *
 * `en-CA` because it formats as YYYY-MM-DD, which is the shape the rest of the
 * system speaks.
 */
export function localDateIn(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** Every ISO date from `from` inclusive to `to` exclusive. */
function eachDate(from: string, to: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);

  /*
   * A second bound, not the first.
   *
   * The controller refuses a range longer than 120 days outright, which is the
   * answer a caller should get. This stays because `slots()` is an ordinary
   * method that the next caller may reach without passing through that
   * validation, and an unbounded loop here is a denial of service rather than a
   * wrong answer.
   */
  while (cursor < end && dates.length < 120) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** 0 = Sunday, matching the column and JavaScript's `getDay()`. */
function weekdayOf(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

/**
 * Cuts a session into slots.
 *
 * A trailing remainder is dropped rather than rounded up: a 09:00–13:00 session
 * in 25-minute slots gives nine slots and leaves 15 minutes, and offering a tenth
 * that runs past the end of the clinic is how a doctor finds a patient booked
 * into their lunch.
 */
function divide(
  isoDate: string,
  startsAt: string,
  endsAt: string,
  slotMinutes: number,
  timezone: string,
): [Date, Date][] {
  const slots: [Date, Date][] = [];
  const offsetMs = offsetFor(isoDate, timezone);

  const dayStartUtc = new Date(`${isoDate}T00:00:00Z`).getTime() - offsetMs;
  const open = dayStartUtc + minutesOf(startsAt) * 60_000;
  const close = dayStartUtc + minutesOf(endsAt) * 60_000;
  const step = slotMinutes * 60_000;

  for (let cursor = open; cursor + step <= close; cursor += step) {
    slots.push([new Date(cursor), new Date(cursor + step)]);
  }
  return slots;
}

function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * The clinic's UTC offset on a given date, in milliseconds.
 *
 * Derived from the Intl database rather than hardcoded, so a deployment outside
 * India is not silently half an hour out. Computed per date because a timezone
 * that observes daylight saving changes offset mid-year — India does not, but
 * assuming that in the arithmetic would make this wrong the first time somebody
 * runs it anywhere else.
 */
function offsetFor(isoDate: string, timezone: string): number {
  const probe = new Date(`${isoDate}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(probe);

  const read = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  );
  return asUtc - probe.getTime();
}
