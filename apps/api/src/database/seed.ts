/**
 * Reference data.
 *
 * This runs on every deployment and creates NO clinics, NO patients and NO
 * users. What it writes is the shared drug catalogue, owned by a reserved
 * tenant that every clinic can read and none can write — so a
 * hundred-thousand-row list is not duplicated per clinic.
 *
 * There is deliberately no demo data. A system that ships with a fictional
 * clinic inside it invites two failures: it gets demonstrated against records
 * shaped to make the demonstration work, and sooner or later a real deployment
 * carries invented patients alongside real ones with nothing marking which is
 * which.
 *
 * To create a clinic and its first administrator, run `provision.ts`.
 */

import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '@emr/db/schema';
import {
  DIAGNOSIS_CATALOGUE,
  DIAGNOSIS_CATALOGUE_VERSION,
  DIAGNOSIS_CODE_SYSTEM,
} from './diagnosis-catalogue';

const SYSTEM_CLINIC_ID = '00000000-0000-0000-0000-000000000000';

async function main() {
  const url =
    process.env.MIGRATION_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgres://emr_migrator:emr_migrator@localhost:5432/emr';

  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool, { schema });

  try {
    await seedDrugCatalogue(db);
    await seedDiagnosisCatalogue(db);
    await seedLabTestCatalogue(db);
    console.log('Reference data ready.');
  } finally {
    await pool.end();
  }
}

type Database = ReturnType<typeof drizzle<typeof schema>>;

/**
 * The shared drug catalogue.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. It is a working list for an Indian
 * outpatient clinic, sufficient for search, allergy cross-checking and
 * duplicate-therapy detection. It is NOT a licensed formulary: it carries no
 * interaction data, no contraindications, no paediatric dosing and no pregnancy
 * categories — which is exactly why the prescribing module performs none of
 * those checks and the interface shows nothing about them.
 *
 * This is reference data, not sample data. Without it the prescribing screen
 * has nothing to search. A clinic stocking beyond this list adds its own
 * entries; replacing it with a licensed formulary is a procurement decision
 * rather than a code change.
 */
/**
 * The diagnosis codes the typeahead offers.
 *
 * Same shape as the drug catalogue and for the same reason: one copy under a
 * reserved tenant that every clinic reads and none can write, rather than a
 * list duplicated per clinic.
 *
 * IT IS A CONVENIENCE, NOT A CONSTRAINT. `condition.code` is nullable and the
 * typeahead never refuses an unmatched entry — a doctor who cannot find the code
 * for what they are looking at writes it down and moves on. Picking the nearest
 * wrong code is the failure this is designed to avoid, not the behaviour it is
 * designed to produce.
 *
 * On why the list is ~250 codes rather than the planned 1,500, and how to load a
 * full licensed release instead, see `diagnosis-catalogue.ts`. The short version:
 * a wrong ICD-10 code travels onto an insurance claim and into the next
 * clinician's reading, so we seed only codes we are confident of.
 */
/**
 * The lab tests an Indian outpatient clinic orders.
 *
 * Shared reference data under the system tenant, like the drugs and the
 * diagnoses. Short on purpose: these are the tests a 1-5 doctor OPD actually
 * writes on a slip, not a pathology lab's price list. A clinic adds its own.
 *
 * REFERENCE RANGES ARE ADULT AND NOT SEX-SPECIFIC, which is a real limitation
 * stated rather than hidden. Haemoglobin alone differs by sex; paediatric ranges
 * differ by year. One range flags a value as worth a second look — it does not
 * diagnose, and the interface says so. Storing one range and presenting it as
 * universal truth would be worse than storing none, which is why the flag is
 * worded as a prompt everywhere it appears.
 *
 * Where a range is genuinely not meaningful the columns are null and the result
 * is recorded as text: a urine culture reports "no growth", not a number.
 */
async function seedLabTestCatalogue(db: Database) {
  const existing = await db.execute<{ count: string }>(sql`
    SELECT count(*) AS count
    FROM lab_test_catalogue_item
    WHERE clinic_id = ${SYSTEM_CLINIC_ID}::uuid
  `);
  if (Number(existing.rows[0]?.count ?? 0) > 0) {
    console.log('  lab test catalogue already present');
    return;
  }

  // [name, category, unit, low, high, synonyms]
  const tests: [string, string, string | null, number | null, number | null, string?][] = [
    /* --- Haematology --- */
    ['Haemoglobin', 'Haematology', 'g/dL', 12, 16, 'hb hgb haemoglobin hemoglobin'],
    ['Complete blood count', 'Haematology', null, null, null, 'cbc hemogram full blood count'],
    ['Total leucocyte count', 'Haematology', 'cells/uL', 4000, 11000, 'tlc wbc white cell'],
    ['Platelet count', 'Haematology', 'cells/uL', 150000, 450000, 'platelets plt'],
    ['ESR', 'Haematology', 'mm/hr', 0, 20, 'esr sedimentation rate'],
    ['Peripheral smear', 'Haematology', null, null, null, 'ps smear malaria parasite'],

    /* --- Biochemistry --- */
    ['Fasting blood sugar', 'Biochemistry', 'mg/dL', 70, 100, 'fbs fasting glucose sugar'],
    ['Postprandial blood sugar', 'Biochemistry', 'mg/dL', 70, 140, 'ppbs post prandial sugar'],
    ['Random blood sugar', 'Biochemistry', 'mg/dL', 70, 140, 'rbs random sugar'],
    ['HbA1c', 'Biochemistry', '%', 4, 5.7, 'hba1c glycated haemoglobin a1c'],
    ['Serum creatinine', 'Biochemistry', 'mg/dL', 0.6, 1.3, 'creatinine renal kidney'],
    ['Blood urea', 'Biochemistry', 'mg/dL', 15, 40, 'urea bun'],
    ['Serum sodium', 'Biochemistry', 'mEq/L', 135, 145, 'sodium na electrolytes'],
    ['Serum potassium', 'Biochemistry', 'mEq/L', 3.5, 5.1, 'potassium k electrolytes'],
    ['Serum calcium', 'Biochemistry', 'mg/dL', 8.5, 10.5, 'calcium ca'],
    ['Uric acid', 'Biochemistry', 'mg/dL', 3.5, 7.2, 'uric acid gout'],
    ['Total bilirubin', 'Biochemistry', 'mg/dL', 0.2, 1.2, 'bilirubin jaundice lft'],
    ['SGPT (ALT)', 'Biochemistry', 'U/L', 7, 56, 'sgpt alt liver lft'],
    ['SGOT (AST)', 'Biochemistry', 'U/L', 10, 40, 'sgot ast liver lft'],
    ['Alkaline phosphatase', 'Biochemistry', 'U/L', 44, 147, 'alp alkaline phosphatase'],
    ['Serum albumin', 'Biochemistry', 'g/dL', 3.5, 5.5, 'albumin'],
    ['Total cholesterol', 'Biochemistry', 'mg/dL', 0, 200, 'cholesterol lipid profile'],
    ['LDL cholesterol', 'Biochemistry', 'mg/dL', 0, 100, 'ldl bad cholesterol'],
    ['HDL cholesterol', 'Biochemistry', 'mg/dL', 40, 60, 'hdl good cholesterol'],
    ['Triglycerides', 'Biochemistry', 'mg/dL', 0, 150, 'triglycerides tg lipid'],
    ['Lipid profile', 'Biochemistry', null, null, null, 'lipid profile cholesterol panel'],
    ['Vitamin B12', 'Biochemistry', 'pg/mL', 200, 900, 'b12 cobalamin'],
    ['Vitamin D (25-OH)', 'Biochemistry', 'ng/mL', 30, 100, 'vitamin d 25 hydroxy vit d'],
    ['Serum ferritin', 'Biochemistry', 'ng/mL', 30, 300, 'ferritin iron stores'],
    ['Serum iron', 'Biochemistry', 'ug/dL', 60, 170, 'iron fe'],
    ['CRP', 'Biochemistry', 'mg/L', 0, 5, 'crp c reactive protein inflammation'],

    /* --- Endocrine --- */
    ['TSH', 'Endocrine', 'uIU/mL', 0.4, 4.0, 'tsh thyroid stimulating hormone'],
    ['Free T4', 'Endocrine', 'ng/dL', 0.8, 1.8, 'ft4 free t4 thyroxine'],
    ['Free T3', 'Endocrine', 'pg/mL', 2.3, 4.2, 'ft3 free t3'],
    ['Thyroid profile', 'Endocrine', null, null, null, 'thyroid profile t3 t4 tsh'],

    /* --- Microbiology and serology --- */
    ['Urine routine', 'Microbiology', null, null, null, 'urine re me routine microscopy'],
    ['Urine culture', 'Microbiology', null, null, null, 'urine culture sensitivity uti'],
    ['Blood culture', 'Microbiology', null, null, null, 'blood culture sepsis'],
    ['Stool routine', 'Microbiology', null, null, null, 'stool re me ova cyst'],
    ['Dengue NS1 antigen', 'Serology', null, null, null, 'dengue ns1'],
    ['Dengue IgM', 'Serology', null, null, null, 'dengue igm'],
    ['Malaria antigen', 'Serology', null, null, null, 'malaria rapid mp antigen'],
    ['Widal test', 'Serology', null, null, null, 'widal typhoid'],
    ['Typhoid IgM', 'Serology', null, null, null, 'typhidot typhoid igm'],
    ['HBsAg', 'Serology', null, null, null, 'hbsag hepatitis b surface antigen'],
    ['Anti-HCV', 'Serology', null, null, null, 'hcv hepatitis c antibody'],
    ['HIV I and II', 'Serology', null, null, null, 'hiv elisa retroviral'],
    ['VDRL', 'Serology', null, null, null, 'vdrl syphilis rpr'],
    ['Mantoux test', 'Microbiology', 'mm', 0, 9, 'mantoux tuberculin tst'],
    ['Sputum AFB', 'Microbiology', null, null, null, 'afb sputum tb acid fast'],
    ['CBNAAT for TB', 'Microbiology', null, null, null, 'cbnaat genexpert tb'],
    ['COVID-19 RT-PCR', 'Microbiology', null, null, null, 'covid rtpcr sars cov 2'],

    /* --- Obstetric --- */
    ['Urine pregnancy test', 'Obstetric', null, null, null, 'upt pregnancy test'],
    ['Beta hCG', 'Obstetric', 'mIU/mL', null, null, 'bhcg beta hcg pregnancy'],
    ['Blood group and Rh', 'Haematology', null, null, null, 'blood group typing rh abo'],

    /* --- Cardiac --- */
    ['Troponin I', 'Cardiac', 'ng/mL', 0, 0.04, 'troponin cardiac marker'],
    ['ECG', 'Cardiology', null, null, null, 'ecg ekg electrocardiogram'],

    /* --- Imaging, which clinics order on the same slip --- */
    ['Chest X-ray', 'Radiology', null, null, null, 'cxr chest xray'],
    ['Ultrasound abdomen', 'Radiology', null, null, null, 'usg abdomen ultrasound'],
    ['Ultrasound pelvis', 'Radiology', null, null, null, 'usg pelvis'],
    ['X-ray knee', 'Radiology', null, null, null, 'xray knee'],
    ['X-ray lumbosacral spine', 'Radiology', null, null, null, 'xray ls spine lumbar'],
  ];

  for (const [name, category, unit, low, high, synonyms] of tests) {
    await db.execute(sql`
      INSERT INTO lab_test_catalogue_item
        (clinic_id, name, search_normalized, category, unit,
         reference_low, reference_high, catalogue_version)
      VALUES (
        ${SYSTEM_CLINIC_ID}::uuid, ${name},
        ${`${name} ${synonyms ?? ''}`.toLowerCase().replace(/\s+/g, ' ').trim()},
        ${category}, ${unit}, ${low}, ${high}, 'lab-opd-in-v1'
      )
      ON CONFLICT (clinic_id, name) DO NOTHING
    `);
  }

  console.log(`  seeded ${tests.length} lab tests under the system tenant`);
}

async function seedDiagnosisCatalogue(db: Database) {
  const existing = await db.execute<{ count: string }>(sql`
    SELECT count(*) AS count
    FROM diagnosis_catalogue_item
    WHERE clinic_id = ${SYSTEM_CLINIC_ID}::uuid
  `);
  if (Number(existing.rows[0]?.count ?? 0) > 0) {
    console.log('  diagnosis catalogue already present');
    return;
  }

  for (const entry of DIAGNOSIS_CATALOGUE) {
    /*
     * The search text carries the display, the code and the synonyms together.
     *
     * Searching is not the same as recording: "URTI" has to find the entry and
     * "Acute upper respiratory infection" is what gets written on the
     * prescription. The code is in there too, so a doctor who knows J02.9 can
     * type it.
     */
    const searchNormalized = [entry.display, entry.code, entry.synonyms ?? '']
      .join(' ')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    await db.execute(sql`
      INSERT INTO diagnosis_catalogue_item
        (clinic_id, code, code_system, display_text, search_normalized,
         category, is_chronic_by_default, catalogue_version)
      VALUES (
        ${SYSTEM_CLINIC_ID}::uuid, ${entry.code}, ${DIAGNOSIS_CODE_SYSTEM},
        ${entry.display}, ${searchNormalized}, ${entry.category},
        ${entry.chronic === true}, ${DIAGNOSIS_CATALOGUE_VERSION}
      )
      ON CONFLICT (clinic_id, code, display_text) DO NOTHING
    `);
  }

  console.log(
    `  seeded ${DIAGNOSIS_CATALOGUE.length} diagnosis codes under the system tenant`,
  );
}

async function seedDrugCatalogue(db: Database) {
  await db.execute(sql`
    INSERT INTO clinic (id, name, slug, timezone, is_active)
    VALUES (${SYSTEM_CLINIC_ID}::uuid, 'SYSTEM (shared reference data)', '__system__', 'Asia/Kolkata', false)
    ON CONFLICT (id) DO NOTHING
  `);

  const existing = await db.execute<{ count: string }>(sql`
    SELECT count(*) AS count FROM drug_catalogue_item WHERE clinic_id = ${SYSTEM_CLINIC_ID}::uuid
  `);
  if (Number(existing.rows[0]?.count ?? 0) > 0) {
    console.log('  drug catalogue already present');
    return;
  }

  const drugs: [string | null, string, string | null, string, string?][] = [
    // Penicillins — the class the allergy check most often has to catch.
    ['Mox 500', 'Amoxicillin', '500 mg', 'Capsule'],
    ['Augmentin 625', 'Amoxicillin + Clavulanic acid', '625 mg', 'Tablet'],
    ['Ampilox', 'Ampicillin + Cloxacillin', '500 mg', 'Capsule'],
    ['Crystapen', 'Benzylpenicillin', '10 lakh IU', 'Injection'],
    // Alternatives, so a doctor blocked on an allergy has somewhere to go.
    ['Azithral 500', 'Azithromycin', '500 mg', 'Tablet'],
    ['Klacid', 'Clarithromycin', '250 mg', 'Tablet'],
    ['Doxt-SL', 'Doxycycline', '100 mg', 'Capsule'],
    ['Cifran 500', 'Ciprofloxacin', '500 mg', 'Tablet'],
    ['Levoflox 500', 'Levofloxacin', '500 mg', 'Tablet'],
    ['Taxim-O 200', 'Cefixime', '200 mg', 'Tablet'],
    // Everyday prescribing.
    ['Crocin 650', 'Paracetamol', '650 mg', 'Tablet'],
    ['Dolo 650', 'Paracetamol', '650 mg', 'Tablet'],
    ['Calpol 250', 'Paracetamol', '250 mg/5 ml', 'Syrup'],
    ['Brufen 400', 'Ibuprofen', '400 mg', 'Tablet'],
    ['Voveran SR', 'Diclofenac', '100 mg', 'Tablet'],
    ['Zerodol-SP', 'Aceclofenac + Paracetamol + Serratiopeptidase', null, 'Tablet'],
    ['Pan 40', 'Pantoprazole', '40 mg', 'Tablet'],
    ['Omez 20', 'Omeprazole', '20 mg', 'Capsule'],
    ['Rantac 150', 'Ranitidine', '150 mg', 'Tablet'],
    ['Domstal', 'Domperidone', '10 mg', 'Tablet'],
    ['Ondem 4', 'Ondansetron', '4 mg', 'Tablet'],
    ['Allegra 120', 'Fexofenadine', '120 mg', 'Tablet'],
    ['Cetzine', 'Cetirizine', '10 mg', 'Tablet'],
    ['Montair-LC', 'Montelukast + Levocetirizine', null, 'Tablet'],
    ['Asthalin', 'Salbutamol', '100 mcg', 'Inhaler'],
    ['Budecort', 'Budesonide', '200 mcg', 'Inhaler'],
    // Chronic care.
    ['Glycomet 500', 'Metformin', '500 mg', 'Tablet'],
    ['Glycomet GP1', 'Metformin + Glimepiride', '500/1 mg', 'Tablet'],
    ['Januvia 100', 'Sitagliptin', '100 mg', 'Tablet'],
    ['Amlong 5', 'Amlodipine', '5 mg', 'Tablet'],
    ['Telma 40', 'Telmisartan', '40 mg', 'Tablet'],
    ['Telma-H', 'Telmisartan + Hydrochlorothiazide', '40/12.5 mg', 'Tablet'],
    ['Met XL 25', 'Metoprolol', '25 mg', 'Tablet'],
    ['Ecosprin 75', 'Aspirin', '75 mg', 'Tablet'],
    ['Atorva 10', 'Atorvastatin', '10 mg', 'Tablet'],
    ['Rosuvas 10', 'Rosuvastatin', '10 mg', 'Tablet'],
    ['Lasix 40', 'Furosemide', '40 mg', 'Tablet'],
    ['Aldactone 25', 'Spironolactone', '25 mg', 'Tablet'],
    ['Thyronorm 50', 'Thyroxine', '50 mcg', 'Tablet'],
    ['Shelcal 500', 'Calcium + Vitamin D3', '500 mg', 'Tablet'],
    ['Uprise D3', 'Cholecalciferol', '60000 IU', 'Sachet'],
    ['Neurobion Forte', 'Vitamin B complex', null, 'Tablet'],
    ['Livogen', 'Ferrous fumarate + Folic acid', null, 'Tablet'],
    ['Nodosis 500', 'Sodium bicarbonate', '500 mg', 'Tablet'],
    ['Orofer XT', 'Iron + Folic acid', null, 'Tablet'],
    ['Septran DS', 'Co-trimoxazole', '800/160 mg', 'Tablet'],
    // Schedule X. Cannot be prescribed in a teleconsultation — a legal
    // restriction the prescribing module enforces with no override.
    ['Alprax 0.25', 'Alprazolam', '0.25 mg', 'Tablet', 'X'],
    ['Ativan 1', 'Lorazepam', '1 mg', 'Tablet', 'X'],
    // Devanagari, so Indic shaping on a printed prescription is exercised by
    // real catalogue data rather than discovered by a patient.
    ['पॅरासिटामॉल ५०० मिग्रॅ', 'Paracetamol', '500 mg', 'Tablet'],
  ];

  for (const [brand, molecule, strength, form, drugSchedule] of drugs) {
    await db.execute(sql`
      INSERT INTO drug_catalogue_item
        (clinic_id, brand_name, molecule_name, search_normalized, strength,
         dosage_form, route, drug_schedule, is_narcotic, catalogue_version)
      VALUES (
        ${SYSTEM_CLINIC_ID}::uuid, ${brand}, ${molecule},
        ${`${brand ?? ''} ${molecule} ${strength ?? ''}`.toLowerCase().trim()},
        ${strength}, ${form}, ${form === 'Injection' ? 'IV' : 'Oral'},
        ${drugSchedule ?? 'H'}, ${drugSchedule === 'X'}, 'pilot-v1'
      )
    `);
  }

  console.log(`  seeded ${drugs.length} catalogue items under the system tenant`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
