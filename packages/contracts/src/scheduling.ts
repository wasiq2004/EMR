/**
 * Appointments and the live queue.
 *
 * The queue is not a separate entity. Roughly 60–80% of patients at a small
 * Indian OPD are walk-ins who are queued and never booked, and a separate queue
 * table would create two sources of truth for "who is waiting" — which reliably
 * diverges under concurrent front-desk edits. A walk-in creates an appointment
 * already in ARRIVED status, and the queue is a query over that.
 */

import { z } from 'zod';
import { AuditFields, IsoDate, IsoDateTime, Uuid } from './common';
import { AppointmentStatus } from './enums';
import { PatientSummary } from './patient';

export const Appointment = z.object({
  id: Uuid,
  patientId: Uuid,
  practitionerId: Uuid.nullable(),
  locationId: Uuid.nullable(),
  status: AppointmentStatus,
  scheduledStart: IsoDateTime,
  scheduledEnd: IsoDateTime.nullable(),
  /** Set at check-in. Starts the wait clock the queue screen displays. */
  arrivedAt: IsoDateTime.nullable(),
  /** Set when the doctor opens the encounter. */
  calledAt: IsoDateTime.nullable(),
  completedAt: IsoDateTime.nullable(),
  /** When the front desk closed the visit. Null until they do. */
  checkedOutAt: IsoDateTime.nullable(),
  /**
   * Sparse integers (10, 20, 30…) so a patient can be re-prioritised without
   * renumbering the queue. The front desk reorders constantly.
   */
  queuePosition: z.number().int().nullable(),
  isWalkIn: z.boolean(),
  reasonText: z.string().nullable(),
  notes: z.string().nullable(),
  cancelledReason: z.string().nullable(),
}).extend(AuditFields.shape);
export type Appointment = z.infer<typeof Appointment>;

/** One row on the queue board. Joined so the board renders from one response. */
export const QueueEntry = z.object({
  appointment: Appointment,
  patient: PatientSummary,
  practitionerName: z.string().nullable(),
  /** Server-computed so every screen shows the same number. */
  waitingMinutes: z.number().int().nullable(),
  /** The open encounter, when the doctor has already started. */
  encounterId: Uuid.nullable(),
});
export type QueueEntry = z.infer<typeof QueueEntry>;

export const BookAppointment = z.object({
  patientId: Uuid,
  practitionerId: Uuid.nullable(),
  locationId: Uuid.nullable().default(null),
  serviceItemId: Uuid.nullable().default(null),
  scheduledStart: IsoDateTime,
  scheduledEnd: IsoDateTime.nullable().default(null),
  reasonText: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),

  /**
   * One value per attempt, held across retries.
   *
   * A BODY FIELD, not a header. The client has always passed an
   * `Idempotency-Key` header here and nothing on the server read it, so a
   * double-tap at a busy front desk booked the same patient twice — and until
   * somebody noticed and cancelled one, the day looked fuller than it was and
   * the doctor was double-booked.
   *
   * Optional rather than required, unlike a payment or a stock receipt: a
   * duplicate appointment is a mess somebody can cancel, not money that moved,
   * so an integration without a key is served rather than refused.
   */
  idempotencyKey: z.string().min(8).max(200).nullish(),
});
export type BookAppointment = z.infer<typeof BookAppointment>;

/** Adds a walk-in straight to the queue, skipping the booking form entirely. */
export const AddToQueue = z.object({
  patientId: Uuid,
  practitionerId: Uuid.nullable(),
  reasonText: z.string().nullable().default(null),

  /**
   * One value per attempt, held across retries.
   *
   * A BODY FIELD, not a header. The client has always passed an
   * `Idempotency-Key` header here and nothing on the server read it, so a
   * double-tap at a busy front desk booked the same patient twice — and until
   * somebody noticed and cancelled one, the day looked fuller than it was and
   * the doctor was double-booked.
   *
   * Optional rather than required, unlike a payment or a stock receipt: a
   * duplicate appointment is a mess somebody can cancel, not money that moved,
   * so an integration without a key is served rather than refused.
   */
  idempotencyKey: z.string().min(8).max(200).nullish(),
});
export type AddToQueue = z.infer<typeof AddToQueue>;

export const ChangeAppointmentStatus = z.object({
  appointmentId: Uuid,
  version: z.number().int(),
  status: AppointmentStatus,
  cancelledReason: z.string().nullable().default(null),
});
export type ChangeAppointmentStatus = z.infer<typeof ChangeAppointmentStatus>;

/**
 * Reorder by naming the neighbours rather than sending an absolute position, so
 * two receptionists dragging at once cannot swap a patient into the wrong slot.
 */
export const ReorderQueue = z.object({
  appointmentId: Uuid,
  beforeAppointmentId: Uuid.nullable(),
  afterAppointmentId: Uuid.nullable(),
});
export type ReorderQueue = z.infer<typeof ReorderQueue>;

/**
 * Which statuses are reachable from which.
 *
 * Drives the UI's status control AND — since this change — the server's own
 * check. It previously drove only the UI, which meant the rule held exactly as
 * long as everybody went through the buttons: the API would happily revive a
 * cancelled appointment, or move a scheduled one straight to completed without
 * anybody having been seen. Nothing in the product did that, which is precisely
 * why it went unnoticed.
 */
export const ALLOWED_STATUS_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  SCHEDULED: ['CONFIRMED', 'ARRIVED', 'CANCELLED', 'NOSHOW'],
  CONFIRMED: ['ARRIVED', 'CANCELLED', 'NOSHOW'],
  /** A waiting patient who gives up and leaves is a no-show, not a cancellation. */
  ARRIVED: ['IN_PROGRESS', 'CANCELLED', 'NOSHOW'],
  /**
   * Back to ARRIVED is deliberate: the wrong patient was called in, or the doctor
   * stepped out mid-consultation. Without it the only way back is a cancellation,
   * which loses the fact that the patient is still sitting in the waiting room.
   */
  IN_PROGRESS: ['FULFILLED', 'ARRIVED', 'CANCELLED'],
  /** The consultation is signed; the front desk still has to close the visit. */
  FULFILLED: ['CHECKED_OUT'],
  /** Terminal. A settled visit is not reopened — a correction is a credit note. */
  CHECKED_OUT: [],
  CANCELLED: [],
  /**
   * A no-show who turns up late. Common enough at a walk-in clinic that refusing
   * it would have reception cancelling and rebooking to work around the software.
   */
  NOSHOW: ['ARRIVED', 'CANCELLED'],
};

/** True if this transition is allowed. Asked by the UI and by the server. */
export function canTransitionAppointment(
  from: AppointmentStatus,
  to: AppointmentStatus,
): boolean {
  return ALLOWED_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/** The patient is physically in the building. */
export const APPOINTMENT_LIVE_STATUSES: AppointmentStatus[] = ['ARRIVED', 'IN_PROGRESS'];

/** Nothing more happens on this appointment today. */
export const APPOINTMENT_CLOSED_STATUSES: AppointmentStatus[] = [
  'CHECKED_OUT',
  'CANCELLED',
  'NOSHOW',
];


/* ------------------------------------------------------------------------- *
 * Availability — when a doctor is bookable
 * ------------------------------------------------------------------------- */

/** 0 = Sunday, matching JavaScript's `getDay()` so no conversion is needed. */
export const WEEKDAYS = [
  { value: 0, label: 'Sunday', short: 'Sun' },
  { value: 1, label: 'Monday', short: 'Mon' },
  { value: 2, label: 'Tuesday', short: 'Tue' },
  { value: 3, label: 'Wednesday', short: 'Wed' },
  { value: 4, label: 'Thursday', short: 'Thu' },
  { value: 5, label: 'Friday', short: 'Fri' },
  { value: 6, label: 'Saturday', short: 'Sat' },
] as const;

/** HH:MM or HH:MM:SS, in the clinic's own timezone. */
const ClockTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use a time like 09:00');

/**
 * One recurring session.
 *
 * A doctor working mornings and evenings has TWO of these for that weekday, not
 * one with a break inside it. Two sessions is the same information with no
 * special case, and it is how a clinic describes it out loud.
 */
export const SaveSchedule = z.object({
  id: Uuid.optional(),
  practitionerId: Uuid,
  /** Null means every location — which is most clinics. */
  locationId: Uuid.nullish(),
  weekday: z.number().int().min(0).max(6),
  startsAt: ClockTime,
  endsAt: ClockTime,
  /**
   * How long one appointment takes in this session.
   *
   * Defaults to 15 and is settable per session, which is what "completely
   * customizable" means in practice: a doctor seeing follow-ups in ten minutes on
   * a Saturday and new patients in thirty on a Wednesday is describing two
   * sessions, not two clinics.
   */
  slotMinutes: z.number().int().min(5).max(240).default(15),
  /** Above one only for clinics that genuinely run a token system. */
  capacityPerSlot: z.number().int().min(1).max(10).default(1),
  effectiveFrom: IsoDate.nullish(),
  effectiveTo: IsoDate.nullish(),
  isActive: z.boolean().default(true),
}).refine((v) => v.endsAt > v.startsAt, {
  message: 'The session has to end after it starts',
  path: ['endsAt'],
});
export type SaveSchedule = z.infer<typeof SaveSchedule>;

export const PractitionerSchedule = z.object({
  id: Uuid,
  practitionerId: Uuid,
  practitionerName: z.string(),
  locationId: Uuid.nullable(),
  locationName: z.string().nullable(),
  weekday: z.number().int(),
  startsAt: z.string(),
  endsAt: z.string(),
  slotMinutes: z.number().int(),
  capacityPerSlot: z.number().int(),
  effectiveFrom: IsoDate.nullable(),
  effectiveTo: IsoDate.nullable(),
  isActive: z.boolean(),
});
export type PractitionerSchedule = z.infer<typeof PractitionerSchedule>;

/**
 * A departure from the pattern, for one date.
 *
 * Both directions: `isAvailable: false` is leave or a closure, `true` with hours
 * is working when the pattern says otherwise.
 */
export const SaveScheduleException = z.object({
  id: Uuid.optional(),
  /** Null means the whole clinic — a public holiday is not entered per doctor. */
  practitionerId: Uuid.nullish(),
  onDate: IsoDate,
  isAvailable: z.boolean().default(false),
  startsAt: ClockTime.nullish(),
  endsAt: ClockTime.nullish(),
  slotMinutes: z.number().int().min(5).max(240).nullish(),
  /**
   * Required. "Why is Dr Rao not bookable on the 14th" gets asked at a counter
   * with a patient waiting, and "no reason recorded" is not an answer.
   */
  reason: z.string().trim().min(3, 'Say why, even briefly'),
});
export type SaveScheduleException = z.infer<typeof SaveScheduleException>;

export const ScheduleException = z.object({
  id: Uuid,
  practitionerId: Uuid.nullable(),
  practitionerName: z.string().nullable(),
  onDate: IsoDate,
  isAvailable: z.boolean(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  slotMinutes: z.number().int().nullable(),
  reason: z.string(),
});
export type ScheduleException = z.infer<typeof ScheduleException>;

/** One bookable slot, derived rather than stored. */
export const Slot = z.object({
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  practitionerId: Uuid,
  practitionerName: z.string(),
  locationId: Uuid.nullable(),
  minutes: z.number().int(),
  /** Appointments already overlapping this slot. */
  bookedCount: z.number().int(),
  capacity: z.number().int(),
  isAvailable: z.boolean(),
});
export type Slot = z.infer<typeof Slot>;

/** One doctor's day. `closedReason` is set when an exception closed it. */
export const DaySchedule = z.object({
  date: IsoDate,
  practitionerId: Uuid,
  practitionerName: z.string(),
  slots: z.array(Slot),
  closedReason: z.string().nullable(),
});
export type DaySchedule = z.infer<typeof DaySchedule>;

/* ========================================================================== *
 * The calendar
 * ========================================================================== */

/**
 * WHY A DEDICATED ENDPOINT rather than the client joining `/appointments` to
 * `/availability/slots`.
 *
 * Because the day analytics have to agree with what is drawn. A filtered
 * calendar showing three of a doctor's eight appointments must not say "8
 * booked" in the strip above it, and it must not say "3 booked" either — it
 * says what the filter selected, counted over the same rows that produced the
 * grid. Two round trips the client reconciles itself gives two chances to
 * disagree, and the one that disagrees is the number someone reads out in a
 * meeting.
 *
 * It also lets the month view skip slot derivation entirely. A month of five
 * doctors at fifteen-minute slots over a ten-hour day is six thousand slot
 * objects to render thirty cells containing a count — see `includeSlots`.
 */

/** An appointment as the calendar needs it: enough to draw and to identify. */
export const CalendarEntry = z.object({
  id: Uuid,
  patientId: Uuid,
  patientName: z.string(),
  patientMrn: z.string(),
  /** For the one-tap call the front desk makes when somebody is late. */
  patientMobile: z.string().nullable(),
  practitionerId: Uuid.nullable(),
  practitionerName: z.string().nullable(),
  locationId: Uuid.nullable(),
  status: AppointmentStatus,
  scheduledStart: IsoDateTime,
  /** Never null here: the server falls back to the session's slot length. */
  scheduledEnd: IsoDateTime,
  minutes: z.number().int(),
  isWalkIn: z.boolean(),
  reasonText: z.string().nullable(),
  /** Row version, so a drag can be rescheduled without clobbering a concurrent edit. */
  version: z.number().int(),
});
export type CalendarEntry = z.infer<typeof CalendarEntry>;

/**
 * One doctor's column for one day.
 *
 * `closedReason` is what to print across an empty column — "Conference", "Public
 * holiday" — because "no slots" at a counter with a patient waiting is not an
 * answer anybody can act on.
 */
export const CalendarColumn = z.object({
  practitionerId: Uuid.nullable(),
  practitionerName: z.string(),
  closedReason: z.string().nullable(),
  slots: z.array(Slot),
});
export type CalendarColumn = z.infer<typeof CalendarColumn>;

/**
 * The analytics strip above a day.
 *
 * Counted over the FILTERED rows, so the numbers always describe the grid
 * underneath them. Cancellations and no-shows are counted but excluded from
 * `utilisationPct`, because a doctor is not busy during an appointment nobody
 * attended — counting them would make a bad day look like a full one.
 */
export const DayAnalytics = z.object({
  booked: z.number().int(),
  arrived: z.number().int(),
  inConsultation: z.number().int(),
  completed: z.number().int(),
  checkedOut: z.number().int(),
  noShow: z.number().int(),
  cancelled: z.number().int(),
  walkIns: z.number().int(),
  /** Bookable slots with room left. Null when slots were not requested. */
  freeSlots: z.number().int().nullable(),
  /** Minutes of live appointments over minutes offered, 0–100. Null as above. */
  utilisationPct: z.number().int().nullable(),
});
export type DayAnalytics = z.infer<typeof DayAnalytics>;

export const CalendarDay = z.object({
  date: IsoDate,
  columns: z.array(CalendarColumn),
  entries: z.array(CalendarEntry),
  analytics: DayAnalytics,
});
export type CalendarDay = z.infer<typeof CalendarDay>;

export const Calendar = z.object({
  from: IsoDate,
  to: IsoDate,
  days: z.array(CalendarDay),
});
export type Calendar = z.infer<typeof Calendar>;

/**
 * Moving or resizing an appointment.
 *
 * `version` is optional but the calendar always sends it. It is the row the
 * browser last saw, and without it the later of two simultaneous drags silently
 * wins while the earlier one disappears with no trace that it ever happened —
 * on the one screen the front desk and the doctor are both looking at.
 */
export const RescheduleAppointment = z.object({
  scheduledStart: IsoDateTime,
  /** Null keeps the appointment open-ended; the calendar draws the default slot. */
  scheduledEnd: IsoDateTime.nullish(),
  /**
   * Set only when the drag crossed columns.
   *
   * Undefined leaves the doctor alone; explicit null unassigns. A multi-column
   * day makes "Dr Rao will see them instead" a drag sideways, and the
   * alternative — cancel and rebook — throws away the appointment's history for
   * a change the clinic does not think of as a cancellation.
   */
  practitionerId: Uuid.nullish(),
  version: z.number().int().optional(),
});
export type RescheduleAppointment = z.infer<typeof RescheduleAppointment>;

/** The views the calendar offers, and how many days each spans. */
export const CALENDAR_VIEWS = [
  { value: 'day', label: 'Day', days: 1 },
  { value: '3day', label: '3 days', days: 3 },
  { value: 'week', label: 'Week', days: 7 },
  { value: 'month', label: 'Month', days: 0 },
] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number]['value'];
