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
