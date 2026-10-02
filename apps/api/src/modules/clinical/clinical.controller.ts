import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import {
  AddDiagnosisCode,
  AmendEncounter,
  RecordAllergy,
  RecordCondition,
  RecordObservation,
} from '@emr/contracts';
import { Audit, RequirePermission, SkipAudit } from '../../common/http/decorators';
import { parseBody, requireUuid } from '../../common/http/zod.pipe';
import { ClinicalService } from './clinical.service';

@Controller()
export class ClinicalController {
  constructor(private readonly clinical: ClinicalService) {}

  /* --- Encounters --------------------------------------------------------- */

  @RequirePermission('encounter:create')
  @Audit('ENCOUNTER_OPENED', 'encounter')
  @Post('encounters')
  open(
    @Body()
    body: {
      patientId: string;
      appointmentId?: string | null;
      consultationMode?: 'IN_PERSON' | 'TELECONSULTATION';
    },
  ) {
    return this.clinical.openEncounter(
      requireUuid(body?.patientId, 'Patient'),
      body?.appointmentId ?? null,
      // Anything other than the explicit remote value is in person. An unknown
      // string must not be able to turn the Schedule X prohibition off.
      body?.consultationMode === 'TELECONSULTATION' ? 'TELECONSULTATION' : 'IN_PERSON',
    );
  }

  /** Metadata only. Reception can see that a visit happened, not what was said. */
  @RequirePermission('encounter:read')
  @Get('encounters/:id')
  byId(@Param('id') id: string) {
    return this.clinical.byId(requireUuid(id, 'Consultation'));
  }

  @RequirePermission('encounterClinicalContent:update')
  @Audit('ENCOUNTER_UPDATED', 'encounter')
  @Patch('encounters/:id')
  update(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.clinical.updateDraft(
      requireUuid(id, 'Consultation'),
      body ?? {},
      ifMatch ? Number(ifMatch) : undefined,
    );
  }

  /**
   * DOCTOR only, and only with a registration number on file. Both gates are in
   * the guard; this route simply declares the permission that triggers them.
   */
  @RequirePermission('encounter:finalize')
  @Audit('ENCOUNTER_FINALIZED', 'encounter')
  @Post('encounters/:id/finalise')
  finalise(@Param('id') id: string, @Headers('if-match') ifMatch?: string) {
    return this.clinical.finalise(
      requireUuid(id, 'Consultation'),
      ifMatch ? Number(ifMatch) : undefined,
    );
  }

  @RequirePermission('encounterClinicalContent:create')
  @Audit('ENCOUNTER_AMENDED', 'encounter')
  @Post('encounters/:id/amend')
  amend(@Param('id') id: string, @Body() body: unknown) {
    const input = parseBody(AmendEncounter.omit({ encounterId: true }), body);
    return this.clinical.amend(requireUuid(id, 'Consultation'), input.amendmentReason);
  }

  /* --- Internal notes ------------------------------------------------------ */

  @RequirePermission('internalNote:read')
  @Get('encounters/:id/internal-notes')
  notes(@Param('id') id: string) {
    return this.clinical.internalNotes(requireUuid(id, 'Consultation'));
  }

  @RequirePermission('internalNote:create')
  @Post('encounters/:id/internal-notes')
  addNote(@Param('id') id: string, @Body() body: { note: string; patientId: string }) {
    return this.clinical.addInternalNote(
      requireUuid(id, 'Consultation'),
      requireUuid(body?.patientId, 'Patient'),
      String(body?.note ?? '').trim(),
    );
  }

  /* --- Structured clinical data -------------------------------------------- */

  @RequirePermission('observation:create')
  @Post('observations')
  observation(@Body() body: unknown) {
    return this.clinical.recordObservation(parseBody(RecordObservation, body) as never);
  }

  @RequirePermission('condition:create')
  @Post('conditions')
  condition(@Body() body: unknown) {
    return this.clinical.recordCondition(parseBody(RecordCondition, body) as never);
  }

  /* --- The diagnosis catalogue -------------------------------------------- */

  /**
   * Codes matching what is being typed.
   *
   * `condition:read` rather than `condition:create`, because looking a code up
   * is reading reference data. That gives it to the doctor, the nurse and the
   * administrator — the nurse can see what a code means without being able to
   * record a diagnosis, which is the split that matters. Reception holds
   * neither and has no reason to search diagnoses.
   *
   * Exempt from the audit trail: it fires on every keystroke, it reads a
   * reference list rather than anybody's record, and it would otherwise
   * dominate the table — the same reason the drug search is exempt.
   */
  @RequirePermission('condition:read')
  @SkipAudit()
  @Get('diagnoses/search')
  async searchDiagnoses(@Query('q') q?: string, @Query('limit') limit?: string) {
    const parsed = Number(limit);
    return {
      items: await this.clinical.searchDiagnoses(
        q ?? '',
        Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 40) : 12,
      ),
    };
  }

  /**
   * Adds a code this clinic uses that the shared set does not have.
   *
   * `clinic:update`, not `condition:create`. Recording a diagnosis on a patient
   * is clinical work every doctor does; adding to the clinic's code list changes
   * what everybody in the clinic is offered from then on, which is
   * configuration.
   */
  @RequirePermission('clinic:update')
  @Audit('DIAGNOSIS_CODE_ADDED', 'clinic')
  @Post('diagnoses')
  addDiagnosisCode(@Body() body: unknown) {
    return this.clinical.addDiagnosisCode(parseBody(AddDiagnosisCode, body));
  }

  @RequirePermission('encounter:read')
  @Get('patients/:id/visits')
  visits(@Param('id') id: string) {
    return this.clinical.visitsFor(requireUuid(id, 'Patient'));
  }

  @RequirePermission('allergy:read')
  @Get('patients/:id/allergies')
  allergies(@Param('id') id: string) {
    return this.clinical.allergiesFor(requireUuid(id, 'Patient'));
  }

  /**
   * Nurses hold this deliberately: they are usually the person who asks the
   * question at triage, and blocking them means the allergy is never recorded.
   */
  @RequirePermission('allergy:create')
  @Audit('ALLERGY_RECORDED', 'allergy')
  @Post('patients/:id/allergies')
  recordAllergy(@Param('id') id: string, @Body() body: unknown) {
    const patientId = requireUuid(id, 'Patient');
    const input = parseBody(RecordAllergy.omit({ patientId: true }), body);
    return this.clinical.recordAllergy(patientId, input as never);
  }
}
