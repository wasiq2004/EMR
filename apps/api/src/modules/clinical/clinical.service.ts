import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import type { Encounter } from '@emr/contracts';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { AuditWriter } from '../../common/audit/audit.writer';
import { FeatureGuard } from '../../common/features/feature.guard';
import { DispensingService } from '../pharmacy/dispensing.service';

/**
 * The clinical record.
 *
 * Finalisation is the critical transition. Once an encounter is finalised its
 * clinical content is frozen — enforced by a database trigger, not only here,
 * because an EMR whose past records can be silently rewritten has no
 * evidentiary value. Corrections append as a linked amendment.
 */
@Injectable()
export class ClinicalService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditWriter,
    private readonly features: FeatureGuard,
    /**
     * Forward-referenced.
     *
     * PharmacyModule exports DispensingService and does not import this module,
     * so there is no cycle — but Nest resolves the two in an order that depends
     * on registration, and `forwardRef` makes that irrelevant rather than
     * fragile.
     */
    @Inject(forwardRef(() => DispensingService))
    private readonly dispensing: DispensingService,
  ) {}

  /** Opens a consultation, or returns the draft already open for this patient. */
  async openEncounter(
    patientId: string,
    appointmentId: string | null,
    consultationMode: 'IN_PERSON' | 'TELECONSULTATION' = 'IN_PERSON',
  ): Promise<Encounter> {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.encounter)
        .where(
          and(
            eq(schema.encounter.patientId, patientId),
            eq(schema.encounter.isFinalized, false),
            eq(schema.encounter.status, 'IN_PROGRESS'),
          ),
        )
        .limit(1);

      if (existing) return serialise(existing);

      const [created] = await tx
        .insert(schema.encounter)
        .values({
          clinicId: ctx.clinicId,
          patientId,
          practitionerId: ctx.userId,
          appointmentId,
          status: 'IN_PROGRESS',
          // Decides whether the Schedule X prohibition applies and whether the
          // printed prescription carries the teleconsultation declaration.
          consultationMode,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();

      if (appointmentId) {
        await tx
          .update(schema.appointment)
          .set({ status: 'IN_PROGRESS', calledAt: new Date(), updatedBy: ctx.userId })
          .where(eq(schema.appointment.id, appointmentId));
      }

      return serialise(created!);
    });
  }

  async byId(id: string): Promise<Encounter> {
    const row = await this.tenantDb.runReadOnly(async (tx) => {
      const [found] = await tx
        .select()
        .from(schema.encounter)
        .where(eq(schema.encounter.id, id))
        .limit(1);
      return found;
    });
    if (!row) throw new NotFoundException('That consultation could not be found.');
    return serialise(row);
  }

  async updateDraft(id: string, patch: Record<string, unknown>, version?: number) {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.encounter)
        .where(eq(schema.encounter.id, id))
        .limit(1);
      if (!current) throw new NotFoundException('That consultation could not be found.');

      if (current.isFinalized) {
        throw new ConflictException(
          'This consultation is signed and cannot be edited. Create an amendment instead.',
        );
      }
      if (version !== undefined && version !== current.version) {
        throw new ConflictException(
          'Someone else changed this consultation while you were writing. Reload before saving.',
        );
      }

      const allowed: Record<string, unknown> = { updatedBy: ctx.userId };
      for (const key of [
        'chiefComplaint', 'historyOfPresentIllness', 'examinationNotes',
        'assessmentNotes', 'planNotes', 'followUpAfterDays', 'followUpInstructions',
      ]) {
        if (key in patch) allowed[key] = patch[key];
      }

      /*
       * Consultation mode is editable while the consultation is a draft — a
       * doctor may open a visit and only then move it to a video call — but it
       * is narrowed to the two valid values here rather than trusted from the
       * body. Anything else would let a request turn the Schedule X prohibition
       * off by sending a third string.
       */
      if ('consultationMode' in patch) {
        allowed.consultationMode =
          patch.consultationMode === 'TELECONSULTATION' ? 'TELECONSULTATION' : 'IN_PERSON';
      }

      const [updated] = await tx
        .update(schema.encounter)
        .set(allowed)
        .where(eq(schema.encounter.id, id))
        .returning();

      return serialise(updated!);
    });
  }

  /**
   * Sign and finalise.
   *
   * Only a DOCTOR reaches this — the guard enforces that, and additionally that
   * a medical registration number is on file, because it is a legally required
   * element of the prescription and would otherwise print blank.
   */
  async finalise(id: string, version?: number): Promise<Encounter> {
    const ctx = TenantContext.require();

    const encounter = await this.tenantDb.run(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.encounter)
        .where(eq(schema.encounter.id, id))
        .limit(1);
      if (!current) throw new NotFoundException('That consultation could not be found.');
      if (current.isFinalized) {
        throw new ConflictException('This consultation has already been signed.');
      }
      if (current.practitionerId !== ctx.userId && ctx.role !== 'OWNER_ADMIN') {
        throw new ForbiddenException(
          'Only the clinician who recorded this consultation can sign it.',
        );
      }
      if (version !== undefined && version !== current.version) {
        throw new ConflictException('This consultation changed. Reload before signing.');
      }

      const [finalised] = await tx
        .update(schema.encounter)
        .set({
          isFinalized: true,
          finalizedAt: new Date(),
          finalizedBy: ctx.userId,
          status: 'FINISHED',
          endedAt: new Date(),
          updatedBy: ctx.userId,
        })
        .where(eq(schema.encounter.id, id))
        .returning();

      // Draft lines become the live prescription at the moment of signing.
      await tx
        .update(schema.medicationRequest)
        .set({ status: 'ACTIVE', updatedBy: ctx.userId })
        .where(
          and(
            eq(schema.medicationRequest.encounterId, id),
            eq(schema.medicationRequest.status, 'DRAFT'),
          ),
        );

      if (current.appointmentId) {
        await tx
          .update(schema.appointment)
          .set({ status: 'FULFILLED', completedAt: new Date(), updatedBy: ctx.userId })
          .where(eq(schema.appointment.id, current.appointmentId));
      }

      /*
       * The prescription reaches the pharmacy counter here, in this transaction.
       *
       * This is the blueprint's "zero re-entry" requirement, and the placement is
       * the whole of it: a prescription cannot be signed without appearing at the
       * counter, and cannot appear at the counter if the signing fails. A job
       * that ran afterwards would leave both failure modes open.
       *
       * Conditional on the clinic having a pharmacy. Queueing at a clinic that
       * only prescribes would build a queue nobody works, and switching the
       * module on a year later would surface a thousand prescriptions apparently
       * waiting since last March.
       */
      if (await this.features.clinicHas(ctx.clinicId, 'pharmacy')) {
        await this.dispensing.enqueue(tx, id);
      }

      return finalised!;
    });

    await this.audit.append({
      clinicId: ctx.clinicId,
      actorUserId: ctx.userId,
      actorName: ctx.userName,
      actorRole: ctx.role,
      actorType: 'USER',
      action: 'ENCOUNTER_FINALIZED',
      outcome: 'SUCCESS',
      resourceType: 'encounter',
      resourceId: id,
      patientId: encounter.patientId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });

    return serialise(encounter);
  }

  /** A correction is a NEW record linked to the original, never an edit. */
  async amend(id: string, reason: string): Promise<Encounter> {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const [original] = await tx
        .select()
        .from(schema.encounter)
        .where(eq(schema.encounter.id, id))
        .limit(1);
      if (!original) throw new NotFoundException('That consultation could not be found.');

      const [amendment] = await tx
        .insert(schema.encounter)
        .values({
          clinicId: ctx.clinicId,
          patientId: original.patientId,
          practitionerId: ctx.userId,
          appointmentId: original.appointmentId,
          status: 'IN_PROGRESS',
          chiefComplaint: original.chiefComplaint,
          historyOfPresentIllness: original.historyOfPresentIllness,
          examinationNotes: original.examinationNotes,
          assessmentNotes: original.assessmentNotes,
          planNotes: original.planNotes,
          amendsEncounterId: original.id,
          amendmentReason: reason,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();

      return serialise(amendment!);
    });
  }

  async visitsFor(patientId: string): Promise<Encounter[]> {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select()
        .from(schema.encounter)
        .where(eq(schema.encounter.patientId, patientId))
        .orderBy(desc(schema.encounter.startedAt)),
    );
    return rows.map(serialise);
  }

  /* --- Observations, conditions, allergies ------------------------------- */

  async recordObservation(input: Record<string, unknown>) {
    const ctx = TenantContext.require();
    return this.tenantDb.run(async (tx) => {
      const [created] = await tx
        .insert(schema.observation)
        .values({
          clinicId: ctx.clinicId,
          patientId: String(input.patientId),
          encounterId: (input.encounterId as string) ?? null,
          code: String(input.code),
          display: String(input.display),
          valueNumeric: input.valueNumeric === null || input.valueNumeric === undefined
            ? null
            : String(input.valueNumeric),
          valueUnit: (input.valueUnit as string) ?? null,
          valueText: (input.valueText as string) ?? null,
          referenceLow: input.referenceLow == null ? null : String(input.referenceLow),
          referenceHigh: input.referenceHigh == null ? null : String(input.referenceHigh),
          interpretation: (input.interpretation as string) ?? null,
          recordedBy: ctx.userId,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();
      return created;
    });
  }

  async recordCondition(input: Record<string, unknown>) {
    const ctx = TenantContext.require();
    return this.tenantDb.run(async (tx) => {
      const [created] = await tx
        .insert(schema.condition)
        .values({
          clinicId: ctx.clinicId,
          patientId: String(input.patientId),
          encounterId: (input.encounterId as string) ?? null,
          // Coded OR free text. Refusing to save an uncoded diagnosis is the
          // fastest available way to lose adoption.
          code: (input.code as string) ?? null,
          codeSystem: (input.codeSystem as string) ?? null,
          displayText: String(input.displayText),
          isChronic: Boolean(input.isChronic),
          notes: (input.notes as string) ?? null,
          recordedBy: ctx.userId,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();
      return created;
    });
  }

  async allergiesFor(patientId: string) {
    return this.tenantDb.runReadOnly((tx) =>
      tx
        .select()
        .from(schema.allergyIntolerance)
        .where(eq(schema.allergyIntolerance.patientId, patientId)),
    );
  }

  async recordAllergy(patientId: string, input: Record<string, unknown>) {
    const ctx = TenantContext.require();
    return this.tenantDb.run(async (tx) => {
      const [created] = await tx
        .insert(schema.allergyIntolerance)
        .values({
          clinicId: ctx.clinicId,
          patientId,
          category: (input.category as 'MEDICATION') ?? 'MEDICATION',
          // Risk of a FUTURE reaction. Distinct from how bad a past one was,
          // and this is the field that gates prescribing.
          criticality: (input.criticality as 'HIGH') ?? 'UNABLE_TO_ASSESS',
          substanceText: String(input.substanceText),
          substanceMoleculeId: (input.substanceMoleculeId as string) ?? null,
          reactionDescription: (input.reactionDescription as string) ?? null,
          reactionSeverity: (input.reactionSeverity as 'MILD') ?? null,
          recordedBy: ctx.userId,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();
      return created;
    });
  }

  /* --- Internal notes ----------------------------------------------------- */

  async internalNotes(encounterId: string) {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({ note: schema.encounterInternalNote, author: schema.appUser.fullName })
        .from(schema.encounterInternalNote)
        .leftJoin(schema.appUser, eq(schema.appUser.id, schema.encounterInternalNote.authorId))
        .where(eq(schema.encounterInternalNote.encounterId, encounterId))
        .orderBy(desc(schema.encounterInternalNote.createdAt)),
    );

    return rows.map((row) => ({
      id: row.note.id,
      encounterId: row.note.encounterId,
      patientId: row.note.patientId,
      note: row.note.note,
      authorId: row.note.authorId,
      authorName: row.author ?? 'Unknown',
      createdAt: row.note.createdAt.toISOString(),
    }));
  }

  async addInternalNote(encounterId: string, patientId: string, note: string) {
    const ctx = TenantContext.require();
    return this.tenantDb.run(async (tx) => {
      const [created] = await tx
        .insert(schema.encounterInternalNote)
        .values({
          clinicId: ctx.clinicId,
          encounterId,
          patientId,
          note,
          authorId: ctx.userId,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();

      return {
        ...created!,
        authorName: ctx.userName,
        createdAt: created!.createdAt.toISOString(),
      };
    });
  }
}

export function serialise(row: typeof schema.encounter.$inferSelect): Encounter {
  return {
    ...row,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    finalizedAt: row.finalizedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  } as unknown as Encounter;
}
