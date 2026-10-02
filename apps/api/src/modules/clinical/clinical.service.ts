import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { and, asc, desc, eq, or, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import {
  interpretVital,
  vitalFor,
  type DiagnosisCatalogueItem,
  type Encounter,
} from '@emr/contracts';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { RemindersService } from '../reminders/reminders.service';
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
    /*
     * Forward-referenced for the same reason.
     *
     * RemindersModule imports MessagingModule and PlatformModule and does not
     * import this one, so there is no cycle — but the resolution order is a
     * registration detail, and `forwardRef` makes that irrelevant rather than
     * something to keep an eye on.
     */
    @Inject(forwardRef(() => RemindersService))
    private readonly reminders: RemindersService,
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

      /*
       * The follow-up reminder is scheduled here, in this transaction.
       *
       * Same placement and same reasoning as the pharmacy enqueue above: a
       * signed consultation must not be able to exist without its reminder
       * scheduled, and a signing that fails must not leave a reminder behind. A
       * job that ran afterwards would leave both failure modes open.
       *
       * NOT while the draft is being typed. `follow_up_after_days` autosaves
       * every few seconds, so scheduling on change would create and cancel
       * reminders as the doctor edited the number — with a real chance of
       * sending one before they had finished deciding.
       *
       * Most consultations schedule nothing: no follow-up was set, or the clinic
       * has reminders off. Those are ordinary outcomes rather than failures, so
       * this returns a reason instead of throwing.
       */
      const reminderSettings = await this.reminders.settingsFor(tx);
      await this.reminders.scheduleFollowUp(
        tx,
        {
          id: finalised!.id,
          clinicId: ctx.clinicId,
          patientId: finalised!.patientId,
          followUpAfterDays: finalised!.followUpAfterDays,
        },
        reminderSettings,
      );

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

  /**
   * Records one measurement.
   *
   * THE REFERENCE RANGE AND THE INTERPRETATION ARE DERIVED HERE, from the LOINC
   * code, and whatever the caller sent for them is ignored. Two reasons. A
   * browser running last month's build would otherwise stamp last month's
   * thresholds onto today's records with nothing to show which. And "is this
   * reading dangerous" is a clinical assertion: a field that says only what the
   * caller chose to claim is useless as a filter and worse than absent on a
   * record somebody later relies on.
   *
   * This method already read `referenceLow`, `referenceHigh` and
   * `interpretation` off `input` — but `RecordObservation` never declared them,
   * so `parseBody` stripped all three and every observation ever written got
   * null. A systolic of 210 was stored with nothing marking it abnormal, while
   * the contract's own comment said the interpretation was "computed at write
   * time and surfaced on the Snapshot".
   */
  async recordObservation(input: Record<string, unknown>) {
    const ctx = TenantContext.require();

    const code = String(input.code);
    const vital = vitalFor(code);

    const numeric =
      input.valueNumeric === null || input.valueNumeric === undefined
        ? null
        : Number(input.valueNumeric);

    return this.tenantDb.run(async (tx) => {
      const [created] = await tx
        .insert(schema.observation)
        .values({
          clinicId: ctx.clinicId,
          patientId: String(input.patientId),
          encounterId: (input.encounterId as string) ?? null,
          code,
          display: vital?.display ?? String(input.display),
          valueNumeric: numeric === null ? null : String(numeric),
          /*
           * The unit belongs to the measure, not to the entry.
           *
           * A known vital always gets its own unit, so a caller cannot file a
           * weight in pounds under a kilogram code — which is not a data-entry
           * error that shows up as a validation message, it is a dose later
           * calculated on the wrong body weight.
           */
          valueUnit: vital?.unit ?? ((input.valueUnit as string) ?? null),
          valueText: (input.valueText as string) ?? null,
          referenceLow: vital?.low == null ? null : String(vital.low),
          referenceHigh: vital?.high == null ? null : String(vital.high),
          interpretation: numeric === null ? null : interpretVital(code, numeric),
          /*
           * When it was TAKEN, not when it was typed. A nurse entering a set of
           * vitals twenty minutes later is recording what the patient was at
           * the bedside; a trend built from entry times is a trend of how busy
           * the front desk was.
           */
          effectiveAt: input.effectiveAt ? new Date(String(input.effectiveAt)) : new Date(),
          recordedBy: ctx.userId,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();
      return created;
    });
  }


  /* --- The diagnosis catalogue -------------------------------------------- */

  /**
   * Codes matching what the doctor has typed.
   *
   * MIRRORS THE DRUG SEARCH exactly, including the prefix-then-trigram ordering
   * and the usage weighting, because the two run under the same fingers and a
   * typeahead that behaves differently from the one above it is a typeahead
   * people stop trusting.
   *
   * Three things are deliberate:
   *
   * 1. It searches `search_normalized`, which holds the display text, the code
   *    and the clinic's own synonyms. "URTI" has to find the entry; "Acute upper
   *    respiratory infection" is what gets recorded.
   * 2. Codes THIS CLINIC HAS ACTUALLY USED sort first. A GP sees the same thirty
   *    diagnoses most weeks, and a list that learns them is the difference
   *    between coding and not bothering.
   * 3. It returns at most a dozen rows and never says "no matches, try again".
   *    The caller always has the free-text path — see `DiagnosisCatalogueItem`.
   */
  async searchDiagnoses(term: string, limit = 12): Promise<DiagnosisCatalogueItem[]> {
    const q = term.trim().toLowerCase();
    const ctx = TenantContext.require();

    /*
     * The same string, safe to drop into a POSIX regex.
     *
     * Codes contain dots — "J02.9" — and an unescaped dot matches any
     * character, so searching for J02.9 would also rank J02X9 as an exact word.
     * Everything in the POSIX metacharacter set is escaped rather than just the
     * dot, because the next person to search for "(" should get no matches
     * instead of a 500 from a malformed regex.
     */
    const rx = q.replace(/[.^$*+?()[\]{}|\\-]/g, '\\$&');

    return this.tenantDb.runReadOnly(async (tx) => {
      /*
       * What this clinic records most, by display text.
       *
       * Counted over `condition` rather than over the catalogue, because the
       * catalogue has no idea what gets used — and the point is to learn this
       * clinic's habits, not the deployment's.
       */
      const used = await tx.execute<{ display_text: string; uses: number }>(sql`
        SELECT display_text, count(*)::int AS uses
        FROM condition
        GROUP BY display_text
        ORDER BY uses DESC
        LIMIT 60
      `);
      const useCount = new Map(
        (used.rows ?? []).map((r) => [r.display_text?.toLowerCase(), Number(r.uses)]),
      );

      const found =
        q.length < 2
          ? await tx
              .select()
              .from(schema.diagnosisCatalogueItem)
              .where(eq(schema.diagnosisCatalogueItem.isActive, true))
              .orderBy(asc(schema.diagnosisCatalogueItem.displayText))
              .limit(limit)
          : await tx
              .select()
              .from(schema.diagnosisCatalogueItem)
              .where(
                and(
                  eq(schema.diagnosisCatalogueItem.isActive, true),
                  or(
                    sql`${schema.diagnosisCatalogueItem.searchNormalized} ILIKE ${'%' + q + '%'}`,
                    sql`${schema.diagnosisCatalogueItem.searchNormalized} % ${q}`,
                  ),
                ),
              )
              .orderBy(
                /*
                 * Ranked on WORD boundaries, not on the start of the string.
                 *
                 * This is the difference between a usable typeahead and an
                 * irritating one. A doctor typing "urti" wants J06.9, upper
                 * respiratory infection, which is among the commonest
                 * diagnoses in an Indian OPD — but "urti" is a mid-string
                 * synonym there, while "urticaria" happens to START with those
                 * four letters. Ranking by string prefix put a rare skin
                 * complaint above the thing they meant, every time.
                 *
                 * So: an exact whole word first, then a word that begins with
                 * what was typed, then anything containing it, then the trigram
                 * guess. A prefix match is what the typist meant; a trigram
                 * match is the database being helpful.
                 */
                sql`CASE
                      WHEN ${schema.diagnosisCatalogueItem.searchNormalized} ~ ${'(^| )' + rx + '( |$)'} THEN 0
                      WHEN ${schema.diagnosisCatalogueItem.searchNormalized} ~ ${'(^| )' + rx} THEN 1
                      WHEN ${schema.diagnosisCatalogueItem.searchNormalized} LIKE ${'%' + q + '%'} THEN 2
                      ELSE 3
                    END`,
                sql`similarity(${schema.diagnosisCatalogueItem.searchNormalized}, ${q}) DESC`,
                asc(schema.diagnosisCatalogueItem.displayText),
              )
              .limit(limit * 2);

      const mapped = found.map((item) => ({
        id: item.id,
        code: item.code,
        codeSystem: item.codeSystem,
        displayText: item.displayText,
        category: item.category,
        isChronicByDefault: item.isChronicByDefault,
        // Rows under the system tenant are the shared set; anything else is
        // this clinic's own addition.
        isOwn: item.clinicId === ctx.clinicId,
        uses: useCount.get(item.displayText.toLowerCase()) ?? 0,
      }));

      /*
       * Re-sorted in JS rather than in SQL.
       *
       * The usage count comes from a separate query over `condition`, so the
       * database cannot order by it without a join that would make the trigram
       * index useless. Sorting a dozen rows here costs nothing.
       */
      return mapped
        .sort((a, b) => b.uses - a.uses)
        .slice(0, limit) as unknown as DiagnosisCatalogueItem[];
    });
  }

  /**
   * Adds a code this clinic uses and the shared set does not have.
   *
   * Under the clinic's OWN tenant. Migration `0011` asserts that no write policy
   * admits the system tenant, so this cannot reach the shared rows even by
   * mistake — one clinic renaming a diagnosis must not rename it for every
   * clinic on the deployment.
   */
  async addDiagnosisCode(input: {
    code: string;
    codeSystem: string;
    displayText: string;
    category?: string | null;
    isChronicByDefault: boolean;
    synonyms?: string | null;
  }) {
    const ctx = TenantContext.require();

    const searchNormalized = [input.displayText, input.code, input.synonyms ?? '']
      .join(' ')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    return this.tenantDb.run(async (tx) => {
      const [created] = await tx
        .insert(schema.diagnosisCatalogueItem)
        .values({
          clinicId: ctx.clinicId,
          code: input.code,
          codeSystem: input.codeSystem,
          displayText: input.displayText,
          searchNormalized,
          category: input.category ?? null,
          isChronicByDefault: input.isChronicByDefault,
          catalogueVersion: 'clinic',
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        /*
         * Adding the same wording twice returns the existing row rather than an
         * error. Two doctors in the same clinic reaching for the same missing
         * code on the same morning is the expected case, not a conflict either
         * of them should have to resolve.
         */
        .onConflictDoNothing({
          target: [
            schema.diagnosisCatalogueItem.clinicId,
            schema.diagnosisCatalogueItem.code,
            schema.diagnosisCatalogueItem.displayText,
          ],
        })
        .returning();

      if (created) return created;

      const [existing] = await tx
        .select()
        .from(schema.diagnosisCatalogueItem)
        .where(
          and(
            eq(schema.diagnosisCatalogueItem.code, input.code),
            eq(schema.diagnosisCatalogueItem.displayText, input.displayText),
          ),
        )
        .limit(1);
      return existing!;
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
