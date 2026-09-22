import { Module } from '@nestjs/common';
import { PrescribingController } from './prescribing.controller';
import { PrescribingService } from './prescribing.service';

@Module({
  controllers: [PrescribingController],
  providers: [PrescribingService],
  exports: [PrescribingService],
})
export class PrescribingModule {}
