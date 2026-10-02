/**
 * When a doctor works.
 *
 * Two tables, and the split is the whole design: a RECURRING PATTERN and the
 * EXCEPTIONS to it. A clinic's week is overwhelmingly the same week every week —
 * Dr Rao does Monday to Saturday, nine to one and five to eight — and the
 * interesting information is the departures from that: a Tuesday off, a
 * conference, a late start after a night shift.
 *
 * WHY NOT MATERIALISE SLOTS. The obvious alternative is a row per bookable slot,
 * generated ahead. It is wrong here for three reasons: it has to be regenerated
 * whenever the pattern changes (and the change is usually retroactive in
 * someone's head but not in the table), it makes "move this doctor's Thursday"
 * an unbounded update, and it fills the database with rows whose only purpose is
 * to be absent. Slots are derived on read: pattern, minus exceptions, minus what
 * is already booked.
 *
 * THE SLOT LENGTH LIVES ON THE PATTERN, not on the clinic. A doctor who sees
 * follow-ups in ten minutes on a Saturday morning and new patients in thirty on a
 * Wednesday afternoon is describing two sessions, not two clinics — and the
 * request for "completely customizable" 15-minute slots means exactly this:
 * something to customise per session rather than one number in settings.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  time,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { auditColumns, clinicIdColumn, primaryKeyColumn, tenantPolicy } from './shared';
import { appUser, clinic, clinicLocation } from './tenancy';

/**
 * One recurring session.
 *
 * A doctor who works mornings and evenings has TWO rows for that weekday, not one
 * row with a lunch break in it. Modelling the break would mean every consumer
 * handles a gap inside a range; two sessions is the same information with no
 * special case, and it is also how a clinic says it out loud.
 */
export const practitionerSchedule = pgTable(
  'practitioner_schedule',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    practitionerId: uuid('practitioner_id').notNull(),

    /**
     * Null means every location.
     *
     * A single-location clinic — which is most of them — should not have to pick
     * one, and a doctor who moves between branches on different days sets it per
     * session.
     */
    locationId: uuid('location_id'),

    /** 0 = Sunday, matching JavaScript's `getDay()` so no conversion is needed. */
    weekday: integer('weekday').notNull(),

    /**
     * Local clinic time, not UTC.
     *
     * A session is "nine in the morning" in the clinic's own timezone, and it
     * stays nine in the morning across a daylight change the clinic does not
     * observe. Storing an instant would make the pattern drift against the wall
     * clock it describes.
     */
    startsAt: time('starts_at').notNull(),
    endsAt: time('ends_at').notNull(),

    /**
     * How long one appointment takes in this session.
     *
     * The default is 15, which is the request's starting point and also the
     * commonest outpatient slot in India. A service with its own duration still
     * wins at booking time — this is the grid the calendar draws, not a cap.
     */
    slotMinutes: integer('slot_minutes').notNull().default(15),

    /**
     * How many patients may hold the same slot.
     *
     * One by default. Clinics that run genuine overbooking — a token system where
     * four people are told "after ten" — set it higher rather than booking on top
     * of each other and losing the fact that they meant to.
     */
    capacityPerSlot: integer('capacity_per_slot').notNull().default(1),

    /** When this pattern starts and stops applying. Null end means indefinitely. */
    effectiveFrom: date('effective_from'),
    effectiveTo: date('effective_to'),

    isActive: boolean('is_active').notNull().default(true),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.practitionerId], foreignColumns: [appUser.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.locationId], foreignColumns: [clinicLocation.id] }).onDelete(
      'set null',
    ),

    index('practitioner_schedule_lookup_idx').on(t.clinicId, t.practitionerId, t.weekday),
    check('practitioner_schedule_weekday_valid', sql`weekday BETWEEN 0 AND 6`),
    check('practitioner_schedule_ends_after_start', sql`ends_at > starts_at`),
    check('practitioner_schedule_slot_sane', sql`slot_minutes BETWEEN 5 AND 240`),
    check('practitioner_schedule_capacity_positive', sql`capacity_per_slot >= 1`),
    tenantPolicy('practitioner_schedule'),
  ],
).enableRLS();

/**
 * A departure from the pattern, for one date.
 *
 * Covers both directions: a day off, and a day the doctor works when they
 * normally would not. `isAvailable = false` with no hours is leave; `true` with
 * hours is an extra session.
 *
 * ONE ROW PER PRACTITIONER PER DATE, enforced by a unique index. Two overlapping
 * exceptions for the same day is a state nobody can read — which wins? — and it
 * arises the moment two people enter leave for the same doctor.
 */
export const scheduleException = pgTable(
  'schedule_exception',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    /**
     * Null means the whole clinic.
     *
     * A public holiday is not a property of each doctor separately, and entering
     * it five times is five chances to miss one.
     */
    practitionerId: uuid('practitioner_id'),

    onDate: date('on_date').notNull(),

    /** False is leave or a closure. True is working when the pattern says not. */
    isAvailable: boolean('is_available').notNull().default(false),

    /** Replacement hours, when `isAvailable`. Null means the pattern's own hours. */
    startsAt: time('starts_at'),
    endsAt: time('ends_at'),
    slotMinutes: integer('slot_minutes'),

    /**
     * Required, and shown to whoever is looking at the empty day.
     *
     * "Why is Dr Rao not bookable on the 14th" is asked at a counter with a
     * patient waiting, and "no reason recorded" is not an answer anybody can act
     * on.
     */
    reason: text('reason').notNull(),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.practitionerId], foreignColumns: [appUser.id] }).onDelete('cascade'),

    /*
     * One exception per practitioner per date, and one clinic-wide per date.
     *
     * Postgres treats NULLs as distinct in a unique index, which would allow two
     * clinic-wide closures on one day — so the practitioner column is coalesced
     * to a sentinel. `COALESCE` in an index expression needs the uuid cast to
     * stay immutable.
     */
    uniqueIndex('schedule_exception_uq').on(
      t.clinicId,
      sql`coalesce(${t.practitionerId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.onDate,
    ),
    index('schedule_exception_date_idx').on(t.clinicId, t.onDate),
    check(
      'schedule_exception_hours_paired',
      sql`(starts_at IS NULL) = (ends_at IS NULL)`,
    ),
    check(
      'schedule_exception_ends_after_start',
      sql`starts_at IS NULL OR ends_at > starts_at`,
    ),
    tenantPolicy('schedule_exception'),
  ],
).enableRLS();
