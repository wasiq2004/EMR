import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import type { Appointment, QueueEntry } from '@emr/contracts';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';

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
  constructor(private readonly tenantDb: TenantDb) {}

  async queue(): Promise<{ waiting: QueueEntry[]; completed: QueueEntry[] }> {
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
            inArray(schema.appointment.status, [...LIVE, 'FULFILLED']),
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
        completed: rows.filter((r) => r.appointment.status === 'FULFILLED').map(toEntry),
      };
    });
  }

  /** A walk-in goes straight onto the board. One action, not two. */
  async addWalkIn(input: {
    patientId: string;
    practitionerId?: string | null;
    reasonText?: string | null;
  }): Promise<Appointment> {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
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
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();

      return serialiseAppointment(created!);
    });
  }

  async book(input: Record<string, unknown>): Promise<Appointment> {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
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

      const [updated] = await tx
        .update(schema.appointment)
        .set({
          status,
          arrivedAt: status === 'ARRIVED' ? (current.arrivedAt ?? new Date()) : current.arrivedAt,
          calledAt: status === 'IN_PROGRESS' ? new Date() : current.calledAt,
          completedAt: status === 'FULFILLED' ? new Date() : current.completedAt,
          cancelledReason: cancelledReason ?? current.cancelledReason,
          updatedBy: ctx.userId,
        })
        .where(eq(schema.appointment.id, appointmentId))
        .returning();

      return serialiseAppointment(updated!);
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  } as unknown as Appointment;
}
