import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  AddToQueue,
  AppointmentStatus,
  BookAppointment,
  RescheduleAppointment,
  SaveSchedule,
  SaveScheduleException,
} from '@emr/contracts';
import { Audit, RequirePermission, SkipAudit } from '../../common/http/decorators';
import { parseBody, requireUuid } from '../../common/http/zod.pipe';
import { SchedulingService } from './scheduling.service';
import { AvailabilityService } from './availability.service';
import { CalendarService } from './calendar.service';

/** YYYY-MM-DD, validated at the edge so a bad range cannot reach the query. */
const IsoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-02');

/** The longest span of days any availability read may ask for. */
const MAX_RANGE_DAYS = 120;

/**
 * A half-open date range, bounded.
 *
 * `to` is EXCLUSIVE: a day view asks for one date and the next, a week asks for
 * Monday and the following Monday. The bound is REFUSED rather than silently
 * truncated, because a caller who asks for a year and is handed four months has
 * no way to tell — the calendar simply renders a doctor who appears to stop
 * working in February, and the bug surfaces as a support call rather than an
 * error.
 */
const DateRange = z
  .object({ from: IsoDateString, to: IsoDateString })
  .refine((r) => r.to > r.from, {
    message: 'The range has to end after it starts',
    path: ['to'],
  })
  .refine(
    (r) =>
      (Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86_400_000 <=
      MAX_RANGE_DAYS,
    {
      message: `Ask for at most ${MAX_RANGE_DAYS} days at a time`,
      path: ['to'],
    },
  );

@Controller()
export class SchedulingController {
  constructor(
    private readonly scheduling: SchedulingService,
    private readonly availability: AvailabilityService,
    private readonly calendar: CalendarService,
  ) {}

  /**
   * The live queue.
   *
   * Exempt from the audit trail: it is polled every few seconds by every open
   * screen and would otherwise dominate the table. This is one of exactly two
   * routes carrying that exemption, and it reads no clinical content.
   */
  @RequirePermission('appointment:read')
  @SkipAudit()
  @Get('queue')
  queue() {
    return this.scheduling.queue();
  }

  @RequirePermission('appointment:create')
  @Audit('WALK_IN_ADDED', 'appointment')
  @Post('queue')
  addWalkIn(@Body() body: unknown) {
    return this.scheduling.addWalkIn(parseBody(AddToQueue, body));
  }

  @RequirePermission('appointment:update')
  @SkipAudit()
  @Patch('queue/:id/position')
  reorder(@Param('id') id: string, @Body() body: { beforeAppointmentId?: string | null }) {
    return this.scheduling.reorder(
      requireUuid(id, 'Appointment'),
      body?.beforeAppointmentId ?? null,
    );
  }

  /* ---- Availability ------------------------------------------------------ */

  /**
   * Bookable slots for a range.
   *
   * Derived on read from the pattern, the exceptions and what is already booked —
   * there are no slot rows. Exempt from the audit trail: the calendar asks for
   * this on every view change and it reads no clinical content.
   */
  @RequirePermission('appointment:read')
  @SkipAudit()
  @Get('availability/slots')
  slots(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('practitionerId') practitionerId?: string,
    @Query('locationId') locationId?: string,
  ) {
    const range = parseBody(DateRange, { from, to });
    return this.availability.slots({
      ...range,
      practitionerId: practitionerId ? requireUuid(practitionerId, 'Doctor') : undefined,
      locationId: locationId ? requireUuid(locationId, 'Location') : undefined,
    });
  }

  /* ---- The calendar ------------------------------------------------------ */

  /**
   * Everything one view of the calendar needs: the bookings, the free slots and
   * the day's numbers, for the same filtered set of rows.
   *
   * Exempt from the audit trail for the same reason the queue is — every view
   * change asks for it — and like the queue it carries identifiers and names, no
   * clinical content.
   *
   * `includeSlots=false` is what the month view sends. A month of five doctors
   * at fifteen-minute slots is six thousand derived objects to draw thirty cells
   * containing a count.
   */
  @RequirePermission('appointment:read')
  @SkipAudit()
  @Get('calendar')
  calendarView(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('practitionerId') practitionerId?: string,
    @Query('locationId') locationId?: string,
    @Query('status') status?: string,
    @Query('walkIns') walkIns?: string,
    @Query('includeSlots') includeSlots?: string,
  ) {
    const range = parseBody(DateRange, { from, to });

    /*
     * Statuses arrive as a comma-separated list and are parsed against the enum
     * rather than passed through. An unrecognised value reaching `inArray`
     * would be a 500 from Postgres on an enum cast — a filter chip with a typo
     * should be a 422 naming the field.
     */
    const statuses = status
      ? parseBody(z.array(AppointmentStatus).min(1), status.split(',').filter(Boolean))
      : undefined;

    return this.calendar.calendar({
      ...range,
      practitionerId: practitionerId ? requireUuid(practitionerId, 'Doctor') : undefined,
      locationId: locationId ? requireUuid(locationId, 'Location') : undefined,
      statuses,
      // Absent means both, which is not the same as `false`.
      walkInsOnly: walkIns === undefined || walkIns === '' ? undefined : walkIns === 'true',
      includeSlots: includeSlots !== 'false',
    });
  }

  @RequirePermission('appointment:read')
  @Get('availability/schedules')
  async schedules(@Query('practitionerId') practitionerId?: string) {
    return {
      items: await this.availability.schedulesFor(
        practitionerId ? requireUuid(practitionerId, 'Doctor') : undefined,
      ),
    };
  }

  /**
   * Who works when. `clinic:update` rather than `appointment:update` — this is
   * clinic configuration, not a change to one patient's booking, and reception
   * should not be able to rewrite a doctor's working week.
   */
  @RequirePermission('clinic:update')
  @Audit('SCHEDULE_SAVED', 'clinic')
  @Post('availability/schedules')
  saveSchedule(@Body() body: unknown) {
    return this.availability.saveSchedule(parseBody(SaveSchedule, body) as never);
  }

  @RequirePermission('clinic:update')
  @Audit('SCHEDULE_REMOVED', 'clinic')
  @Post('availability/schedules/:id/remove')
  removeSchedule(@Param('id') id: string) {
    return this.availability.deleteSchedule(requireUuid(id, 'Session'));
  }

  @RequirePermission('appointment:read')
  @Get('availability/exceptions')
  async exceptions(@Query('from') from: string, @Query('to') to: string) {
    const range = parseBody(DateRange, { from, to });
    return { items: await this.availability.exceptions(range.from, range.to) };
  }

  /**
   * Leave, holidays and extra sessions.
   *
   * `appointment:update` rather than `clinic:update`: entering that a doctor is
   * off next Tuesday is front-desk work, and requiring an administrator for it
   * means the calendar is wrong until one is available.
   */
  @RequirePermission('appointment:update')
  @Audit('SCHEDULE_EXCEPTION_SAVED', 'clinic')
  @Post('availability/exceptions')
  saveException(@Body() body: unknown) {
    return this.availability.saveException(parseBody(SaveScheduleException, body) as never);
  }

  @RequirePermission('appointment:update')
  @Audit('SCHEDULE_EXCEPTION_REMOVED', 'clinic')
  @Post('availability/exceptions/:id/remove')
  removeException(@Param('id') id: string) {
    return this.availability.deleteException(requireUuid(id, 'Entry'));
  }

  /* ---- Appointments ------------------------------------------------------ */

  @RequirePermission('appointment:read')
  @Get('appointments')
  list(@Query('from') from?: string, @Query('to') to?: string) {
    return this.scheduling.listAppointments(from, to);
  }

  @RequirePermission('appointment:create')
  @Audit('APPOINTMENT_BOOKED', 'appointment')
  @Post('appointments')
  book(@Body() body: unknown) {
    return this.scheduling.book(parseBody(BookAppointment, body) as never);
  }

  /**
   * The patient is here.
   *
   * Named rather than a raw status PATCH so the audit trail reads as the thing
   * that happened, and so the front desk has one button rather than a dropdown.
   */
  @RequirePermission('appointment:update')
  @Audit('PATIENT_CHECKED_IN', 'appointment')
  @Post('appointments/:id/check-in')
  checkIn(@Param('id') id: string) {
    return this.scheduling.checkIn(requireUuid(id, 'Appointment'));
  }

  /**
   * The visit is closed.
   *
   * Reachable only from FULFILLED — the transition map refuses anything else, so
   * a patient cannot be checked out before the clinician has signed. Returns the
   * billing position so the desk is told, in the same response, whether anything
   * is still owed.
   */
  @RequirePermission('appointment:update')
  @Audit('PATIENT_CHECKED_OUT', 'appointment')
  @Post('appointments/:id/check-out')
  checkOut(@Param('id') id: string) {
    return this.scheduling.checkOut(requireUuid(id, 'Appointment'));
  }

  /** What this visit owes. Read on its own so the desk can check before closing. */
  @RequirePermission('invoice:read')
  @SkipAudit()
  @Get('appointments/:id/billing')
  billing(@Param('id') id: string) {
    return this.scheduling.billingPositionFor(requireUuid(id, 'Appointment'));
  }

  /**
   * Moves or resizes an appointment — what a drag on the calendar does.
   *
   * Audited as a reschedule, not a status change: "moved to Thursday 11:00" and
   * "marked no-show" are different facts and must not share a trail entry.
   */
  @RequirePermission('appointment:update')
  @Audit('APPOINTMENT_RESCHEDULED', 'appointment')
  @Patch('appointments/:id/schedule')
  reschedule(@Param('id') id: string, @Body() body: unknown) {
    const input = parseBody(RescheduleAppointment, body);
    return this.scheduling.reschedule(requireUuid(id, 'Appointment'), input);
  }

  @RequirePermission('appointment:update')
  @Audit('APPOINTMENT_STATUS_CHANGED', 'appointment')
  @Patch('appointments/:id/status')
  changeStatus(
    @Param('id') id: string,
    @Body() body: { status: never; cancelledReason?: string | null },
  ) {
    return this.scheduling.changeStatus(
      requireUuid(id, 'Appointment'),
      body.status,
      body.cancelledReason ?? null,
    );
  }
}
