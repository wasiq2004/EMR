/**
 * Seed data.
 *
 * Two things live here and they are different in kind.
 *
 * THE SYSTEM TENANT AND THE DRUG CATALOGUE are structural. The catalogue is
 * owned by a reserved tenant every clinic can read and none can write, so a
 * hundred-thousand-row list is not duplicated per clinic.
 *
 * THE DEMO CLINIC is optional, gated on SEED_DEMO_DATA, and is not arbitrary.
 * Every patient below is a fixture from the prototype verification script — the
 * scripted acceptance test the pilot is measured against. Seeding the real traps
 * means the system can be taken through that script from day one, rather than
 * demonstrated on clean data that hides the failures the script exists to find:
 *
 *   - +91 98765 43210 carries THREE registered family members, one of whom is
 *     plausibly the same person the receptionist is about to register
 *   - Mohd Imran and Mohammed Imran share a date of birth on different numbers
 *   - Lakshmi Narayanan is HIGH-criticality penicillin-allergic, and the natural
 *     prescription for her complaint is a penicillin
 *   - one patient has a stated age and no date of birth
 *   - one patient carries enough medicines to overflow a prescription page
 */

import argon2 from 'argon2';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '@emr/db/schema';

const SYSTEM_CLINIC_ID = '00000000-0000-0000-0000-000000000000';
const CLINIC_ID = '11111111-1111-4111-8111-111111111111';

const days = (n: number) => n * 86_400_000;
const mins = (n: number) => n * 60_000;
const ago = (ms: number) => new Date(Date.now() - ms);

async function main() {
  const url =
    process.env.MIGRATION_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgres://emr_migrator:emr_migrator@localhost:5432/emr';

  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool, { schema });

  try {
    await seedSystemTenant(db);

    if (process.env.SEED_DEMO_DATA !== 'false') {
      // One transaction. A tenant that is half-seeded is worse than one that is
      // absent, because the absent one re-seeds cleanly on the next boot and the
      // half-seeded one reports itself as already present and never repairs.
      await db.transaction(async (tx) => {
        await seedDemoClinic(tx as unknown as Database);
      });
    } else {
      console.log('  SEED_DEMO_DATA=false — skipping the demo clinic.');
    }

    console.log('Seed complete.');
  } finally {
    await pool.end();
  }
}

type Database = ReturnType<typeof drizzle<typeof schema>>;

/* ------------------------------------------------------------------------- *
 * The shared catalogue
 * ------------------------------------------------------------------------- */

async function seedSystemTenant(db: Database) {
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

  /*
   * The pilot drug list.
   *
   * This supports search, allergy cross-checking and duplicate-therapy
   * detection. It does NOT support interaction checking — that needs a licensed
   * formulary. The interface shows nothing about interactions as a result,
   * because a doctor who believes a check is running and sees no warning is
   * worse off than one who knows there is none.
   */
  const drugs: [string | null, string, string | null, string, string?][] = [
    // Penicillins — the acceptance trap lives here.
    ['Mox 500', 'Amoxicillin', '500 mg', 'Capsule'],
    ['Augmentin 625', 'Amoxicillin + Clavulanic acid', '625 mg', 'Tablet'],
    ['Ampilox', 'Ampicillin + Cloxacillin', '500 mg', 'Capsule'],
    ['Crystapen', 'Benzylpenicillin', '10 lakh IU', 'Injection'],
    // Safe alternatives, so the doctor has somewhere to go.
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
    // Chronic care, for the polypharmacy fixture.
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
    // Sulfonamide, for the second allergy fixture.
    ['Septran DS', 'Co-trimoxazole', '800/160 mg', 'Tablet'],
    // Schedule X — cannot be prescribed in a remote consultation. A legal
    // restriction, so the interface offers no override at all.
    ['Alprax 0.25', 'Alprazolam', '0.25 mg', 'Tablet', 'X'],
    ['Ativan 1', 'Lorazepam', '1 mg', 'Tablet', 'X'],
    // Devanagari, to exercise Indic shaping on the printed prescription.
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

/* ------------------------------------------------------------------------- *
 * The demo clinic
 * ------------------------------------------------------------------------- */

async function seedDemoClinic(db: Database) {
  const existing = await db.execute<{ count: string }>(sql`
    SELECT count(*) AS count FROM clinic WHERE id = ${CLINIC_ID}::uuid
  `);
  if (Number(existing.rows[0]?.count ?? 0) > 0) {
    console.log('  demo clinic already present');
    return;
  }

  await db.execute(sql`
    INSERT INTO clinic (id, name, slug, registration_number, address_line1, address_line2,
                        city, state, pincode, contact_phone_e164, contact_email, timezone)
    VALUES (${CLINIC_ID}::uuid, 'Sunrise Family Clinic', 'sunrise', 'MH/CEA/2019/04412',
            '2nd Floor, Shivam Complex, FC Road', 'Shivajinagar', 'Pune', 'Maharashtra',
            '411005', '+912025530012', 'front.desk@sunriseclinic.in', 'Asia/Kolkata')
  `);

  // One password for every demo account. Obviously not a secret, and the
  // sign-in screen says so.
  const hash = await argon2.hash('demo1234', {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });

  const staff: [string, string, string, string | null, string | null, string | null, boolean][] = [
    ['Dr Anjali Mehta', 'anjali.mehta@sunriseclinic.in', 'DOCTOR', '+919820011223',
     'MMC-2011-44821', 'MBBS, MD (General Medicine)', true],
    // Deliberately without a registration number: this account CANNOT sign a
    // prescription, and the interface has to explain why rather than failing at
    // the last step.
    ['Dr Rakesh Iyer', 'rakesh.iyer@sunriseclinic.in', 'DOCTOR', '+919820044556',
     null, 'MBBS, DCH', true],
    ['Priya Kulkarni', 'priya.k@sunriseclinic.in', 'RECEPTIONIST', '+919890012345',
     null, null, false],
    ['Sister Fatima Shaikh', 'fatima.s@sunriseclinic.in', 'NURSE_ASSISTANT', '+919890099887',
     null, 'GNM', false],
    ['Vikram Rao', 'owner@sunriseclinic.in', 'OWNER_ADMIN', '+919811100011',
     null, null, true],
    ['Neha Desai', 'compliance@sunriseclinic.in', 'AUDITOR', null, null, null, true],
  ];

  const staffIds: Record<string, string> = {};
  for (const [name, email, role, mobile, regNo, quals, mfa] of staff) {
    const result = await db.execute<{ id: string }>(sql`
      INSERT INTO app_user (clinic_id, full_name, email, mobile_e164, password_hash, role,
                            medical_registration_number, medical_council, qualifications, mfa_enabled)
      VALUES (${CLINIC_ID}::uuid, ${name}, ${email}, ${mobile}, ${hash}, ${role},
              ${regNo}, ${regNo ? 'Maharashtra Medical Council' : null}, ${quals}, ${mfa})
      RETURNING id
    `);
    staffIds[role === 'DOCTOR' && regNo === null ? 'DOCTOR_NO_REG' : role] = result.rows[0]!.id;
  }

  const doctor = staffIds.DOCTOR!;
  const reception = staffIds.RECEPTIONIST!;
  const nurse = staffIds.NURSE_ASSISTANT!;

  for (const [name, fee, minutes, order] of [
    ['New consultation', 60000, 20, 1],
    ['Follow-up (within 14 days)', 40000, 10, 2],
    ['Dressing', 20000, 10, 3],
    ['Injection', 15000, 5, 4],
  ] as [string, number, number, number][]) {
    await db.execute(sql`
      INSERT INTO service_item (clinic_id, name, default_fee_paise, default_duration_minutes, display_order)
      VALUES (${CLINIC_ID}::uuid, ${name}, ${fee}, ${minutes}, ${order})
    `);
  }

  /* --- Patients: every one is an acceptance fixture ---------------------- */

  const patients: [string, string, string, string | null, string | null, number | null, string | null, string[]][] = [
    // The shared-number family. The duplicate trap.
    ['MRN-000118', 'Sunita Devi', 'FEMALE', '+919876543210', '1992-03-14', null, null, []],
    ['MRN-000119', 'Ramesh Kumar', 'MALE', '+919876543210', '1988-07-02', null, null, []],
    ['MRN-000120', 'Aarav Kumar', 'MALE', '+919876543210', '2020-01-22', null, null, ['Paediatric']],
    // The safety trap.
    // The clinical alert says something the structured allergy record CANNOT.
    // Repeating "severe penicillin allergy" here would put the same sentence
    // twice on one screen, and two identical warnings train the eye to skip
    // both — which costs exactly the attention the allergy panel needs.
    ['MRN-000042', 'Lakshmi Narayanan', 'FEMALE', '+919845512300', '1974-06-09', null,
     'Hard of hearing — speak facing her. Son Karthik usually interprets.',
     ['Chronic care']],
    // Transliteration: same date of birth, different numbers.
    ['MRN-000201', 'Mohd Imran', 'MALE', '+919922334455', '1985-11-30', null, null, []],
    ['MRN-000276', 'Mohammed Imran', 'MALE', '+919922998877', '1985-11-30', null, null, []],
    // Stated age, no date of birth.
    ['MRN-000310', 'Shantabai Pawar', 'FEMALE', '+919767112233', null, 45, null, []],
    // Polypharmacy.
    ['MRN-000355', 'Govind Rao Deshpande', 'MALE', '+919730445566', '1948-02-17', null,
     'Polypharmacy — review medicine list at every visit', ['Chronic care', 'Geriatric']],
    ['MRN-000401', 'Kavita Joshi', 'FEMALE', '+919881234567', '1996-09-05', null, null, []],
    ['MRN-000415', 'Arjun Patil', 'MALE', '+919922776655', '2001-12-19', null, null, []],
  ];

  const patientIds: Record<string, string> = {};
  for (const [mrn, name, gender, mobile, dob, age, alert, tags] of patients) {
    // A bare JS array inside a `sql` template is splatted into a placeholder
    // list, which produces `()` when the array is empty. Arrays go in as a
    // Postgres array literal instead.
    const tagLiteral = `{${tags.map((t) => `"${t}"`).join(',')}}`;
    const result = await db.execute<{ id: string }>(sql`
      INSERT INTO patient (clinic_id, mrn, full_name, name_normalized, mobile_e164, gender,
                           date_of_birth, age_years, age_recorded_at, clinical_alert, tags,
                           city, state, created_by)
      VALUES (${CLINIC_ID}::uuid, ${mrn}, ${name}, ${name.toLowerCase()}, ${mobile}, ${gender},
              ${dob}, ${age}, ${age ? ago(days(430)).toISOString().slice(0, 10) : null},
              ${alert}, ${tagLiteral}::text[], 'Pune', 'Maharashtra', ${reception}::uuid)
      RETURNING id
    `);
    patientIds[mrn] = result.rows[0]!.id;
  }

  const lakshmi = patientIds['MRN-000042']!;
  const govind = patientIds['MRN-000355']!;

  // The allergy the whole acceptance gate turns on.
  await db.execute(sql`
    INSERT INTO allergy_intolerance (clinic_id, patient_id, category, criticality,
                                     substance_text, reaction_description, reaction_severity, recorded_by)
    VALUES
      (${CLINIC_ID}::uuid, ${lakshmi}::uuid, 'MEDICATION', 'HIGH', 'Penicillin',
       'Widespread urticarial rash and facial swelling within 2 hours', 'SEVERE', ${doctor}::uuid),
      (${CLINIC_ID}::uuid, ${lakshmi}::uuid, 'FOOD', 'LOW', 'Prawns', 'Mild itching', 'MILD', ${nurse}::uuid),
      (${CLINIC_ID}::uuid, ${govind}::uuid, 'MEDICATION', 'HIGH', 'Sulfonamides',
       'Stevens-Johnson syndrome, hospitalised 2019', 'SEVERE', ${doctor}::uuid)
  `);

  await db.execute(sql`
    INSERT INTO condition (clinic_id, patient_id, clinical_status, code, code_system,
                           display_text, is_chronic, recorded_by)
    VALUES
      (${CLINIC_ID}::uuid, ${lakshmi}::uuid, 'ACTIVE', 'E11', 'ICD-10', 'Type 2 diabetes mellitus', true, ${doctor}::uuid),
      (${CLINIC_ID}::uuid, ${lakshmi}::uuid, 'ACTIVE', 'I10', 'ICD-10', 'Essential hypertension', true, ${doctor}::uuid),
      (${CLINIC_ID}::uuid, ${govind}::uuid, 'ACTIVE', NULL, NULL, 'Chronic kidney disease, stage 3', true, ${doctor}::uuid)
  `);

  // Vitals taken at triage, deliberately out of range so the Snapshot has
  // something to flag.
  for (const [code, display, value, unit, low, high, interp] of [
    ['8480-6', 'Systolic BP', 148, 'mm[Hg]', 90, 140, 'HIGH'],
    ['8462-4', 'Diastolic BP', 92, 'mm[Hg]', 60, 90, 'HIGH'],
    ['8310-5', 'Temperature', 38.4, 'Cel', 36.1, 37.5, 'HIGH'],
    ['8867-4', 'Pulse', 88, '/min', 60, 100, 'NORMAL'],
    ['29463-7', 'Weight', 68.5, 'kg', null, null, null],
  ] as [string, string, number, string, number | null, number | null, string | null][]) {
    await db.execute(sql`
      INSERT INTO observation (clinic_id, patient_id, code, display, value_numeric, value_unit,
                               reference_low, reference_high, interpretation, effective_at, recorded_by)
      VALUES (${CLINIC_ID}::uuid, ${lakshmi}::uuid, ${code}, ${display}, ${value}, ${unit},
              ${low}, ${high}, ${interp}, ${ago(mins(25))}, ${nurse}::uuid)
    `);
  }

  /* --- History, so the Snapshot is not empty on first open --------------- */

  const visits: [string, number, string, string, string][] = [
    [lakshmi, 62, 'Routine diabetes and blood pressure review',
     'Type 2 diabetes — reasonable control. Hypertension — above target.',
     'Increase telmisartan to 40 mg. Review in 8 weeks with fasting sugar.'],
    [lakshmi, 155, 'Burning feet at night', 'Likely early diabetic neuropathy.',
     'Start vitamin B complex. Foot care advice given.'],
    [lakshmi, 240, 'Annual review', 'Stable.', 'Continue current medicines.'],
    [govind, 7, 'Monthly review', 'CKD stage 3, stable. Polypharmacy reviewed.',
     'Continue. Repeat creatinine in 4 weeks.'],
  ];

  const encounterIds: string[] = [];
  for (const [patientId, daysAgo, complaint, assessment, plan] of visits) {
    const result = await db.execute<{ id: string }>(sql`
      INSERT INTO encounter (clinic_id, patient_id, practitioner_id, status, started_at, ended_at,
                             chief_complaint, assessment_notes, plan_notes,
                             is_finalized, finalized_at, finalized_by, created_by)
      VALUES (${CLINIC_ID}::uuid, ${patientId}::uuid, ${doctor}::uuid, 'FINISHED',
              ${ago(days(daysAgo))}, ${ago(days(daysAgo))}, ${complaint}, ${assessment}, ${plan},
              true, ${ago(days(daysAgo))}, ${doctor}::uuid, ${doctor}::uuid)
      RETURNING id
    `);
    encounterIds.push(result.rows[0]!.id);
  }

  for (const [drug, molecule, strength, frequency] of [
    ['Glycomet 500', 'Metformin', '500 mg', '1-0-1'],
    ['Telma 40', 'Telmisartan', '40 mg', '1-0-0'],
    ['Atorva 10', 'Atorvastatin', '10 mg', '0-0-1'],
  ] as [string, string, string, string][]) {
    await db.execute(sql`
      INSERT INTO medication_request (clinic_id, patient_id, encounter_id, practitioner_id, status,
                                      drug_display_name, molecule_name, strength, dosage_form, route,
                                      frequency, timing_relative_to_food, catalogue_version_at_prescribing, created_by)
      VALUES (${CLINIC_ID}::uuid, ${lakshmi}::uuid, ${encounterIds[0]}::uuid, ${doctor}::uuid, 'ACTIVE',
              ${drug}, ${molecule}, ${strength}, 'Tablet', 'Oral', ${frequency}, 'AFTER_FOOD',
              'pilot-v1', ${doctor}::uuid)
    `);
  }

  /* --- Today's queue ------------------------------------------------------ */

  const queue: [string, string, number, number | null][] = [
    [lakshmi, 'Sore throat and fever, 3 days', 28, 10],
    [patientIds['MRN-000310']!, 'Knee pain review', 19, 20],
    [govind, 'Monthly review, repeat medicines', 11, 30],
  ];

  for (const [patientId, reason, minutesAgo, position] of queue) {
    await db.execute(sql`
      INSERT INTO appointment (clinic_id, patient_id, practitioner_id, status, scheduled_start,
                               arrived_at, queue_position, is_walk_in, reason_text, created_by)
      VALUES (${CLINIC_ID}::uuid, ${patientId}::uuid, ${doctor}::uuid, 'ARRIVED',
              ${ago(mins(minutesAgo))}, ${ago(mins(minutesAgo))}, ${position}, true, ${reason}, ${reception}::uuid)
    `);
  }

  await db.execute(sql`
    INSERT INTO appointment (clinic_id, patient_id, practitioner_id, status, scheduled_start,
                             scheduled_end, is_walk_in, reason_text, created_by)
    VALUES (${CLINIC_ID}::uuid, ${patientIds['MRN-000401']}::uuid, ${doctor}::uuid, 'CONFIRMED',
            ${new Date(Date.now() + mins(75))}, ${new Date(Date.now() + mins(90))},
            false, 'Follow-up', ${reception}::uuid)
  `);

  /* --- The inbox, including the unlinked queue --------------------------- */

  await db.execute(sql`
    INSERT INTO whatsapp_account (clinic_id, waba_id, phone_number_id, display_phone_e164,
                                  verified_name, access_token_encrypted, quality_rating,
                                  messaging_tier, local_storage_region)
    VALUES (${CLINIC_ID}::uuid, 'demo-waba', 'demo-phone-id', '+919000012345',
            'Sunrise Family Clinic', 'not-a-real-token', 'YELLOW',
            '1,000 conversations / 24h', 'India')
  `);

  const conversation = await db.execute<{ id: string }>(sql`
    INSERT INTO whatsapp_conversation (clinic_id, patient_id, counterparty_e164, last_inbound_at,
                                       window_expires_at, status, is_unread, created_by)
    VALUES (${CLINIC_ID}::uuid, ${lakshmi}::uuid, '+919845512300', ${ago(mins(95))},
            ${new Date(Date.now() + days(1) - mins(95))}, 'WAITING', false, ${reception}::uuid)
    RETURNING id
  `);

  // Three patients share this number, so inbound cannot be matched to one. This
  // is an expected path in this market, not an error.
  const unlinked = await db.execute<{ id: string }>(sql`
    INSERT INTO whatsapp_conversation (clinic_id, patient_id, counterparty_e164, last_inbound_at,
                                       window_expires_at, status, is_unread, is_unlinked, created_by)
    VALUES (${CLINIC_ID}::uuid, NULL, '+919876543210', ${ago(mins(22))},
            ${new Date(Date.now() + days(1) - mins(22))}, 'OPEN', true, true, ${reception}::uuid)
    RETURNING id
  `);

  await db.execute(sql`
    INSERT INTO communication (clinic_id, patient_id, conversation_id, channel, direction, status,
                               message_kind, template_name, body, queued_at, sent_at, delivered_at, created_by)
    VALUES
      (${CLINIC_ID}::uuid, ${lakshmi}::uuid, ${conversation.rows[0]!.id}::uuid, 'WHATSAPP', 'OUTBOUND',
       'READ', 'TEMPLATE', 'appointment_reminder_v2',
       'Reminder: you have an appointment with Dr Anjali Mehta today at 11:00 AM.',
       ${ago(mins(180))}, ${ago(mins(180))}, ${ago(mins(179))}, ${reception}::uuid),
      (${CLINIC_ID}::uuid, ${lakshmi}::uuid, ${conversation.rows[0]!.id}::uuid, 'WHATSAPP', 'INBOUND',
       'RECEIVED', NULL, NULL, 'Thank you doctor, I will come at 11.',
       ${ago(mins(95))}, ${ago(mins(95))}, NULL, NULL),
      (${CLINIC_ID}::uuid, NULL, ${unlinked.rows[0]!.id}::uuid, 'WHATSAPP', 'INBOUND',
       'RECEIVED', NULL, NULL, 'Doctor, baby has fever since morning. Can we come today?',
       ${ago(mins(22))}, ${ago(mins(22))}, NULL, NULL)
  `);

  /* --- Tasks: where the safety mechanisms terminate ---------------------- */

  await db.execute(sql`
    INSERT INTO task (clinic_id, status, priority, task_type, title, description,
                      patient_id, assigned_to_role, due_at, created_by)
    VALUES
      (${CLINIC_ID}::uuid, 'REQUESTED', 'URGENT', 'DELIVERY_FAILED',
       'Prescription not delivered to Govind Rao Deshpande',
       'The message was accepted but not confirmed delivered within 15 minutes. Print a copy or call the patient.',
       ${govind}::uuid, 'RECEPTIONIST', ${new Date(Date.now() + mins(30))}, ${reception}::uuid),
      (${CLINIC_ID}::uuid, 'REQUESTED', 'ROUTINE', 'DUPLICATE_REVIEW',
       'Possible duplicate: Mohd Imran and Mohammed Imran',
       'Same date of birth and a close name match on two different mobile numbers.',
       ${patientIds['MRN-000201']}::uuid, 'OWNER_ADMIN', NULL, ${reception}::uuid),
      (${CLINIC_ID}::uuid, 'REQUESTED', 'ROUTINE', 'FOLLOW_UP_CALL',
       'Follow-up call for Lakshmi Narayanan',
       'Dr Mehta asked for a check-in call two weeks after the last visit.',
       ${lakshmi}::uuid, NULL, ${new Date(Date.now() + days(2))}, ${doctor}::uuid)
  `);

  /* --- Billing ------------------------------------------------------------ */

  await db.execute(sql`
    INSERT INTO invoice (clinic_id, patient_id, invoice_number, status, line_items,
                         subtotal_paise, total_paise, paid_paise, issued_at, is_finalized, created_by)
    VALUES (${CLINIC_ID}::uuid, ${patientIds['MRN-000118']}::uuid, 'INV-2026-0311', 'ISSUED',
            ${JSON.stringify([{ description: 'New consultation', quantity: 1, unitPricePaise: 60000, amountPaise: 60000 }])}::jsonb,
            60000, 60000, 0, ${ago(mins(105))}, true, ${reception}::uuid)
  `);

  console.log('  seeded the demo clinic with the acceptance fixtures');
  console.log('  sign in with any of these and the password  demo1234');
  for (const [, email, role] of staff) console.log(`    ${role.padEnd(16)} ${email}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
