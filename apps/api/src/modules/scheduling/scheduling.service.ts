import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import {
  APPOINTMENT_CLOSED_STATUSES,
  APPOINTMENT_STATUS_LABEL,
  canTransitionAppointment,
  type Appointment,
  type QueueEntry,
} from '@emr/contracts';
import { TenantDb, type TenantTx } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { EventHub } from '../../common/events/event-hub.service';

const LIVE = ['ARRIVED', 'IN_PROGRESS'] as const;

/**
 * Appointments and the live queue.
 *
 * The queue is not a separate table. Roughly 60–80% of patients at a small
 * Indian OPD are walk-ins who are queued and never booked, and a second table
 * would mean two sources of truth for "who is waiting" — which reliably
 * diverges under concurrent front-desk edits. A walk-in creates an appointment
 * already in ARRIVED, and the queue is a query over that.
 */
@Injectable()
export class SchedulingService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly events: EventHub,
  ) {}

  /**
   * The day's board, in three buckets.
   *
   * `completed` and `checkedOut` are deliberately separate. A patient the doctor
   * has finished with is NOT a patient who has left — between the two sits the
   * front desk, the invoice and the money. Collapsing them into one list is how a
   * clinic loses a consultation fee: the row disappears from the board the moment
   * the doctor signs, and nobody at the desk ever sees it again.
   */
  async queue(): Promise<{
    waiting: QueueEntry[];
    completed: QueueEntry[];
    checkedOut: QueueEntry[];
  }> {
    return this.tenantDb.runReadOnly(async (tx) => {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      const rows = await tx
        .select({
          appointment: schema.appointment,
          patient: schema.patient,
          practitioner: schema.appUser.fullName,
        })
        .from(schema.appointment)
        .innerJoin(schema.patient, eq(schema.patient.id, schema.appointment.patientId))
        .leftJoin(schema.appUser, eq(schema.appUser.id, schema.appointment.practitionerId))
        .where(
          and(
            inArray(schema.appointment.status, [...LIVE, 'FULFILLED', 'CHECKED_OUT']),
            gte(schema.appointment.scheduledStart, startOfDay),
          ),
        )
        .orderBy(asc(schema.appointment.queuePosition), asc(schema.appointment.arrivedAt));

      // Open encounters, so the board can offer "resume" rather than "start".
      const openEncounters = await tx
        .select({ id: schema.encounter.id, appointmentId: schema.encounter.appointmentId })
        .from(schema.encounter)
        .where(eq(schema.encounter.isFinalized, false));

      const byAppointment = new Map(
        openEncounters.filter((e) => e.appointmentId).map((e) => [e.appointmentId!, e.id]),
      );

      const highAllergy = new Set(
        (
          await tx
            .select({ patientId: schema.allergyIntolerance.patientId })
            .from(schema.allergyIntolerance)
            .where(
              and(
                eq(schema.allergyIntolerance.criticality, 'HIGH'),
                sql`${schema.allergyIntolerance.refutedAt} IS NULL`,
              ),
            )
        ).map((r) => r.patientId),
      );

      const toEntry = (row: (typeof rows)[number]): QueueEntry => ({
        appointment: serialiseAppointment(row.appointment),
        patient: {
          id: row.patient.id,
          mrn: row.patient.mrn,
          fullName: row.patient.fullName,
          mobileE164: row.patient.mobileE164,
          gender: row.patient.gender,
          dateOfBirth: row.patient.dateOfBirth,
          ageYears: row.patient.ageYears,
          ageRecordedAt: row.patient.ageRecordedAt,
          tags: row.patient.tags ?? [],
          lastVisitAt: null,
          hasHighCriticalityAllergy: highAllergy.has(row.patient.id),
        },
        practitionerName: row.practitioner ?? null,
        // Server-computed, so every screen shows the same number.
        waitingMinutes: row.appointment.arrivedAt
          ? Math.round((Date.now() - row.appointment.arrivedAt.getTime()) / 60_000)
          : null,
        encounterId: byAppointment.get(row.appointment.id) ?? null,
      });

      return {
        waiting: rows
          .filter((r) => LIVE.includes(r.appointment.status as (typeof LIVE)[number]))
          .map(toEntry),
        /* Seen by the clinician, still at the desk. This is the actionable list. */
        completed: rows.filter((r) => r.appointment.status === 'FULFILLED').map(toEntry),
        /* Settled and gone. Kept on the board as the day's record. */
        checkedOut: rows.filter((r) => r.appointment.status === 'CHECKED_OUT').map(toEntry),
      };
    });
  }

  /** A walk-in goes straight onto the board. One action, not two. */
  async addWalkIn(input: {
    patientId: string;
    practitionerId?: string | null;
    reasonText?: string | null;
    idempotencyKey?: string | null;
  }): Promise<Appointment> {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      /*
       * A retried tap returns the walk-in it already made.
       *
       * The lookup is inside the transaction, and the partial unique index is
       * what makes it safe: two concurrent requests with the same key both miss
       * here, and the index fails one of them. This turns the common case — a
       * retry seconds later — into the right answer rather than a constraint
       * error the receptionist has to interpret with a patient in front of them.
       */
      const existing = await findByKey(tx, input.idempotencyKey);
      if (existing) return existing;

      const positions = await tx.execute<{ max: string }>(sql`
        SELECT coalesce(max(queue_position), 0) AS max FROM appointment
        WHERE status IN ('ARRIVED','IN_PROGRESS')
      `);
      const highest = Number(positions.rows[0]?.max ?? 0);

      const [created] = await tx
        .insert(schema.appointment)
        .values({
          clinicId: ctx.clinicId,
          patientId: input.patientId,
          practitionerId: input.practitionerId ?? null,
          status: 'ARRIVED',
          scheduledStart: new Date(),
          arrivedAt: new Date(),
          // Sparse, so re-prioritising never renumbers the queue. The front
          // desk reorders constantly.
          queuePosition: highest + 10,
          isWalkIn: true,
          reasonText: input.reasonText ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();

      /*
       * A walk-in is somebody standing at the counter, so it is `queue-changed`
       * rather than `appointment-changed`: the waiting room just grew.
       *
       * Also missing until now. The doctor's queue screen refreshed on a poll
       * rather than on arrival, which on a quiet morning means a patient sitting
       * in the waiting room for up to a minute after being told to go in.
       */
      this.events.emit({
        type: 'queue-changed',
        clinicId: ctx.clinicId,
        data: { appointmentId: created!.id, status: 'ARRIVED' },
      });

      return serialiseAppointment(created!);
    });
  }

  async book(input: Record<string, unknown>): Promise<Appointment> {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      // The same booking twice is the same booking. See `addWalkIn`.
      const existing = await findByKey(tx, input.idempotencyKey as string | null | undefined);
      if (existing) return existing;

      let end = input.scheduledEnd ? new Date(String(input.scheduledEnd)) : null;

      // The chosen service sets the slot length, so a new consultation books a
      // longer slot than a follow-up without anyone remembering the difference.
      if (!end && input.serviceItemId) {
        const [service] = await tx
          .select()
          .from(schema.serviceItem)
          .where(eq(schema.serviceItem.id, String(input.serviceItemId)))
          .limit(1);
        if (service?.defaultDurationMinutes) {
          end = new Date(
            new Date(String(input.scheduledStart)).getTime() +
              service.defaultDurationMinutes * 60_000,
          );
        }
      }

      const [created] = await tx
        .insert(schema.appointment)
        .values({
          clinicId: ctx.clinicId,
          patientId: String(input.patientId),
          practitionerId: (input.practitionerId as string) ?? null,
          locationId: (input.locationId as string) ?? null,
          /*
           * STORED, not just used and discarded.
           *
           * This value was already in hand — it is what the duration lookup
           * above reads — and the row had nowhere to put it, so "which service
           * was this appointment for" was unanswerable and the analytics service
           * filter had to say "narrows revenue only". Now it is kept.
           */
          serviceItemId: (input.serviceItemId as string) ?? null,
          idempotencyKey: (input.idempotencyKey as string) ?? null,
          status: 'SCHEDULED',
          scheduledStart: new Date(String(input.scheduledStart)),
          scheduledEnd: end,
          isWalkIn: false,
          reasonText: (input.reasonText as string) ?? null,
          notes: (input.notes as string) ?? null,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();

      /*
       * Announced, so a slot taken at the front desk disappears from the
       * doctor's calendar without anybody pressing anything.
       *
       * This was missing, and the gap is the reason it is worth a comment: every
       * OTHER transition on an appointment emitted, so the calendar updated
       * live when somebody was checked in, called or moved — and stayed stale on
       * the one event that matters most for double-booking, a brand new booking.
       * Two receptionists on two terminals could sell the same 09:30.
       *
       * Identifiers only, like everything on this pipe. Never the patient's name.
       */
      this.events.emit({
        type: 'appointment-changed',
        clinicId: ctx.clinicId,
        data: { appointmentId: created!.id },
      });

      return serialiseAppointment(created!);
    });
  }

  async listAppointments(from?: string, to?: string) {
    return this.tenantDb.runReadOnly(async (tx) => {
      const start = from ? new Date(from) : startOfToday();
      const end = to ? new Date(to) : endOfToday();

      const rows = await tx
        .select({
          appointment: schema.appointment,
          patient: schema.patient,
          practitioner: schema.appUser.fullName,
        })
        .from(schema.appointment)
        .innerJoin(schema.patient, eq(schema.patient.id, schema.appointment.patientId))
        .leftJoin(schema.appUser, eq(schema.appUser.id, schema.appointment.practitionerId))
        .where(
          and(
            gte(schema.appointment.scheduledStart, start),
            lte(schema.appointment.scheduledStart, end),
          ),
        )
        .orderBy(asc(schema.appointment.scheduledStart));

      return {
        items: rows.map((row) => ({
          appointment: serialiseAppointment(row.appointment),
          patient: {
            id: row.patient.id,
            mrn: row.patient.mrn,
            fullName: row.patient.fullName,
            mobileE164: row.patient.mobileE164,
            gender: row.patient.gender,
            dateOfBirth: row.patient.dateOfBirth,
            ageYears: row.patient.ageYears,
            ageRecordedAt: row.patient.ageRecordedAt,
            tags: row.patient.tags ?? [],
            lastVisitAt: null,
            hasHighCriticalityAllergy: false,
          },
          practitionerName: row.practitioner ?? null,
        })),
      };
    });
  }

  /**
   * Moves or resizes an appointment.
   *
   * This is what a drag on the calendar does, and it is deliberately NOT part of
   * `changeStatus`. Moving a booking and changing its state are different acts
   * with different audit meanings: "rescheduled to Thursday" and "marked
   * no-show" should never be the same trail entry.
   *
   * CLOSED APPOINTMENTS DO NOT MOVE. Dragging a cancelled or checked-out block
   * to a new time would quietly rewrite history — the visit happened, or did
   * not, at the time it says. A cancelled slot is rebooked by making a new
   * appointment, not by resurrecting the old one.
   *
   * THE DOCTOR CAN CHANGE TOO, because on a multi-column day the natural gesture
   * is dragging a patient from one doctor to another, and the alternative is
   * cancel-and-rebook, which loses the appointment's history for a change the
   * clinic thinks of as "Dr Rao will see them instead".
   */
  async reschedule(
    appointmentId: string,
    input: {
      scheduledStart: string;
      scheduledEnd?: string | null;
      practitionerId?: string | null;
      version?: number;
    },
  ): Promise<Appointment> {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.appointment)
        .where(eq(schema.appointment.id, appointmentId))
        .limit(1);
      if (!current) throw new NotFoundException('That appointment could not be found.');

      /*
       * Version checked before anything else is validated.
       *
       * A calendar is the most concurrently edited screen in the product — the
       * front desk and the doctor are both looking at it — and a drag carries
       * the version the browser last saw. Without this, the later of two
       * simultaneous drags silently wins and the earlier one vanishes with no
       * trace that it happened.
       */
      if (input.version !== undefined && input.version !== current.version) {
        throw new ConflictException(
          'Somebody else moved this appointment while you were dragging it. ' +
            'Reload the calendar.',
        );
      }

      if (APPOINTMENT_CLOSED_STATUSES.includes(current.status)) {
        throw new ConflictException(
          `That appointment is ${APPOINTMENT_STATUS_LABEL[current.status].toLowerCase()} ` +
            'and cannot be moved. Book a new appointment instead.',
        );
      }

      const start = new Date(input.scheduledStart);
      if (Number.isNaN(start.getTime())) {
        throw new ConflictException('That is not a valid time.');
      }

      /*
       * A resize that ends before it starts is rejected rather than swapped.
       *
       * Silently reordering the two would mean a drag the user did not intend
       * lands as a change they cannot see — and the gesture that produces this
       * is dragging the top handle below the bottom one, where the honest answer
       * is "that did nothing".
       */
      const end = input.scheduledEnd ? new Date(input.scheduledEnd) : null;
      if (end && (Number.isNaN(end.getTime()) || end <= start)) {
        throw new ConflictException('An appointment has to end after it starts.');
      }

      const [updated] = await tx
        .update(schema.appointment)
        .set({
          scheduledStart: start,
          scheduledEnd: end,
          practitionerId:
            input.practitionerId === undefined ? current.practitionerId : input.practitionerId,
          version: current.version + 1,
          updatedBy: ctx.userId,
        })
        .where(eq(schema.appointment.id, appointmentId))
        .returning();

      // Identifiers only — the calendar refetches. Never the patient's name.
      this.events.emit({
        type: 'appointment-changed',
        clinicId: ctx.clinicId,
        data: { appointmentId },
      });

      return serialiseAppointment(updated!);
    });
  }

  async changeStatus(
    appointmentId: string,
    status: Appointment['status'],
    cancelledReason?: string | null,
  ): Promise<Appointment> {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.appointment)
        .where(eq(schema.appointment.id, appointmentId))
        .limit(1);
      if (!current) throw new NotFoundException('That appointment could not be found.');

      /*
       * THE SERVER CHECKS THE TRANSITION, not only the screen.
       *
       * This was previously a blanket setter: any status could become any other.
       * The UI only ever offered the legal moves, so nothing in the product did
       * anything wrong — which is exactly why it went unnoticed that the API
       * would revive a cancelled appointment, send a scheduled one straight to
       * completed with nobody seen, or reopen a settled visit for re-billing.
       *
       * Re-asserting the same status is allowed and does nothing. Reception
       * double-clicking "Check in" should not be an error.
       */
      if (current.status === status) return serialiseAppointment(current);

      if (!canTransitionAppointment(current.status, status)) {
        throw new ConflictException(
          `That appointment is ${APPOINTMENT_STATUS_LABEL[current.status].toLowerCase()}; ` +
            `it cannot become ${APPOINTMENT_STATUS_LABEL[status].toLowerCase()}. ` +
            'Reload the queue — somebody else may have moved it.',
        );
      }

      const now = new Date();
      const [updated] = await tx
        .update(schema.appointment)
        .set({
          status,
          /*
           * Each stamp is written once, on the transition that earns it, and is
           * never overwritten. `arrivedAt ?? now` matters for the late no-show
           * who is re-admitted: their original arrival time is the one that
           * counts for how long they waited.
           */
          arrivedAt: status === 'ARRIVED' ? (current.arrivedAt ?? now) : current.arrivedAt,
          calledAt: status === 'IN_PROGRESS' ? (current.calledAt ?? now) : current.calledAt,
          completedAt: status === 'FULFILLED' ? (current.completedAt ?? now) : current.completedAt,
          checkedOutAt: status === 'CHECKED_OUT' ? now : current.checkedOutAt,
          checkedOutBy: status === 'CHECKED_OUT' ? ctx.userId : current.checkedOutBy,
          cancelledReason: cancelledReason ?? current.cancelledReason,
          updatedBy: ctx.userId,
        })
        .where(eq(schema.appointment.id, appointmentId))
        .returning();

      /*
       * Announced so the calendar, the queue and the doctor's list all move
       * together. Identifiers only — this pipe never carries a patient name.
       */
      this.events.emit({
        type: 'queue-changed',
        clinicId: ctx.clinicId,
        data: { appointmentId, status },
      });

      return serialiseAppointment(updated!);
    });
  }

  /**
   * Check in: the patient is here.
   *
   * A named action rather than a raw status change, for two reasons. It reads as
   * one line in the audit trail — "CHECKED_IN", not "status changed to ARRIVED" —
   * and it is the point at which the patient joins the live queue, which is a
   * fact about the clinic's day rather than a field on a row.
   */
  async checkIn(appointmentId: string): Promise<Appointment> {
    return this.changeStatus(appointmentId, 'ARRIVED');
  }

  /**
   * Check out: the visit is closed.
   *
   * ONLY REACHABLE FROM FULFILLED, which the transition map enforces — so a
   * patient cannot be checked out before the clinician has signed. That rule is
   * free: it falls out of the state machine rather than needing its own guard.
   *
   * Returns what the front desk needs in the same breath: whether this visit was
   * billed and whether anything is still owed. Checking out a patient with an
   * unpaid invoice is legitimate — clinics extend credit — but it should be a
   * decision somebody makes, not something that happens quietly.
   */
  async checkOut(appointmentId: string): Promise<{
    appointment: Appointment;
    billing: {
      invoiceId: string | null;
      invoiceNumber: string | null;
      totalPaise: number;
      paidPaise: number;
      outstandingPaise: number;
    };
  }> {
    const appointment = await this.changeStatus(appointmentId, 'CHECKED_OUT');
    return { appointment, billing: await this.billingPositionFor(appointmentId) };
  }

  /**
   * What this visit owes, if anything.
   *
   * Joined through the encounter rather than the appointment, because an invoice
   * is raised against the consultation — the appointment is the booking, and a
   * walk-in may have no appointment at all by the time money changes hands.
   */
  async billingPositionFor(appointmentId: string) {
    return this.tenantDb.runReadOnly(async (tx) => {
      const [row] = await tx
        .select({
          invoiceId: schema.invoice.id,
          invoiceNumber: schema.invoice.invoiceNumber,
          totalPaise: schema.invoice.totalPaise,
          paidPaise: schema.invoice.paidPaise,
        })
        .from(schema.invoice)
        .innerJoin(schema.encounter, eq(schema.encounter.id, schema.invoice.encounterId))
        .where(
          and(
            eq(schema.encounter.appointmentId, appointmentId),
            // A cancelled invoice is not a debt. It is also not a reason to say
            // the visit was never billed, but the outstanding figure must not
            // include it.
            sql`${schema.invoice.status} <> 'CANCELLED'`,
          ),
        )
        .orderBy(desc(schema.invoice.createdAt))
        .limit(1);

      if (!row) {
        return {
          invoiceId: null,
          invoiceNumber: null,
          totalPaise: 0,
          paidPaise: 0,
          outstandingPaise: 0,
        };
      }

      const total = Number(row.totalPaise);
      const paid = Number(row.paidPaise);
      return {
        invoiceId: row.invoiceId,
        invoiceNumber: row.invoiceNumber,
        totalPaise: total,
        paidPaise: paid,
        // Never negative: an overpayment is a credit to handle, not a debt.
        outstandingPaise: Math.max(total - paid, 0),
      };
    });
  }

  /**
   * Re-prioritise.
   *
   * Takes the neighbour rather than an absolute position, so two receptionists
   * dragging at once cannot land a patient in the wrong slot. Sparse integers
   * mean the queue is never renumbered.
   */
  async reorder(
    appointmentId: string,
    beforeAppointmentId: string | null,
  ): Promise<Appointment> {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const live = await tx
        .select()
        .from(schema.appointment)
        .where(inArray(schema.appointment.status, [...LIVE]))
        .orderBy(asc(schema.appointment.queuePosition));

      const moving = live.find((a) => a.id === appointmentId);
      if (!moving) throw new NotFoundException('That patient is not in the queue.');

      let position: number;
      if (beforeAppointmentId) {
        const index = live.findIndex((a) => a.id === beforeAppointmentId);
        if (index === -1) throw new ConflictException('The queue changed. Try again.');
        const before = live[index - 1]?.queuePosition ?? 0;
        const target = live[index]!.queuePosition ?? 0;
        position = Math.round((before + target) / 2);
        // Positions collided — renumber once so there is room again.
        if (position === before || position === target) {
          await renumber(tx, live);
          return this.reorder(appointmentId, beforeAppointmentId);
        }
      } else {
        position = Math.max(0, ...live.map((a) => a.queuePosition ?? 0)) + 10;
      }

      const [updated] = await tx
        .update(schema.appointment)
        .set({ queuePosition: position, updatedBy: ctx.userId })
        .where(eq(schema.appointment.id, appointmentId))
        .returning();

      return serialiseAppointment(updated!);
    });
  }
}

/**
 * Spreads the queue back out to 10, 20, 30…
 *
 * Only needed when repeated insertions between neighbours have used up the gap.
 * Sparse positions mean this is rare, which is the whole point of them.
 */
async function renumber(
  tx: Parameters<Parameters<TenantDb['run']>[0]>[0],
  live: (typeof schema.appointment.$inferSelect)[],
) {
  let position = 10;
  for (const row of live) {
    await tx
      .update(schema.appointment)
      .set({ queuePosition: position })
      .where(eq(schema.appointment.id, row.id));
    position += 10;
  }
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * The appointment a repeated attempt already created, if there is one.
 *
 * Shared by `book` and `addWalkIn` because they write the same table and a key
 * minted for one must not be reusable by the other — a single index over
 * (clinic_id, idempotency_key) gives exactly that, and one lookup keeps the two
 * paths from drifting.
 *
 * Returns undefined when there is no key, which is the no-protection case. That
 * is deliberate rather than an oversight: a client without a key is served, and
 * is simply not protected from its own retries.
 */
async function findByKey(
  tx: TenantTx,
  idempotencyKey: string | null | undefined,
): Promise<Appointment | undefined> {
  if (!idempotencyKey) return undefined;

  const [found] = await tx
    .select()
    .from(schema.appointment)
    .where(eq(schema.appointment.idempotencyKey, idempotencyKey))
    .limit(1);

  return found ? serialiseAppointment(found) : undefined;
}

export function serialiseAppointment(
  row: typeof schema.appointment.$inferSelect,
): Appointment {
  return {
    ...row,
    scheduledStart: row.scheduledStart.toISOString(),
    scheduledEnd: row.scheduledEnd?.toISOString() ?? null,
    arrivedAt: row.arrivedAt?.toISOString() ?? null,
    calledAt: row.calledAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    checkedOutAt: row.checkedOutAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  } as unknown as Appointment;
}
