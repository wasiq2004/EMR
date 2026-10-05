import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq, or, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import { expandFrequency } from '@emr/contracts';
import type { DrugCatalogueItem, MedicationRequest } from '@emr/contracts';
import { SYSTEM_CLINIC_ID } from '@emr/db/schema';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { evaluateSafety } from './safety';

/**
 * Prescribing.
 *
 * WHAT THE CATALOGUE SUPPORTS, AND WHAT IT DOES NOT. This ships with the pilot
 * drug list: search, allergy cross-checking against the clinic's own records
 * (computed on the server — see `safety.ts`),
 * and duplicate-therapy detection. It does NOT support drug-to-drug interaction
 * checking, contraindication-against-condition, weight-based paediatric dosing
 * or pregnancy category — those need a licensed formulary that has not been
 * procured.
 *
 * The rule that follows is absolute and is enforced in the UI as well as here:
 * where a check cannot run, nothing about it appears on screen. A doctor who
 * believes interactions are being checked and sees no warning is in a worse
 * position than one who knows there is no check.
 */
@Injectable()
export class PrescribingService {
  constructor(private readonly tenantDb: TenantDb) {}

  /**
   * Drug search.
   *
   * Clinic favourites first, learned from prescribing history: a GP prescribes
   * from perhaps 150 drugs, and surfacing those first is the difference between
   * twenty seconds and five per line — which compounds across a 40-patient day.
   */
  async searchDrugs(term: string, limit = 12): Promise<DrugCatalogueItem[]> {
    const q = term.trim().toLowerCase();

    const rows = await this.tenantDb.runReadOnly(async (tx) => {
      const favourites = await tx.execute<{ molecule_name: string; uses: number }>(sql`
        SELECT molecule_name, count(*) AS uses FROM medication_request
        WHERE molecule_name IS NOT NULL
        GROUP BY molecule_name ORDER BY uses DESC LIMIT 40
      `);
      const favouriteSet = new Set(
        (favourites.rows ?? []).map((r) => r.molecule_name?.toLowerCase()),
      );

      const found = q.length < 2
        ? await tx
            .select()
            .from(schema.drugCatalogueItem)
            .where(eq(schema.drugCatalogueItem.isActive, true))
            .limit(limit)
        : await tx
            .select()
            .from(schema.drugCatalogueItem)
            .where(
              and(
                eq(schema.drugCatalogueItem.isActive, true),
                or(
                  sql`${schema.drugCatalogueItem.searchNormalized} ILIKE ${'%' + q + '%'}`,
                  sql`${schema.drugCatalogueItem.searchNormalized} % ${q}`,
                ),
              ),
            )
            .orderBy(
              sql`CASE WHEN ${schema.drugCatalogueItem.searchNormalized} ILIKE ${q + '%'} THEN 0 ELSE 1 END`,
              sql`similarity(${schema.drugCatalogueItem.searchNormalized}, ${q}) DESC`,
            )
            .limit(limit);

      return found.map((drug) => ({
        ...drug,
        isFavourite: favouriteSet.has(drug.moleculeName.toLowerCase()),
      }));
    });

    // Favourites float to the top of whatever the database returned.
    return rows.sort(
      (a, b) => Number(b.isFavourite) - Number(a.isFavourite),
    ) as unknown as DrugCatalogueItem[];
  }

  async linesFor(encounterId: string): Promise<MedicationRequest[]> {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select()
        .from(schema.medicationRequest)
        .where(eq(schema.medicationRequest.encounterId, encounterId))
        .orderBy(schema.medicationRequest.authoredAt),
    );
    return rows.map(serialiseLine);
  }

  async addLine(encounterId: string, input: Record<string, unknown>): Promise<MedicationRequest> {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const [encounter] = await tx
        .select()
        .from(schema.encounter)
        .where(eq(schema.encounter.id, encounterId))
        .limit(1);
      if (!encounter) throw new NotFoundException('That consultation could not be found.');
      if (encounter.isFinalized) {
        throw new ConflictException(
          'This consultation is signed. Issue a new prescription rather than editing it.',
        );
      }

      /*
       * Safety runs HERE, on the server, and its result is what gets stored.
       *
       * The client sends what it displayed, and that is useful for knowing what
       * the doctor saw — but it is not evidence that a check ran, because a
       * request that simply omits it would otherwise be recorded as clean.
       */
      const warnings = await evaluateSafety(tx, {
        patientId: encounter.patientId,
        encounterId,
        drugDisplayName: String(input.drugDisplayName),
        moleculeName: (input.moleculeName as string) ?? null,
        consultationMode: encounter.consultationMode,
      });

      const overrideReason =
        typeof input.safetyOverrideReason === 'string' && input.safetyOverrideReason.trim()
          ? input.safetyOverrideReason.trim()
          : null;

      /*
       * Two gates, and the order matters.
       *
       * A NON-OVERRIDABLE warning is law, not clinical judgement — Schedule X in
       * a teleconsultation. It is refused first and refused outright, because
       * checking the override reason before it would imply that writing one
       * could help.
       */
      const prohibited = warnings.filter((w) => !w.overridable);
      if (prohibited.length > 0) {
        throw new UnprocessableEntityException({
          code: 'PRESCRIPTION_NOT_PERMITTED',
          title: 'This medicine cannot be prescribed here',
          message: prohibited.map((w) => w.title).join(' '),
          warnings,
        });
      }

      // A blocking warning may be overridden, but not silently. Refusing until
      // a reason is written is the whole mechanism: it puts the decision, and
      // the name of whoever made it, into the record.
      const blocking = warnings.filter(
        (w) => w.severity === 'BLOCKING' && w.overridable,
      );

      if (blocking.length > 0 && !overrideReason) {
        throw new UnprocessableEntityException({
          code: 'SAFETY_WARNING',
          title: 'Check this prescription before continuing',
          message: blocking.map((w) => w.title).join(' '),
          warnings,
        });
      }

      // Catalogue version is stamped on every line, so a later clinical review
      // can establish exactly what reference data was in force at the time.
      const [catalogueVersion] = await tx
        .select({ version: schema.drugCatalogueItem.catalogueVersion })
        .from(schema.drugCatalogueItem)
        .where(eq(schema.drugCatalogueItem.clinicId, SYSTEM_CLINIC_ID))
        .limit(1);

      const [created] = await tx
        .insert(schema.medicationRequest)
        .values({
          clinicId: ctx.clinicId,
          patientId: encounter.patientId,
          encounterId,
          practitionerId: ctx.userId,
          status: 'DRAFT',
          // Nullable by design: a doctor must always be able to prescribe
          // something outside the catalogue.
          catalogueItemId: (input.catalogueItemId as string) ?? null,
          drugDisplayName: String(input.drugDisplayName),
          moleculeName: (input.moleculeName as string) ?? null,
          strength: (input.strength as string) ?? null,
          dosageForm: (input.dosageForm as string) ?? null,
          route: (input.route as string) ?? null,
          frequency: String(input.frequency ?? '1-0-1'),
          timingRelativeToFood: (input.timingRelativeToFood as string) ?? null,
          durationDays: (input.durationDays as number) ?? null,
          quantity: input.quantity == null ? null : String(input.quantity),
          instructions: (input.instructions as string) ?? null,
          // What the system warned about, and what the clinician decided. This
          // is the clinic's evidence of safe practice and the product's
          // evidence of having warned.
          safetyWarningsShown: warnings as never,
          safetyOverrideReason: overrideReason,
          catalogueVersionAtPrescribing: catalogueVersion?.version ?? null,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();

      // The warnings travel back with the created line so the prescription pad
      // can show what was flagged and accepted, rather than only what was
      // flagged and refused.
      return { ...serialiseLine(created!), safetyWarningsShown: warnings } as MedicationRequest;
    });
  }

  /**
   * Changes the dose on a line that is already on the prescription.
   *
   * THE DRUG IS NOT CHANGEABLE HERE, deliberately. Swapping the medicine on an
   * existing line would bypass the allergy and duplicate-therapy evaluation that
   * ran when it was added, and `safetyWarningsShown` would then describe a drug
   * that is no longer on the line — a record that reads as though the checks
   * passed for something they never saw. Changing the medicine means removing
   * the line and adding the right one.
   *
   * This exists because the dose was previously unchangeable too: the panel
   * showed frequency, timing and duration as read-only chips, so a mis-set dose
   * could only be fixed by deleting the line and starting again.
   */
  async reviseDosage(
    lineId: string,
    input: {
      frequency: string;
      timingRelativeToFood?: 'BEFORE_FOOD' | 'AFTER_FOOD' | 'WITH_FOOD' | null;
      durationDays?: number | null;
      quantity?: number | null;
      instructions?: string | null;
      route?: string | null;
    },
  ) {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const [line] = await tx
        .select()
        .from(schema.medicationRequest)
        .where(eq(schema.medicationRequest.id, lineId))
        .limit(1);
      if (!line) throw new NotFoundException('That medicine could not be found.');

      const [encounter] = await tx
        .select()
        .from(schema.encounter)
        .where(eq(schema.encounter.id, line.encounterId))
        .limit(1);

      /*
       * A signed prescription is immutable.
       *
       * The same rule `removeLine` enforces, and for the same reason: the
       * patient is holding a printed copy and the pharmacy may already have
       * dispensed against it. A correction to a signed prescription is a new
       * prescription, not an edit to the old one.
       */
      if (encounter?.isFinalized) {
        throw new ConflictException(
          'This prescription is signed. Issue a new one rather than changing a dose.',
        );
      }

      const [updated] = await tx
        .update(schema.medicationRequest)
        .set({
          frequency: expandFrequency(input.frequency),
          timingRelativeToFood: input.timingRelativeToFood ?? null,
          durationDays: input.durationDays ?? null,
          quantity: input.quantity == null ? null : String(input.quantity),
          instructions: input.instructions ?? null,
          route: input.route ?? line.route,
          version: line.version + 1,
          updatedBy: ctx.userId,
        })
        .where(eq(schema.medicationRequest.id, lineId))
        .returning();

      return updated!;
    });
  }

  /**
   * Adds a drug this clinic stocks that the shared catalogue does not have.
   *
   * Under the clinic's OWN tenant. The shared rows belong to a reserved tenant
   * that no clinic can write to — migration `0013` asserts that no write policy
   * admits it — so one clinic adding "Mox 500" cannot change what every other
   * clinic on the deployment sees.
   *
   * `catalogueVersion` is 'clinic' rather than a release identifier, which is
   * how a prescription written against it later reads as having come from the
   * clinic's own list rather than from a formulary release.
   */
  async addToCatalogue(input: {
    brandName?: string | null;
    moleculeName: string;
    strength?: string | null;
    dosageForm?: string | null;
    route?: string | null;
    manufacturer?: string | null;
    drugSchedule?: 'H' | 'H1' | 'X' | null;
  }) {
    const ctx = TenantContext.require();

    const searchNormalized = [input.brandName ?? '', input.moleculeName, input.strength ?? '']
      .join(' ')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    return this.tenantDb.run(async (tx) => {
      /*
       * Already present is not an error.
       *
       * Two doctors in the same clinic reaching for the same missing drug on the
       * same morning is the expected case, not a conflict either of them should
       * have to resolve. Matched on the normalised search text rather than on
       * the brand, so "Mox 500" and "mox  500" are the same row.
       */
      const [existing] = await tx
        .select()
        .from(schema.drugCatalogueItem)
        .where(
          and(
            eq(schema.drugCatalogueItem.clinicId, ctx.clinicId),
            eq(schema.drugCatalogueItem.searchNormalized, searchNormalized),
          ),
        )
        .limit(1);
      if (existing) return existing;

      const [created] = await tx
        .insert(schema.drugCatalogueItem)
        .values({
          clinicId: ctx.clinicId,
          brandName: input.brandName ?? null,
          moleculeName: input.moleculeName,
          searchNormalized,
          strength: input.strength ?? null,
          dosageForm: input.dosageForm ?? null,
          route: input.route ?? null,
          manufacturer: input.manufacturer ?? null,
          /*
           * Null rather than a default of 'H'.
           *
           * The seeded list defaults to H because every drug on it was checked.
           * A clinic's own row has not been, and claiming a schedule nobody
           * verified is worse than claiming none: Schedule X carries a
           * telemedicine prohibition the server enforces, and a wrong value
           * either blocks a legitimate prescription or waves through one the law
           * forbids.
           */
          drugSchedule: input.drugSchedule ?? null,
          isNarcotic: input.drugSchedule === 'X',
          catalogueVersion: 'clinic',
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();

      return created!;
    });
  }

  async removeLine(lineId: string): Promise<void> {
    await this.tenantDb.run(async (tx) => {
      const [line] = await tx
        .select()
        .from(schema.medicationRequest)
        .where(eq(schema.medicationRequest.id, lineId))
        .limit(1);
      if (!line) throw new NotFoundException('That medicine could not be found.');

      const [encounter] = await tx
        .select()
        .from(schema.encounter)
        .where(eq(schema.encounter.id, line.encounterId))
        .limit(1);

      if (encounter?.isFinalized) {
        throw new ConflictException(
          'This prescription is signed. Issue a new one rather than removing a line.',
        );
      }

      await tx.delete(schema.medicationRequest).where(eq(schema.medicationRequest.id, lineId));
    });
  }

  /** Reusable medicine combinations, per doctor or shared across the clinic. */
  async prescriptionTemplates() {
    return this.tenantDb.runReadOnly((tx) =>
      tx
        .select()
        .from(schema.prescriptionTemplate)
        .where(eq(schema.prescriptionTemplate.isActive, true))
        .orderBy(sql`${schema.prescriptionTemplate.usageCount} DESC`),
    );
  }

  async encounterTemplates() {
    return this.tenantDb.runReadOnly((tx) =>
      tx
        .select()
        .from(schema.encounterTemplate)
        .where(eq(schema.encounterTemplate.isActive, true))
        .orderBy(sql`${schema.encounterTemplate.usageCount} DESC`),
    );
  }
}

function serialiseLine(row: typeof schema.medicationRequest.$inferSelect): MedicationRequest {
  return {
    ...row,
    quantity: row.quantity === null ? null : Number(row.quantity),
    authoredAt: row.authoredAt.toISOString(),
  } as unknown as MedicationRequest;
}
