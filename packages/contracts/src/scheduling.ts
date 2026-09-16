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
import { AuditFields, IsoDateTime, Uuid } from './common';
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
});
export type BookAppointment = z.infer<typeof BookAppointment>;

/** Adds a walk-in straight to the queue, skipping the booking form entirely. */
export const AddToQueue = z.object({
  patientId: Uuid,
  practitionerId: Uuid.nullable(),
  reasonText: z.string().nullable().default(null),
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

/** Which statuses are reachable from which. Drives the UI's status control. */
export const ALLOWED_STATUS_TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  SCHEDULED: ['CONFIRMED', 'ARRIVED', 'CANCELLED', 'NOSHOW'],
  CONFIRMED: ['ARRIVED', 'CANCELLED', 'NOSHOW'],
  ARRIVED: ['IN_PROGRESS', 'CANCELLED', 'NOSHOW'],
  IN_PROGRESS: ['FULFILLED', 'CANCELLED'],
  FULFILLED: [],
  CANCELLED: [],
  NOSHOW: ['ARRIVED'],
};
