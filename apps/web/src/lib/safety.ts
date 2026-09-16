/**
 * Prescribing safety checks.
 *
 * WHAT THIS DOES AND DOES NOT DO — read this before changing anything here.
 *
 * With the pilot drug list we can run exactly three checks, and all three are
 * derived from the clinic's own records rather than from licensed reference
 * data:
 *   - exact allergy match (this molecule is recorded as an allergy)
 *   - class allergy match (this molecule is a penicillin; penicillin is recorded)
 *   - duplicate therapy (the same molecule is already on this prescription)
 * plus one legal restriction: Schedule X cannot be prescribed via telemedicine.
 *
 * We CANNOT check drug-to-drug interactions, contraindications against recorded
 * conditions, weight-based paediatric dosing, or pregnancy category. Those need
 * a licensed formulary which has not been procured.
 *
 * The rule that follows is absolute: where a check cannot run, the UI shows
 * NOTHING about it. Not a greyed-out panel, not "coming soon", not an empty
 * interactions section. A doctor who believes interaction checking is running
 * and sees no warning reasonably concludes there is no interaction — and the
 * product put them in that position. Absence of a feature is honest; a
 * non-functioning safety feature is not.
 *
 * "Advisory" in the specification means the system must not alter or refuse the
 * prescription on its own. It does not mean the warning should be easy to miss.
 */

import type { Allergy, PrescriptionLine, SafetyWarning } from '@emr/contracts';
import { classesForMolecule } from '@/mocks/drugs';

export interface DrugUnderConsideration {
  drugDisplayName: string;
  moleculeName: string | null;
  drugSchedule?: string | null;
}

export interface SafetyContext {
  allergies: Allergy[];
  /** Lines already on this prescription, for duplicate-therapy detection. */
  existingLines: PrescriptionLine[];
  /** Schedule X is blocked outright in a remote consultation. */
  isTeleconsultation?: boolean;
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Checks one drug against one patient.
 *
 * Returns warnings ordered most severe first, because the dialog renders them
 * in order and the first one is what the doctor reads under time pressure.
 */
export function checkPrescription(
  drug: DrugUnderConsideration,
  context: SafetyContext,
): SafetyWarning[] {
  const warnings: SafetyWarning[] = [];
  const molecule = normalise(drug.moleculeName ?? drug.drugDisplayName);
  const activeAllergies = context.allergies.filter((a) => a.refutedAt === null);

  /* --- Exact allergy match ---------------------------------------------- */
  for (const allergy of activeAllergies) {
    const substance = normalise(allergy.substanceText);
    const exact = molecule.includes(substance) || substance.includes(molecule);
    if (!exact) continue;

    warnings.push({
      kind: 'ALLERGY_EXACT',
      // A HIGH-criticality allergy blocks. Anything else still interrupts,
      // because an allergy the clinic recorded is not background noise.
      severity: 'BLOCKING',
      overridable: true,
      title: `${allergy.substanceText} allergy recorded for this patient`,
      detail:
        allergy.reactionDescription ??
        'No reaction description was recorded with this allergy.',
      substanceText: allergy.substanceText,
      criticality: allergy.criticality,
      recordedAt: allergy.recordedAt,
    });
  }

  /* --- Class allergy match ---------------------------------------------- */
  if (warnings.length === 0) {
    const drugClasses = classesForMolecule(molecule);
    for (const allergy of activeAllergies) {
      const allergyClasses = classesForMolecule(normalise(allergy.substanceText));
      const shared = drugClasses.filter((c) => allergyClasses.includes(c));
      if (shared.length === 0) continue;

      warnings.push({
        kind: 'ALLERGY_CLASS',
        severity: allergy.criticality === 'HIGH' ? 'BLOCKING' : 'ADVISORY',
        overridable: true,
        title: `${drug.drugDisplayName} is in the same class as a recorded allergy`,
        detail:
          `This patient is recorded as allergic to ${allergy.substanceText}. ` +
          `${drug.drugDisplayName} belongs to the same ${shared[0]} group, so a ` +
          `reaction is possible even though the exact substance differs.`,
        substanceText: allergy.substanceText,
        criticality: allergy.criticality,
        recordedAt: allergy.recordedAt,
      });
    }
  }

  /* --- Duplicate therapy ------------------------------------------------- */
  const duplicate = context.existingLines.find((line) => {
    const existing = normalise(line.moleculeName ?? line.drugDisplayName);
    return existing === molecule && existing.length > 0;
  });

  if (duplicate) {
    warnings.push({
      kind: 'DUPLICATE_THERAPY',
      severity: 'ADVISORY',
      overridable: true,
      title: 'This medicine is already on the prescription',
      detail: `${duplicate.drugDisplayName} contains the same molecule. Check the dose before adding a second line.`,
      substanceText: null,
      criticality: null,
      recordedAt: null,
    });
  }

  /* --- Schedule X in a remote consultation ------------------------------- */
  if (context.isTeleconsultation && drug.drugSchedule === 'X') {
    warnings.push({
      kind: 'SCHEDULE_X_TELEMEDICINE',
      severity: 'BLOCKING',
      // A legal restriction, not clinical judgement — there is no override.
      overridable: false,
      title: 'Schedule X medicines cannot be prescribed in a remote consultation',
      detail:
        'This is a regulatory restriction on teleconsultation, not a clinical warning. ' +
        'The patient must be seen in person for this prescription.',
      substanceText: null,
      criticality: null,
      recordedAt: null,
    });
  }

  return warnings.sort((a, b) => severityRank(b) - severityRank(a));
}

function severityRank(warning: SafetyWarning): number {
  if (!warning.overridable) return 4;
  if (warning.severity === 'BLOCKING' && warning.criticality === 'HIGH') return 3;
  if (warning.severity === 'BLOCKING') return 2;
  return 1;
}

/** True when the prescriber must acknowledge before the line can be added. */
export function requiresAcknowledgement(warnings: SafetyWarning[]): boolean {
  return warnings.some((w) => w.severity === 'BLOCKING');
}

/** True when no override exists and the line simply cannot be added. */
export function isHardBlocked(warnings: SafetyWarning[]): boolean {
  return warnings.some((w) => !w.overridable);
}

/** An override reason is required whenever a blocking warning was overridden. */
export function requiresOverrideReason(warnings: SafetyWarning[]): boolean {
  return warnings.some((w) => w.severity === 'BLOCKING' && w.overridable);
}

/**
 * Free-text prescribing degrades allergy checking to string matching, which is
 * weaker than molecule-id matching. The prescriber is told which checks apply
 * rather than left to assume.
 */
export function checkCoverageNote(hasCatalogueId: boolean): string | null {
  if (hasCatalogueId) return null;
  return 'Typed manually — allergy checking on this line matches on the name only.';
}
