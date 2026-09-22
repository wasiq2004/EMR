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

/**
 * Molecules that may NOT be prescribed in a teleconsultation.
 *
 * India's Telemedicine Practice Guidelines put Schedule X drugs and narcotics on
 * a prohibited list for remote consultation. This is law, not clinical
 * judgement, which is why the check that uses it is the only one in the system
 * with no override: there is no reason a doctor can write down that makes it
 * lawful, so offering a box to write one in would be offering to help break it.
 *
 * Matched by MOLECULE, not by brand, because a doctor may type a brand the
 * catalogue does not carry — and the catalogue's own `drug_schedule` column only
 * helps for items that came from it.
 *
 * Deliberately short and deliberately incomplete: it covers the benzodiazepines
 * and opioids a general outpatient clinic actually reaches for. A clinic
 * stocking anything wider needs this list reviewed against the current schedule
 * by someone qualified to do it.
 */
export const TELECONSULTATION_PROHIBITED_MOLECULES: readonly string[] = [
  // Schedule X — benzodiazepines and related
  'alprazolam', 'lorazepam', 'diazepam', 'clonazepam', 'nitrazepam',
  'chlordiazepoxide', 'midazolam', 'zolpidem', 'zopiclone',
  'phenobarbitone', 'phenobarbital', 'pentazocine', 'buprenorphine',
  'amphetamine', 'methylphenidate', 'ketamine',
  // Narcotics
  'morphine', 'fentanyl', 'pethidine', 'tramadol', 'codeine', 'oxycodone',
];

/**
 * Whether this drug is barred from a remote consultation.
 *
 * Checks both names. A brand frequently carries its molecule inside it, and a
 * free-text prescription may carry nothing else.
 */
export function isTeleconsultationProhibited(
  names: readonly (string | null | undefined)[],
): string | null {
  for (const name of names) {
    if (!name) continue;
    const normalised = normaliseDrugName(name);
    const hit = TELECONSULTATION_PROHIBITED_MOLECULES.find((molecule) =>
      normalised.includes(molecule),
    );
    if (hit) return hit;
  }
  return null;
}
