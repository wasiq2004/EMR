/**
 * The pilot drug list.
 *
 * This is Option B from the Phase 0 drug-data approach: a curated subset that
 * supports search, allergy cross-checking and duplicate-therapy detection, with
 * NO interaction engine. The licensed formulary that would add interactions,
 * contraindications and weight-based paediatric dosing is a procurement
 * decision that has not been made.
 *
 * The rule that follows from that is absolute and is enforced in the UI:
 * interaction checking does not appear on screen — not greyed out, not
 * "coming soon" — until the data behind it exists. A doctor who believes a
 * check is running and sees no warning is in a worse position than one who
 * knows there is no check at all.
 */

import type { DrugCatalogueItem } from '@emr/contracts';

export const CATALOGUE_VERSION = 'pilot-v1';

/** Whether interaction checking may be surfaced. Gated on catalogue capability. */
export const CATALOGUE_SUPPORTS_INTERACTIONS = false;

const d = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;

function item(
  n: number,
  brandName: string | null,
  moleculeName: string,
  strength: string | null,
  dosageForm: string,
  opts: Partial<DrugCatalogueItem> = {},
): DrugCatalogueItem {
  return {
    id: d(n),
    brandName,
    moleculeName,
    strength,
    dosageForm,
    route: dosageForm === 'Injection' ? 'IV' : 'Oral',
    manufacturer: null,
    drugSchedule: 'H',
    isNarcotic: false,
    catalogueVersion: CATALOGUE_VERSION,
    isFavourite: false,
    ...opts,
  };
}

/**
 * Molecules that belong to the same allergy class. This is what lets a
 * penicillin allergy fire on amoxicillin — the single highest-value safety
 * check available without a licence, because it is derived from the clinic's
 * own allergy records rather than from licensed reference data.
 *
 * EVERY CLASS MUST LIST ITS OWN NAME, including the plural and any common
 * spelling. Clinicians very often record the class rather than a specific drug
 * — "Sulfonamides", "NSAIDs", "Penicillin" — and if the class name is not a
 * member of its own class, that allergy silently matches nothing. Penicillin
 * used to work here only by accident, because "penicillin" is also a drug name.
 */
export const ALLERGY_CLASSES: Record<string, string[]> = {
  penicillin: [
    'penicillin',
    'penicillins',
    'amoxicillin',
    'ampicillin',
    'benzylpenicillin',
    'cloxacillin',
    'piperacillin',
    'amoxicillin + clavulanic acid',
  ],
  cephalosporin: [
    'cephalosporin',
    'cephalosporins',
    'cefixime',
    'cefuroxime',
    'ceftriaxone',
    'cephalexin',
  ],
  sulfonamide: [
    'sulfonamide',
    'sulfonamides',
    'sulpha',
    'sulfa',
    'sulfamethoxazole',
    'co-trimoxazole',
    'cotrimoxazole',
    'sulfasalazine',
  ],
  nsaid: [
    'nsaid',
    'nsaids',
    'ibuprofen',
    'diclofenac',
    'naproxen',
    'aceclofenac',
    'aspirin',
  ],
  macrolide: [
    'macrolide',
    'macrolides',
    'azithromycin',
    'clarithromycin',
    'erythromycin',
  ],
  quinolone: [
    'quinolone',
    'quinolones',
    'fluoroquinolone',
    'ciprofloxacin',
    'levofloxacin',
    'ofloxacin',
  ],
};

export const DRUGS: DrugCatalogueItem[] = [
  /* --- Penicillins. The Flow 4 trap lives here. -------------------------- */
  item(1, 'Mox 500', 'Amoxicillin', '500 mg', 'Capsule', { isFavourite: true }),
  item(2, 'Augmentin 625', 'Amoxicillin + Clavulanic acid', '625 mg', 'Tablet', {
    isFavourite: true,
  }),
  item(3, 'Ampilox', 'Ampicillin + Cloxacillin', '500 mg', 'Capsule'),
  item(4, 'Crystapen', 'Benzylpenicillin', '10 lakh IU', 'Injection'),

  /* --- Safe alternatives, so the doctor has somewhere to go. ------------- */
  item(10, 'Azithral 500', 'Azithromycin', '500 mg', 'Tablet', { isFavourite: true }),
  item(11, 'Klacid', 'Clarithromycin', '250 mg', 'Tablet'),
  item(12, 'Doxt-SL', 'Doxycycline', '100 mg', 'Capsule'),
  item(13, 'Cifran 500', 'Ciprofloxacin', '500 mg', 'Tablet'),
  item(14, 'Levoflox 500', 'Levofloxacin', '500 mg', 'Tablet'),
  item(15, 'Taxim-O 200', 'Cefixime', '200 mg', 'Tablet', { isFavourite: true }),

  /* --- Everyday prescribing. ---------------------------------------------- */
  item(20, 'Crocin 650', 'Paracetamol', '650 mg', 'Tablet', { isFavourite: true }),
  item(21, 'Dolo 650', 'Paracetamol', '650 mg', 'Tablet', { isFavourite: true }),
  item(22, 'Calpol 250', 'Paracetamol', '250 mg/5 ml', 'Syrup'),
  item(23, 'Brufen 400', 'Ibuprofen', '400 mg', 'Tablet'),
  item(24, 'Voveran SR', 'Diclofenac', '100 mg', 'Tablet'),
  item(25, 'Zerodol-SP', 'Aceclofenac + Paracetamol + Serratiopeptidase', null, 'Tablet'),
  item(26, 'Pan 40', 'Pantoprazole', '40 mg', 'Tablet', { isFavourite: true }),
  item(27, 'Omez 20', 'Omeprazole', '20 mg', 'Capsule'),
  item(28, 'Rantac 150', 'Ranitidine', '150 mg', 'Tablet'),
  item(29, 'Domstal', 'Domperidone', '10 mg', 'Tablet'),
  item(30, 'Ondem 4', 'Ondansetron', '4 mg', 'Tablet'),
  item(31, 'Allegra 120', 'Fexofenadine', '120 mg', 'Tablet'),
  item(32, 'Cetzine', 'Cetirizine', '10 mg', 'Tablet', { isFavourite: true }),
  item(33, 'Montair-LC', 'Montelukast + Levocetirizine', null, 'Tablet'),
  item(34, 'Asthalin', 'Salbutamol', '100 mcg', 'Inhaler'),
  item(35, 'Budecort', 'Budesonide', '200 mcg', 'Inhaler'),

  /* --- Chronic care, for the polypharmacy fixture. ------------------------ */
  item(40, 'Glycomet 500', 'Metformin', '500 mg', 'Tablet', { isFavourite: true }),
  item(41, 'Glycomet GP1', 'Metformin + Glimepiride', '500/1 mg', 'Tablet'),
  item(42, 'Januvia 100', 'Sitagliptin', '100 mg', 'Tablet'),
  item(43, 'Amlong 5', 'Amlodipine', '5 mg', 'Tablet', { isFavourite: true }),
  item(44, 'Telma 40', 'Telmisartan', '40 mg', 'Tablet', { isFavourite: true }),
  item(45, 'Telma-H', 'Telmisartan + Hydrochlorothiazide', '40/12.5 mg', 'Tablet'),
  item(46, 'Met XL 25', 'Metoprolol', '25 mg', 'Tablet'),
  item(47, 'Ecosprin 75', 'Aspirin', '75 mg', 'Tablet'),
  item(48, 'Atorva 10', 'Atorvastatin', '10 mg', 'Tablet'),
  item(49, 'Rosuvas 10', 'Rosuvastatin', '10 mg', 'Tablet'),
  item(50, 'Lasix 40', 'Furosemide', '40 mg', 'Tablet'),
  item(51, 'Aldactone 25', 'Spironolactone', '25 mg', 'Tablet'),
  item(52, 'Thyronorm 50', 'Thyroxine', '50 mcg', 'Tablet'),
  item(53, 'Shelcal 500', 'Calcium + Vitamin D3', '500 mg', 'Tablet'),
  item(54, 'Uprise D3', 'Cholecalciferol', '60000 IU', 'Sachet'),
  item(55, 'Neurobion Forte', 'Vitamin B complex', null, 'Tablet'),
  item(56, 'Livogen', 'Ferrous fumarate + Folic acid', null, 'Tablet'),
  item(57, 'Nodosis 500', 'Sodium bicarbonate', '500 mg', 'Tablet'),
  item(58, 'Orofer XT', 'Iron + Folic acid', null, 'Tablet'),

  /* --- Sulfonamide, for the second allergy fixture. ----------------------- */
  item(60, 'Septran DS', 'Co-trimoxazole', '800/160 mg', 'Tablet'),

  /* --- Schedule X. Cannot be prescribed via telemedicine — a legal block,
         not clinical judgement, so the UI offers no override at all. ------- */
  item(70, 'Alprax 0.25', 'Alprazolam', '0.25 mg', 'Tablet', {
    drugSchedule: 'X',
    isNarcotic: true,
  }),
  item(71, 'Ativan 1', 'Lorazepam', '1 mg', 'Tablet', {
    drugSchedule: 'X',
    isNarcotic: true,
  }),

  /* --- Devanagari name, to exercise Indic shaping in the PDF. ------------- */
  item(80, 'पॅरासिटामॉल ५०० मिग्रॅ', 'Paracetamol', '500 mg', 'Tablet'),
];

/** Lowercased haystack used for the trigram-style search the API will do. */
function haystack(drug: DrugCatalogueItem): string {
  return `${drug.brandName ?? ''} ${drug.moleculeName} ${drug.strength ?? ''}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Ranking mirrors what the API will do: clinic favourites first, then exact
 * prefix, then substring. A GP prescribes from perhaps 150 drugs, and
 * surfacing those first is the difference between 20 seconds and 5 per line.
 */
export function searchDrugs(term: string, limit = 12): DrugCatalogueItem[] {
  const q = term.trim().toLowerCase();
  if (q.length < 2) return DRUGS.filter((drug) => drug.isFavourite).slice(0, limit);

  const scored = DRUGS.map((drug) => {
    const hay = haystack(drug);
    if (!hay.includes(q)) return null;
    let score = 0;
    if (drug.isFavourite) score += 100;
    if (hay.startsWith(q)) score += 50;
    if ((drug.brandName ?? '').toLowerCase().startsWith(q)) score += 25;
    if (drug.moleculeName.toLowerCase().startsWith(q)) score += 20;
    score -= hay.indexOf(q);
    return { drug, score };
  }).filter((x): x is { drug: DrugCatalogueItem; score: number } => x !== null);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.drug);
}

/** Which allergy class, if any, a molecule belongs to. */
export function classesForMolecule(moleculeName: string): string[] {
  const molecule = moleculeName.toLowerCase();
  return Object.entries(ALLERGY_CLASSES)
    .filter(([, members]) => members.some((m) => molecule.includes(m)))
    .map(([className]) => className);
}
