/**
 * Patient registry, consent, scheduling and the queue.
 *
 * FHIR mapping:
 *   patient      → Patient
 *   consent      → Consent
 *   appointment  → Appointment
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  appointmentStatusEnum,
  auditColumns,
  clinicIdColumn,
  consentScopeEnum,
  consentStatusEnum,
  genderEnum,
  primaryKeyColumn,
  tenantPolicy,
} from './shared';
import { appUser, clinic, clinicLocation, serviceItem } from './tenancy';

/* ------------------------------------------------------------------------- *
 * 5. Patient (FHIR Patient)
 * ------------------------------------------------------------------------- */

/**
 * The patient registry.
 *
 * DUPLICATE PREVENTION (risk R4) is the dominant design concern here, and the
 * Indian context defeats the naive approach:
 *   - one mobile number commonly serves a whole family, so mobile is NOT unique
 *   - transliteration is unstable (Mohd / Mohammed / Muhammad)
 *   - date of birth is frequently unknown; patients state an approximate age
 *   - no identifier can be made mandatory (Aadhaar cannot be compelled)
 *
 * The countermeasures are: E.164 normalisation at write time, a trigram index
 * over a normalised name for fuzzy matching, an explicit age-when-DOB-unknown
 * path, and a merge tool that never runs automatically.
 */
export const patient = pgTable(
  'patient',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    /**
     * Human-readable medical record number, generated per clinic
     * (e.g. "MRN-000142"). Unique within the clinic, spoken aloud at the desk.
     */
    mrn: text('mrn').notNull(),

    fullName: text('full_name').notNull(),
    /**
     * Lowercased, unaccented, whitespace-collapsed name used ONLY for fuzzy
     * duplicate detection via pg_trgm. Written by trigger; never displayed.
     */
    nameNormalized: text('name_normalized').notNull(),

    /**
     * E.164 (e.g. "+919876543210"). Normalised at write time so that
     * "98765 43210", "09876543210" and "+91 98765 43210" collide correctly —
     * without this, duplicate detection silently fails.
     * Nullable: walk-in patients without a phone do exist.
     */
    mobileE164: text('mobile_e164'),
    /** True when the number belongs to a relative (very common). Suppresses direct WhatsApp. */
    mobileBelongsToRelative: boolean('mobile_belongs_to_relative').notNull().default(false),
    alternatePhoneE164: text('alternate_phone_e164'),
    email: text('email'),

    gender: genderEnum('gender').notNull().default('UNKNOWN'),

    /** Exact DOB when known. */
    dateOfBirth: date('date_of_birth'),
    /**
     * Stated age in years, captured when DOB is unknown. Paired with
     * `ageRecordedAt` so the patient's current age can be derived later —
     * storing a bare age would silently rot and corrupt paediatric dosing.
     */
    ageYears: integer('age_years'),
    ageRecordedAt: date('age_recorded_at'),

    bloodGroup: text('blood_group'),

    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    state: text('state'),
    pincode: text('pincode'),

    /** 14-digit ABDM health account. Null until the patient opts in (M1). */
    abhaNumber: text('abha_number'),

    /** Set by the client, once per registration attempt. See the index below. */
    idempotencyKey: text('idempotency_key'),
    abhaAddress: text('abha_address'),

    /** Free-text flag surfaced prominently on the Patient Snapshot. */
    clinicalAlert: text('clinical_alert'),

    /* --- Emergency contact (SoW §6.2) --- */
    emergencyContactName: text('emergency_contact_name'),
    emergencyContactPhoneE164: text('emergency_contact_phone_e164'),
    emergencyContactRelation: text('emergency_contact_relation'),

    /**
     * Clinic-defined labels (SoW §6.2), e.g. "Camp patient", "Corporate",
     * "Insurance". A text array rather than JSONB so it can be GIN-indexed and
     * filtered on in reports without a JSON traversal.
     */
    tags: text('tags').array().notNull().default(sql`ARRAY[]::text[]`),

    /** Free-text staff notes on the patient record (SoW §6.2). Not clinical content. */
    notes: text('notes'),

    /**
     * Structured overflow: occupation, referral source, and any unmapped source
     * columns preserved during import (see Annex 8 §2.5).
     */
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),

    isActive: boolean('is_active').notNull().default(true),
    deceasedDate: date('deceased_date'),

    /**
     * Set when this record has been merged INTO another. The row is retained
     * permanently for traceability — merges are never destructive, because an
     * incorrect merge is far harder to unwind than a duplicate.
     */
    mergedIntoPatientId: uuid('merged_into_patient_id'),
    mergedAt: timestamp('merged_at', { withTimezone: true }),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({
      columns: [t.mergedIntoPatientId],
      foreignColumns: [t.id],
    }).onDelete('restrict'),

    uniqueIndex('patient_clinic_mrn_uq').on(t.clinicId, t.mrn),
    /*
     * One registration per attempt.
     *
     * The registration flow already half-prevented a duplicate by accident: the
     * search token is consumed on use, so a second identical submit was refused.
     * But it was refused with "search for the patient before creating a new
     * record", which is a confusing message for somebody who just did — and it
     * told them nothing about whether the first attempt had worked. With a key
     * the retry returns the patient that was created, which is the answer they
     * were looking for.
     */
    uniqueIndex('patient_idempotency_uq')
      .on(t.clinicId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),

    /** The front desk's primary lookup. Must satisfy the <60s registration flow. */
    index('patient_clinic_mobile_idx')
      .on(t.clinicId, t.mobileE164)
      .where(sql`mobile_e164 IS NOT NULL`),

    /*
     * Fuzzy name search.
     *
     * Leads with clinic_id via btree_gin. Every index must: the RLS predicate
     * filters on clinic_id on every query, so an index that does not lead with
     * it cannot serve the filter and the planner falls back to a scan that RLS
     * then discards. An RLS-protected table with non-tenant-leading indexes
     * performs catastrophically, and the symptom only appears once a second
     * tenant exists.
     *
     * Not CONCURRENTLY: a migration runs inside a transaction, and
     * CREATE INDEX CONCURRENTLY cannot. It is also pointless on an empty table.
     */
    index('patient_clinic_name_trgm_idx').using(
      'gin',
      t.clinicId.op('uuid_ops'),
      t.nameNormalized.op('gin_trgm_ops'),
    ),

    index('patient_clinic_created_idx').on(t.clinicId, t.createdAt.desc()),
    index('patient_clinic_active_idx')
      .on(t.clinicId)
      .where(sql`is_active = true AND merged_into_patient_id IS NULL`),

    /** ABHA is globally unique when present. */
    uniqueIndex('patient_abha_uq').on(t.abhaNumber).where(sql`abha_number IS NOT NULL`),

    /** Tag filtering in reports, without a JSON traversal. */
    index('patient_clinic_tags_idx').using('gin', t.tags),

    tenantPolicy('patient'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * Patient merge log
 * ------------------------------------------------------------------------- */

/**
 * Immutable record of every merge. Retained indefinitely: if a clinician later
 * questions why a history looks the way it does, this is the only way to
 * reconstruct it.
 */
export const patientMergeLog = pgTable(
  'patient_merge_log',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    survivingPatientId: uuid('surviving_patient_id').notNull(),
    mergedPatientId: uuid('merged_patient_id').notNull(),

    /** Counts of re-parented rows, for post-hoc verification. */
    reparentedCounts: jsonb('reparented_counts').notNull().default(sql`'{}'::jsonb`),
    /** Full snapshot of the merged record as it existed before the merge. */
    mergedRecordSnapshot: jsonb('merged_record_snapshot').notNull(),

    performedBy: uuid('performed_by').notNull(),
    reason: text('reason'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.survivingPatientId], foreignColumns: [patient.id] }),
    foreignKey({ columns: [t.mergedPatientId], foreignColumns: [patient.id] }),
    index('patient_merge_log_clinic_idx').on(t.clinicId, t.createdAt.desc()),
    index('patient_merge_log_surviving_idx').on(t.clinicId, t.survivingPatientId),
    tenantPolicy('patient_merge_log'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * 6. Consent (FHIR Consent)
 * ------------------------------------------------------------------------- */

/**
 * DPDP Rules 2025 require consent that is purpose-specific, informed, and
 * independently withdrawable. Therefore: one row per (patient, scope), never a
 * single bundled agreement flag.
 *
 * Withdrawal is modelled as status transition plus `withdrawnAt` — rows are
 * never deleted, because proving that consent WAS held at the time of a past
 * processing activity is the whole point of the record.
 */
export const consent = pgTable(
  'consent',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    patientId: uuid('patient_id').notNull(),

    scope: consentScopeEnum('scope').notNull(),
    status: consentStatusEnum('status').notNull().default('ACTIVE'),

    /** Version of the notice text the patient was shown — required by DPDP. */
    policyVersion: text('policy_version').notNull(),
    /** How consent was captured: IN_PERSON_SIGNED, VERBAL_RECORDED, DIGITAL_OTP. */
    captureMethod: text('capture_method').notNull(),
    /** Language the notice was presented in — DPDP requires the patient's choice of language. */
    presentedLanguage: text('presented_language').notNull().default('en'),

    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null = open-ended. ABDM linkage consents are always time-bounded. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    withdrawnReason: text('withdrawn_reason'),

    /** S3 key of the signed consent form, where one was captured on paper. */
    evidenceObjectKey: text('evidence_object_key'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.patientId], foreignColumns: [patient.id] }).onDelete('restrict'),
    index('consent_clinic_patient_idx').on(t.clinicId, t.patientId),
    /** At most one ACTIVE consent per purpose per patient. */
    uniqueIndex('consent_active_scope_uq')
      .on(t.clinicId, t.patientId, t.scope)
      .where(sql`status = 'ACTIVE'`),
    tenantPolicy('consent'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * 7. Appointment (FHIR Appointment) — and the live queue
 * ------------------------------------------------------------------------- */

/**
 * Appointment doubles as the live OPD queue.
 *
 * Modelling the queue as a separate entity was considered and rejected: in a
 * 1–5 doctor outpatient clinic, roughly 60–80% of patients are walk-ins who are
 * queued and never "booked". A separate queue table would mean two sources of
 * truth for "who is waiting", which reliably diverges. Instead, a walk-in
 * creates an appointment already in ARRIVED status, and the queue is a query:
 *
 *   WHERE status IN ('ARRIVED','IN_PROGRESS')
 *     AND scheduled_start::date = current_date
 *   ORDER BY queue_position, arrived_at
 */
export const appointment = pgTable(
  'appointment',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    patientId: uuid('patient_id').notNull(),
    /** Nullable: a walk-in may be queued before a doctor is assigned. */
    practitionerId: uuid('practitioner_id'),
    locationId: uuid('location_id'),

    /**
     * What the patient is booked IN FOR.
     *
     * `BookAppointment` has always accepted a `serviceItemId` and the booking
     * path has always used it — to look up the service's duration and work out
     * the end time — and then thrown it away, because there was no column to put
     * it in. So the clinic chose a service, the slot length came from it, and
     * nothing afterwards could say which service the appointment was.
     *
     * The cost of that showed up in the analytics: "how many consultations
     * versus dressings did we book last month" is a question the schema could
     * not answer, so the service filter there narrows revenue only and the
     * control says so. This column is what makes it answerable going forward;
     * appointments booked before it exists keep a null and are honestly
     * uncategorised rather than retrospectively guessed at.
     *
     * `set null` on delete: retiring a service from the price list must not
     * delete the history of appointments booked under it.
     */
    serviceItemId: uuid('service_item_id'),

    /**
     * Set by the client, once per booking attempt.
     *
     * A booking and a walk-in both write this table, and both are taken at a
     * busy front desk where the first tap does not visibly do anything — so the
     * terminal gets tapped again, or the request times out and the receptionist
     * retries with a patient standing there. Two appointments for one person at
     * one time is then something somebody has to notice and cancel, and until
     * they do, the day looks fuller than it is and the doctor is double-booked.
     *
     * Nullable because every appointment made before this column existed has no
     * key, and inventing one would be a claim about a request nobody recorded.
     */
    idempotencyKey: text('idempotency_key'),

    status: appointmentStatusEnum('status').notNull().default('SCHEDULED'),

    scheduledStart: timestamp('scheduled_start', { withTimezone: true }).notNull(),
    scheduledEnd: timestamp('scheduled_end', { withTimezone: true }),

    /** Set when the receptionist checks the patient in — starts the wait clock. */
    arrivedAt: timestamp('arrived_at', { withTimezone: true }),
    /** Set when the doctor opens the encounter. */
    calledAt: timestamp('called_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /**
     * When the front desk closed the visit.
     *
     * Separate from `completedAt`, which is when the clinician finished. The gap
     * between the two is how long a patient stood at the desk, and it is the only
     * way to tell a visit that was settled from one the patient walked out of.
     */
    checkedOutAt: timestamp('checked_out_at', { withTimezone: true }),
    checkedOutBy: uuid('checked_out_by'),

    /**
     * Manual ordering within the day's queue. Sparse integers (10, 20, 30…) so
     * a patient can be re-prioritised without renumbering the whole queue —
     * which matters because the front desk reorders constantly.
     */
    queuePosition: integer('queue_position'),

    /** True for unbooked walk-ins; drives queue display and no-show analytics. */
    isWalkIn: boolean('is_walk_in').notNull().default(false),

    reasonText: text('reason_text'),
    notes: text('notes'),

    cancelledReason: text('cancelled_reason'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.patientId], foreignColumns: [patient.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.serviceItemId], foreignColumns: [serviceItem.id] }).onDelete(
      'set null',
    ),
    /*
     * The guarantee lives here, not in the service.
     *
     * A check-then-insert in application code loses the race to two concurrent
     * requests, which is exactly the double-tap this guards against. The service
     * lookup turns the loser's constraint violation into a sensible answer; the
     * index is what makes one of them lose.
     *
     * Leading with clinic_id so two clinics generating the same key cannot block
     * each other, and partial so the rows predating the column are not all but
     * one rejected.
     */
    uniqueIndex('appointment_idempotency_uq')
      .on(t.clinicId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    foreignKey({ columns: [t.practitionerId], foreignColumns: [appUser.id] }).onDelete('set null'),
    foreignKey({ columns: [t.locationId], foreignColumns: [clinicLocation.id] }).onDelete('set null'),

    index('appointment_clinic_start_idx').on(t.clinicId, t.scheduledStart),
    index('appointment_clinic_patient_idx').on(t.clinicId, t.patientId, t.scheduledStart.desc()),
    index('appointment_clinic_practitioner_idx').on(
      t.clinicId,
      t.practitionerId,
      t.scheduledStart,
    ),

    /**
     * The live-queue index. Partial, so it stays tiny (tens of rows) regardless
     * of how many years of appointment history the clinic accumulates — the
     * queue screen polls this constantly and must never scan history.
     */
    index('appointment_live_queue_idx')
      .on(t.clinicId, t.queuePosition, t.arrivedAt)
      .where(sql`status IN ('ARRIVED','IN_PROGRESS')`),

    tenantPolicy('appointment'),
  ],
).enableRLS();
