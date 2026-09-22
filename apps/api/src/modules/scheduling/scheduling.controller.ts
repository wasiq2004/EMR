import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AddToQueue, BookAppointment } from '@emr/contracts';
import { Audit, RequirePermission, SkipAudit } from '../../common/http/decorators';
import { parseBody, requireUuid } from '../../common/http/zod.pipe';
import { SchedulingService } from './scheduling.service';

@Controller()
export class SchedulingController {
  constructor(private readonly scheduling: SchedulingService) {}

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
