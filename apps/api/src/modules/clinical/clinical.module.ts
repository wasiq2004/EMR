import { Module, forwardRef } from '@nestjs/common';
import { ClinicalController } from './clinical.controller';
import { ClinicalService } from './clinical.service';
import { PharmacyModule } from '../pharmacy/pharmacy.module';

/**
 * `forwardRef` on PharmacyModule.
 *
 * Finalising a consultation queues its prescription at the pharmacy counter, so
 * this module needs DispensingService. PharmacyModule does not need anything from
 * here, so the dependency is one-way — but both are registered in AppModule and
 * Nest resolves them in declaration order, which is not a thing this file should
 * have to know about. The forward reference makes the order irrelevant.
 */
@Module({
  imports: [forwardRef(() => PharmacyModule)],
  controllers: [ClinicalController],
  providers: [ClinicalService],
  exports: [ClinicalService],
})
export class ClinicalModule {}
