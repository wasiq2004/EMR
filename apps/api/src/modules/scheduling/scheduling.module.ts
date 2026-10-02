import { Module } from '@nestjs/common';
import { SchedulingController } from './scheduling.controller';
import { SchedulingService } from './scheduling.service';
import { AvailabilityService } from './availability.service';
import { CalendarService } from './calendar.service';

@Module({
  controllers: [SchedulingController],
  providers: [SchedulingService, AvailabilityService, CalendarService],
  exports: [SchedulingService, AvailabilityService, CalendarService],
})
export class SchedulingModule {}
