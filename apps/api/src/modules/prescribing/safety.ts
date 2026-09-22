/**
 * Prescribing safety checks.
 *
 * WHY THIS IS ON THE SERVER. The browser ran these checks and sent the result
 * with the prescription, and the server stored what it was told. That means the
 * safety check was advisory decoration: any request that omitted
 * `safetyWarningsShown` was accepted without a warning ever being computed, and
 * the stored record then attested that nothing was flagged. The one thing this
 * product must not do is record that it warned when it did not.
 *
 * So the server computes the warnings itself, stores ITS OWN result rather than
 * the client's, and refuses a blocking warning that carries no override reason.
 * The browser still runs the same checks — a warning has to appear before the
 * doctor commits, not after — but the browser's copy is for latency, and this
 * one is the record.
 *
 * WHAT IS CHECKED, AND WHAT IS NOT. Four checks run: an exact allergy match, a
 * drug-class allergy match, duplicate therapy, and the teleconsultation
 * prohibition. Drug-to-drug interactions,
 * contraindication against a condition, weight-based paediatric dosing and
 * pregnancy category are NOT checked, because each needs a licensed formulary
 * that has not been procured.
 *
 * Nothing about an unavailable check appears anywhere — not a disabled control,
 * not a greyed-out panel. A doctor who believes interactions are being checked
 * and sees no warning is worse off than one who knows there is no check.
 *
 * The class table lives in @emr/contracts, not here, because the prescription
 * pad warns on the same table before the doctor commits. Two copies means the
 * browser can warn where the server does not — or, far worse, stay silent where
 * the server would have refused.
 */

import { and, eq, isNull, ne } from 'drizzle-orm';
import {
  classesForNames,
  isTeleconsultationProhibited,
  normaliseDrugName,
} from '@emr/contracts';
import * as schema from '@emr/db/schema';
import type { TenantTx } from '../../common/tenancy/tenant-db.service';

export interface SafetyWarning {
  kind:
    | 'ALLERGY_EXACT'
    | 'ALLERGY_CLASS'
    | 'DUPLICATE_THERAPY'
    | 'SCHEDULE_X_TELEMEDICINE';
  severity: 'BLOCKING' | 'ADVISORY';
  overridable: boolean;
  title: string;
  detail: string;
  substanceText: string | null;
  criticality: 'HIGH' | 'LOW' | 'UNABLE_TO_ASSESS' | null;
  recordedAt: string | null;
}

export async function evaluateSafety(
  tx: TenantTx,
  args: {
    patientId: string;
    encounterId: string;
    drugDisplayName: string;
    moleculeName: string | null;
    consultationMode: 'IN_PERSON' | 'TELECONSULTATION';
  },
): Promise<SafetyWarning[]> {
  const warnings: SafetyWarning[] = [];

  // Both names, because a doctor may prescribe free text with no molecule, and
  // a brand name often carries the molecule inside it.
  const candidateTerms = [args.moleculeName, args.drugDisplayName]
    .filter((t): t is string => Boolean(t))
    .map(normaliseDrugName);
  const candidateClasses = classesForNames(candidateTerms);

  /* ---- Allergies ------------------------------------------------------- */

  const allergies = await tx
    .select()
    .from(schema.allergyIntolerance)
    .where(
      and(
        eq(schema.allergyIntolerance.patientId, args.patientId),
        // A refuted allergy is one a clinician has since ruled out. Warning on
        // it anyway is how a record of careful practice becomes noise.
        isNull(schema.allergyIntolerance.refutedAt),
      ),
    );

  for (const allergy of allergies) {
    if (allergy.category !== 'MEDICATION') continue;

    const substance = normaliseDrugName(allergy.substanceText ?? '');
    if (!substance) continue;

    const exact = candidateTerms.some(
      (term) => term.includes(substance) || substance.includes(term),
    );

    const sharedClass = exact
      ? null
      : (classesForNames([substance]).find((c) => candidateClasses.includes(c)) ?? null);

    if (!exact && !sharedClass) continue;

    /*
     * HIGH criticality blocks; anything else advises.
     *
     * Blocking still means overridable. A doctor may have a reason the record
     * does not know — a documented desensitisation, a mild reaction recorded
     * years ago as severe, a life-threatening infection with no alternative.
     * Refusing outright would be practising medicine from a database. What the
     * system insists on is that the reason is written down.
     */
    const blocking = allergy.criticality === 'HIGH';

    warnings.push({
      kind: exact ? 'ALLERGY_EXACT' : 'ALLERGY_CLASS',
      severity: blocking ? 'BLOCKING' : 'ADVISORY',
      overridable: true,
      title: exact
        ? `${args.drugDisplayName} — recorded allergy to ${allergy.substanceText}`
        : `${args.drugDisplayName} is a ${sharedClass} — recorded allergy to ${allergy.substanceText}`,
      detail: [
        allergy.reactionDescription,
        allergy.reactionSeverity ? `Recorded severity: ${allergy.reactionSeverity}.` : null,
      ]
        .filter(Boolean)
        .join(' ') || 'No reaction details were recorded.',
      substanceText: allergy.substanceText,
      criticality: allergy.criticality as SafetyWarning['criticality'],
      recordedAt: allergy.recordedAt?.toISOString() ?? null,
    });
  }

  /* ---- The teleconsultation prohibition --------------------------------- */

  /*
   * The only check here that cannot be overridden.
   *
   * Every other warning is clinical judgement, and a doctor may have a reason
   * the record does not know. This one is law: Schedule X drugs and narcotics
   * may not be prescribed in a remote consultation at all. There is no reason a
   * doctor can write down that makes it lawful, so offering a box to write one
   * in would be offering to help break it.
   */
  if (args.consultationMode === 'TELECONSULTATION') {
    const prohibited = isTeleconsultationProhibited([
      args.moleculeName,
      args.drugDisplayName,
    ]);

    if (prohibited) {
      warnings.push({
        kind: 'SCHEDULE_X_TELEMEDICINE',
        severity: 'BLOCKING',
        overridable: false,
        title: `${args.drugDisplayName} cannot be prescribed in a teleconsultation`,
        detail:
          `${prohibited} is on the prohibited list for remote consultation under ` +
          'the Telemedicine Practice Guidelines. It can be prescribed at an ' +
          'in-person visit.',
        substanceText: args.moleculeName ?? args.drugDisplayName,
        criticality: null,
        recordedAt: null,
      });
    }
  }

  /* ---- Duplicate therapy ----------------------------------------------- */

  if (args.moleculeName) {
    const molecule = normaliseDrugName(args.moleculeName);

    const existing = await tx
      .select({
        id: schema.medicationRequest.id,
        drugDisplayName: schema.medicationRequest.drugDisplayName,
        moleculeName: schema.medicationRequest.moleculeName,
        encounterId: schema.medicationRequest.encounterId,
      })
      .from(schema.medicationRequest)
      .where(
        and(
          eq(schema.medicationRequest.patientId, args.patientId),
          ne(schema.medicationRequest.status, 'CANCELLED'),
        ),
      );

    const duplicate = existing.find(
      (line) => line.moleculeName && normaliseDrugName(line.moleculeName) === molecule,
    );

    if (duplicate) {
      const sameVisit = duplicate.encounterId === args.encounterId;
      warnings.push({
        kind: 'DUPLICATE_THERAPY',
        severity: 'ADVISORY',
        overridable: true,
        title: `${args.moleculeName} is already prescribed`,
        detail: sameVisit
          ? `${duplicate.drugDisplayName} on this prescription contains the same molecule.`
          : `${duplicate.drugDisplayName} is on this patient's active medicine list.`,
        substanceText: args.moleculeName,
        criticality: null,
        recordedAt: null,
      });
    }
  }

  return warnings;
}
