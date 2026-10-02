#!/usr/bin/env node
/**
 * Test fixtures: build a clinic, or tear one down.
 *
 * THIS IS NOT SEED DATA. The product ships with no clinics, no patients and no
 * accounts — `seed.ts` writes the shared drug catalogue and nothing else. This
 * script exists so the verification suites can create the world they need,
 * assert against it, and delete it, instead of depending on invented records
 * living permanently in the database.
 *
 *   node scripts/verify/fixtures.mjs up    > fixtures.env
 *   node scripts/verify/fixtures.mjs down  < fixtures.env
 *
 * `up` prints shell assignments the suites source. `down` removes the clinic
 * and everything in it.
 *
 * Most of it goes through the real API, because a fixture built by the same
 * code path a receptionist uses is a fixture that proves the path works. Three
 * things cannot: an inbound WhatsApp conversation arrives by webhook, an
 * approved template is approved by Meta, and consent is captured on paper. Those
 * are written directly, and each one says why below.
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';

const API = process.env.API_BASE ?? 'http://localhost:4000/v1';
const DB =
  process.env.MIGRATION_DATABASE_URL ??
  'postgres://emr_migrator:emr_migrator@localhost:5433/emr';

const PASSWORD = 'Verify!' + randomUUID().slice(0, 8);

/* -------------------------------------------------------------------------- */

async function api(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }

  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`);
  }
  return { data: parsed, setCookie: response.headers.getSetCookie?.() ?? [] };
}

/** Signs in and returns the cookie header for subsequent calls. */
async function signIn(email, password) {
  const { setCookie } = await api('/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

/* -------------------------------------------------------------------------- */

async function up() {
  const stamp = Date.now();
  const slug = `verify-${stamp}`;
  const domain = `${slug}.test`;

  const pool = new pg.Pool({ connectionString: DB });

  try {
    /*
     * The clinic and its administrator, written directly.
     *
     * This is what `provision.ts` does, and a suite cannot shell out to it
     * portably. Everything AFTER this point goes through the API.
     */
    const argon2 = (await import('argon2')).default;
    const hash = await argon2.hash(PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    const clinic = await pool.query(
      `INSERT INTO clinic (name, slug, timezone, registration_number, address_line1,
                           city, state, pincode, contact_phone_e164)
       VALUES ($1,$2,'Asia/Kolkata','TEST/CEA/0001','1 Test Road','Pune','Maharashtra','411001','+912000000000')
       RETURNING id`,
      [`Verification Clinic ${stamp}`, slug],
    );
    const clinicId = clinic.rows[0].id;

    /*
     * A subscription with EVERY MODULE ON.
     *
     * Without this the fixture clinic has no plan, so `FeatureGuard` resolves
     * every flag to off and the suites fail with 403 on billing, reports,
     * documents, the inbox, WhatsApp, exports and broadcast previews — which
     * looks like a broken product rather than an unprovisioned tenant.
     *
     * The flags are written as a feature OVERRIDE rather than by pointing at a
     * catalogue plan, deliberately: these suites test clinic behaviour, and
     * binding them to `clinic-plus` would make them fail the day somebody edits
     * that plan's price or its module list. The gate itself is tested separately
     * in `platform.sh`, which is where a 403 is the expected answer.
     */
    const allFeatures = JSON.stringify(
      Object.fromEntries(
        [
          'whatsapp',
          'broadcasts',
          'teleconsultation',
          'documents',
          'billing',
          'reports',
          'dataPortability',
          'multiLocation',
          'pharmacy',
          'analytics',
        ].map((key) => [key, true]),
      ),
    );

    await pool.query(
      `INSERT INTO subscription (clinic_id, plan, status, monthly_price_paise,
                                 max_practitioners, included_messages_per_month,
                                 feature_overrides)
       VALUES ($1, 'verification', 'ACTIVE', 0, NULL, NULL, $2::jsonb)`,
      [clinicId, allFeatures],
    );

    // One account per role, so role separation can be asserted properly.
    const staff = [
      ['OWNER_ADMIN', `owner@${domain}`, 'Admin User', null, null],
      ['DOCTOR', `doctor@${domain}`, 'Dr Test Doctor', 'TEST-REG-1', 'MBBS, MD'],
      // A doctor with NO registration number: cannot sign, and the interface
      // has to say why rather than failing at the last step.
      ['DOCTOR', `unregistered@${domain}`, 'Dr No Registration', null, 'MBBS'],
      ['RECEPTIONIST', `reception@${domain}`, 'Reception User', null, null],
      ['NURSE_ASSISTANT', `nurse@${domain}`, 'Nurse User', null, 'GNM'],
      ['AUDITOR', `auditor@${domain}`, 'Auditor User', null, null],
      ['PHARMACIST', `pharmacist@${domain}`, 'Pharmacist User', null, 'B.Pharm'],
      ['RESEARCH_ANALYST', `analyst@${domain}`, 'Analyst User', null, null],
    ];

    for (const [role, email, name, registration, quals] of staff) {
      await pool.query(
        `INSERT INTO app_user (clinic_id, full_name, email, password_hash, role,
                               medical_registration_number, medical_council, qualifications, mfa_enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)`,
        [
          clinicId,
          name,
          email,
          hash,
          role,
          registration,
          registration ? 'Test Medical Council' : null,
          quals,
        ],
      );
    }

    const reception = await signIn(`reception@${domain}`, PASSWORD);

    /*
     * Patients, registered THROUGH THE API — including the traps the acceptance
     * script turns on. Building them the way a receptionist does means the
     * fixture itself proves search-before-create and duplicate detection work.
     */
    const register = async (patient) => {
      const { data: dup } = await api(
        `/patients/duplicates?mobile=${encodeURIComponent(patient.mobileE164 ?? '')}&name=${encodeURIComponent(patient.fullName)}`,
        { cookie: reception },
      );
      const { data } = await api('/patients', {
        method: 'POST',
        cookie: reception,
        body: { ...patient, searchToken: dup.searchToken },
      });
      return data;
    };

    // Three family members on ONE number: the duplicate trap, and the reason a
    // broadcast must message a number once rather than a patient once.
    const shared = '+919876500011';
    const sunita = await register({
      fullName: 'Sunita Devi', mobileE164: shared, gender: 'FEMALE', dateOfBirth: '1992-03-14',
    });
    const ramesh = await register({
      fullName: 'Ramesh Kumar', mobileE164: shared, gender: 'MALE', dateOfBirth: '1988-07-02',
    });
    const aarav = await register({
      fullName: 'Aarav Kumar', mobileE164: shared, gender: 'MALE', dateOfBirth: '2020-01-22',
    });

    // The safety trap: the obvious prescription for a sore throat is a penicillin.
    const lakshmi = await register({
      fullName: 'Lakshmi Narayanan', mobileE164: '+919845500022', gender: 'FEMALE',
      dateOfBirth: '1974-06-09', tags: ['Chronic care'],
    });

    // Transliteration: same date of birth, different numbers.
    await register({
      fullName: 'Mohd Imran', mobileE164: '+919922300033', gender: 'MALE', dateOfBirth: '1985-11-30',
    });
    const mohammed = await register({
      fullName: 'Mohammed Imran', mobileE164: '+919922300044', gender: 'MALE', dateOfBirth: '1985-11-30',
    });

    // A stated age and no date of birth — common here, and refused by most EMRs.
    await register({
      fullName: 'Shantabai Pawar', mobileE164: '+919767100055', gender: 'FEMALE', ageYears: 45,
    });

    const arjun = await register({
      fullName: 'Arjun Patil', mobileE164: '+919922700066', gender: 'MALE', dateOfBirth: '2001-12-19',
    });

    const doctor = await signIn(`doctor@${domain}`, PASSWORD);
    await api(`/patients/${lakshmi.id}/allergies`, {
      method: 'POST',
      cookie: doctor,
      body: {
        patientId: lakshmi.id,
        category: 'MEDICATION',
        criticality: 'HIGH',
        substanceText: 'Penicillin',
        reactionDescription: 'Widespread rash and facial swelling within 2 hours',
        reactionSeverity: 'SEVERE',
      },
    });

    /*
     * Written directly, because there is no API that can create them.
     *
     *   consent      — captured on paper or verbally at the desk
     *   conversation — arrives from WhatsApp by webhook
     *   template     — approved by Meta, not by us
     *
     * Each is the real shape the product reads, not a stand-in.
     */
    for (const patient of [sunita, ramesh, aarav, lakshmi, arjun]) {
      await pool.query(
        `INSERT INTO consent (clinic_id, patient_id, scope, status, policy_version,
                              capture_method, presented_language, granted_at)
         VALUES ($1,$2,'WHATSAPP_COMMUNICATION','ACTIVE','v1.0','VERBAL_AT_DESK','en',now())`,
        [clinicId, patient.id],
      );
    }
    // Only one with marketing consent, so a marketing broadcast visibly reaches
    // fewer people than a clinical one.
    await pool.query(
      `INSERT INTO consent (clinic_id, patient_id, scope, status, policy_version,
                            capture_method, presented_language, granted_at)
       VALUES ($1,$2,'MARKETING_COMMUNICATION','ACTIVE','v1.0','WRITTEN_FORM','en',now())`,
      [clinicId, sunita.id],
    );

    // An opt-out beats a consent, and the audience builder must show that.
    await pool.query(
      `INSERT INTO whatsapp_conversation (clinic_id, patient_id, counterparty_e164, status,
                                          is_unread, is_opted_out, opted_out_at)
       VALUES ($1,$2,$3,'CLOSED',false,true,now())`,
      [clinicId, mohammed.id, '+919922300044'],
    );

    // An open conversation, inside its 24-hour window.
    const conversation = await pool.query(
      `INSERT INTO whatsapp_conversation (clinic_id, patient_id, counterparty_e164, last_inbound_at,
                                          window_expires_at, status, is_unread)
       VALUES ($1,$2,$3, now() - interval '1 hour', now() + interval '23 hours','OPEN',true)
       RETURNING id`,
      [clinicId, lakshmi.id, '+919845500022'],
    );

    await pool.query(
      `INSERT INTO communication (clinic_id, patient_id, conversation_id, channel, direction,
                                  status, body, queued_at, sent_at)
       VALUES ($1,$2,$3,'WHATSAPP','INBOUND','RECEIVED',
               'Doctor, is my report ready?', now() - interval '1 hour', now() - interval '1 hour')`,
      [clinicId, lakshmi.id, conversation.rows[0].id],
    );

    /*
     * A connected WhatsApp number.
     *
     * The token is not a real credential, which puts the client into its
     * simulated mode: messages are recorded with their real lifecycle and
     * nothing leaves the building. That is the state a clinic is in before Meta
     * approves its number, and it is the state the suites assert against —
     * sending must work end to end without a live provider.
     */
    await pool.query(
      `INSERT INTO whatsapp_account (clinic_id, waba_id, phone_number_id, display_phone_e164,
                                     verified_name, access_token_encrypted, quality_rating,
                                     messaging_tier, local_storage_region)
       VALUES ($1,'verify-waba','verify-phone-id','+919000000001','Verification Clinic',
               '', 'GREEN', '1,000 conversations / 24h', 'India')`,
      [clinicId],
    );

    await pool.query(
      `INSERT INTO message_template (clinic_id, name, language, category, status, body, variables, purpose)
       VALUES ($1,'clinic_closure_notice','en','UTILITY','APPROVED',
               'Namaste {{1}}, the clinic will be closed on {{2}}. Please plan your visit accordingly.',
               '[{"index":1,"label":"Patient name"},{"index":2,"label":"Date"}]'::jsonb,'CLINICAL')`,
      [clinicId],
    );

    /*
     * A platform operator.
     *
     * Written directly for the same reason the clinic administrator is: it is
     * what `provision-operator.ts` does, and a suite cannot shell out to it
     * portably. This account is deleted with the rest of the run.
     */
    const operatorEmail = `ops-${stamp}@verify.test`;
    await pool.query(
      `INSERT INTO platform_user (full_name, email, password_hash, role)
       VALUES ($1,$2,$3,'PLATFORM_ADMIN')`,
      [`Verify Operator ${stamp}`, operatorEmail, hash],
    );

    // Shell assignments the suites source.
    console.log(`export VERIFY_CLINIC_ID='${clinicId}'`);
    console.log(`export VERIFY_SLUG='${slug}'`);
    console.log(`export VERIFY_DOMAIN='${domain}'`);
    console.log(`export VERIFY_PASSWORD='${PASSWORD}'`);
    console.log(`export VERIFY_PATIENT_ALLERGIC='${lakshmi.id}'`);
    console.log(`export VERIFY_PATIENT_PLAIN='${arjun.id}'`);
    console.log(`export VERIFY_SHARED_NUMBER='${shared}'`);
    console.log(`export VERIFY_OPERATOR_EMAIL='${operatorEmail}'`);
    console.log(`export VERIFY_OPERATOR_PASSWORD='${PASSWORD}'`);
  } finally {
    await pool.end();
  }
}

/**
 * Deletes the clinic and everything in it.
 *
 * Foreign keys are RESTRICT throughout, so the order would matter — rather than
 * hand-maintaining a topological sort that breaks the next time a table is
 * added, this disables the FK triggers for one transaction and deletes every
 * table carrying this clinic_id. It runs as the migrator, on a test clinic, in
 * a script whose only job is teardown.
 */
async function down(clinicId) {
  if (!clinicId) throw new Error('Set VERIFY_CLINIC_ID to tear down.');

  // Validated, because it is about to be inlined. A DO block's body is a string
  // literal to Postgres, so $1 inside it is not a bind parameter — it is two
  // characters of SQL text. The id has to go in directly, so it has to be
  // proven to be a uuid first.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clinicId)) {
    throw new Error(`Not a clinic id: ${clinicId}`);
  }

  const pool = new pg.Pool({ connectionString: DB });
  try {
    await pool.query(
      `DO $do$
       DECLARE t text;
       BEGIN
         SET session_replication_role = replica;
         FOR t IN
           SELECT c.relname FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'clinic_id'
           WHERE c.relkind = 'r' AND n.nspname = 'public'
         LOOP
           EXECUTE format('DELETE FROM public.%I WHERE clinic_id = %L', t, '${clinicId}');
         END LOOP;
         DELETE FROM clinic WHERE id = '${clinicId}'::uuid;
         SET session_replication_role = origin;
       END $do$;`,
    );
    // platform_user has no clinic_id, so the sweep above does not reach it.
    await pool.query(`DELETE FROM platform_user WHERE email LIKE '%@verify.test'`);

    console.error(`  torn down ${clinicId}`);
  } finally {
    await pool.end();
  }
}

const command = process.argv[2];
if (command === 'up') {
  await up();
} else if (command === 'down') {
  await down(process.argv[3] ?? process.env.VERIFY_CLINIC_ID);
} else {
  console.error('Usage: fixtures.mjs up | down [clinicId]');
  process.exit(1);
}
