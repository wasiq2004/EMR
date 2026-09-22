/**
 * Drug classes, for allergy cross-reactivity.
 *
 * THIS LIVES IN CONTRACTS BECAUSE IT HAS TWO CALLERS AND MUST HAVE ONE
 * DEFINITION. The API refuses a prescription on it; the prescription pad warns
 * on it before the doctor commits. Two copies means the browser can show a
 * warning the server does not enforce — or, far worse, show none where the
 * server would have. The browser's copy exists for latency. The server's is the
 * record. They have to be the same table.
 *
 * The list is deliberately short. Each entry is a class where a patient
 * allergic to one member should be warned about the others, and where getting
 * it wrong has killed people. It is not an attempt at a formulary: a long list
 * assembled without a clinical source would be more dangerous than this one,
 * because its length would imply a completeness it does not have.
 *
 * Cephalosporins are NOT listed as cross-reactive with penicillins. The real
 * rate is low and disputed, and warning on every cephalosporin for every
 * penicillin-allergic patient produces exactly the alert fatigue that makes
 * clinicians stop reading warnings — which costs more than it saves.
 *
 * Anything added here must come with a clinical source.
 */

export const DRUG_CLASSES: Readonly<Record<string, readonly string[]>> = {
  penicillin: [
    'penicillin', 'benzylpenicillin', 'phenoxymethylpenicillin',
    'amoxicillin', 'amoxycillin', 'ampicillin', 'cloxacillin',
    'flucloxacillin', 'dicloxacillin', 'piperacillin', 'carbenicillin',
    'clavulanic', 'sulbactam', 'tazobactam',
  ],
  sulfonamide: [
    'sulfonamide', 'sulphonamide', 'sulfamethoxazole', 'co-trimoxazole',
    'cotrimoxazole', 'trimethoprim', 'sulfadiazine', 'sulfasalazine',
  ],
  NSAID: [
    'nsaid', 'aspirin', 'ibuprofen', 'diclofenac', 'aceclofenac',
    'naproxen', 'indomethacin', 'ketorolac', 'piroxicam', 'nimesulide',
    'mefenamic',
  ],
  quinolone: [
    'quinolone', 'fluoroquinolone', 'ciprofloxacin', 'levofloxacin',
    'ofloxacin', 'norfloxacin', 'moxifloxacin',
  ],
  macrolide: [
    'macrolide', 'erythromycin', 'azithromycin', 'clarithromycin', 'roxithromycin',
  ],
  tetracycline: ['tetracycline', 'doxycycline', 'minocycline'],
} as const;

/**
 * Folds a drug or substance name to a comparable form.
 *
 * Punctuation becomes a space rather than being deleted, so "co-trimoxazole"
 * and "co trimoxazole" agree without "Mox 500" colliding with something it is
 * not.
 */
export function normaliseDrugName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * The class table with every member folded the same way a drug name is.
 *
 * Both sides have to be normalised or nothing with punctuation matches:
 * `co-trimoxazole` in the table would never match `Co-trimoxazole` from a
 * prescription, because the name has been folded to `co trimoxazole` and the
 * table entry has not. Built once, at module load.
 */
const NORMALISED_CLASSES: [string, string[]][] = Object.entries(DRUG_CLASSES).map(
  ([className, members]) => [className, members.map(normaliseDrugName)],
);

/** Every class whose member list matches any of the given names. */
export function classesForNames(names: readonly string[]): string[] {
  const found = new Set<string>();

  for (const name of names) {
    const normalised = normaliseDrugName(name);
    if (!normalised) continue;

    for (const [className, members] of NORMALISED_CLASSES) {
      if (members.some((member) => normalised.includes(member))) found.add(className);
    }
  }

  return [...found];
}

/** Convenience for the single-name case. */
export function classesForMolecule(moleculeName: string): string[] {
  return classesForNames([moleculeName]);
}
