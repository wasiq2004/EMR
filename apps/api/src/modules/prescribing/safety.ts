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
 * WHAT IS CHECKED, AND WHAT IS NOT. Three checks run: an exact allergy match, a
 * drug-class allergy match, and duplicate therapy. Drug-to-drug interactions,
 * contraindication against a condition, weight-based paediatric dosing and
 * pregnancy category are NOT checked, because each needs a licensed formulary
 * that has not been procured.
 *
 * Nothing about an unavailable check appears anywhere — not a disabled control,
 * not a greyed-out panel. A doctor who believes interactions are being checked
 * and sees no warning is worse off than one who knows there is no check.
 */

import { and, eq, isNull, ne } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import type { TenantTx } from '../../common/tenancy/tenant-db.service';

export interface SafetyWarning {
  kind: 'ALLERGY_EXACT' | 'ALLERGY_CLASS' | 'DUPLICATE_THERAPY';
  severity: 'BLOCKING' | 'ADVISORY';
  overridable: boolean;
  title: string;
  detail: string;
  substanceText: string | null;
  criticality: 'HIGH' | 'LOW' | 'UNABLE_TO_ASSESS' | null;
  recordedAt: string | null;
}

/**
 * Drug classes, for cross-reactivity.
 *
 * Deliberately short. Each entry is a class where a patient allergic to one
 * member should be warned about the others, and where getting it wrong has
 * killed people. It is not an attempt at a formulary — a long list assembled
 * without a clinical source would be more dangerous than this one, because its
 * length would imply a completeness it does not have.
 *
 * Cephalosporins are NOT listed as cross-reactive with penicillins. The real
 * rate is low and disputed, and warning on every cephalosporin for every
 * penicillin-allergic patient produces exactly the alert fatigue that makes
 * doctors stop reading warnings — which costs more lives than it saves.
 */
const DRUG_CLASSES: { name: string; members: string[] }[] = [
  {
    name: 'penicillin',
    members: [
      'penicillin', 'benzylpenicillin', 'phenoxymethylpenicillin',
      'amoxicillin', 'amoxycillin', 'ampicillin', 'cloxacillin',
      'flucloxacillin', 'dicloxacillin', 'piperacillin', 'carbenicillin',
      'clavulanic', 'sulbactam', 'tazobactam',
    ],
  },
  {
    name: 'sulfonamide',
    members: [
      'sulfonamide', 'sulphonamide', 'sulfamethoxazole', 'co-trimoxazole',
      'cotrimoxazole', 'trimethoprim', 'sulfadiazine', 'sulfasalazine',
    ],
  },
  {
    name: 'NSAID',
    members: [
      'nsaid', 'aspirin', 'ibuprofen', 'diclofenac', 'aceclofenac',
      'naproxen', 'indomethacin', 'ketorolac', 'piroxicam', 'nimesulide',
      'mefenamic',
    ],
  },
  {
    name: 'quinolone',
    members: [
      'quinolone', 'fluoroquinolone', 'ciprofloxacin', 'levofloxacin',
      'ofloxacin', 'norfloxacin', 'moxifloxacin',
    ],
  },
  {
    name: 'macrolide',
    members: ['macrolide', 'erythromycin', 'azithromycin', 'clarithromycin', 'roxithromycin'],
  },
  {
    name: 'tetracycline',
    members: ['tetracycline', 'doxycycline', 'minocycline'],
  },
];

const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Every class whose member list contains any of the given terms. */
function classesFor(terms: string[]): string[] {
  const found = new Set<string>();
  for (const term of terms) {
    for (const group of DRUG_CLASSES) {
      if (group.members.some((member) => term.includes(member))) found.add(group.name);
    }
  }
  return [...found];
}

export async function evaluateSafety(
  tx: TenantTx,
  args: {
    patientId: string;
    encounterId: string;
    drugDisplayName: string;
    moleculeName: string | null;
  },
): Promise<SafetyWarning[]> {
  const warnings: SafetyWarning[] = [];

  // Both names, because a doctor may prescribe free text with no molecule, and
  // a brand name often carries the molecule inside it.
  const candidateTerms = [args.moleculeName, args.drugDisplayName]
    .filter((t): t is string => Boolean(t))
    .map(normalise);
  const candidateClasses = classesFor(candidateTerms);

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

    const substance = normalise(allergy.substanceText ?? '');
    if (!substance) continue;

    const exact = candidateTerms.some(
      (term) => term.includes(substance) || substance.includes(term),
    );

    const sharedClass = exact
      ? null
      : (classesFor([substance]).find((c) => candidateClasses.includes(c)) ?? null);

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

  /* ---- Duplicate therapy ----------------------------------------------- */

  if (args.moleculeName) {
    const molecule = normalise(args.moleculeName);

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
      (line) => line.moleculeName && normalise(line.moleculeName) === molecule,
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
