/**
 * The clinical record: Encounter, Observation, Condition, AllergyIntolerance,
 * MedicationRequest, DocumentReference — plus the drug catalogue and the
 * physically isolated internal-note table.
 *
 * FHIR mapping:
 *   encounter           → Encounter
 *   observation         → Observation (vital signs profile)
 *   condition           → Condition
 *   allergyIntolerance  → AllergyIntolerance
 *   medicationRequest   → MedicationRequest
 *   documentReference   → DocumentReference / DiagnosticReport
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  allergyCategoryEnum,
  allergyCriticalityEnum,
  auditColumns,
  clinicIdColumn,
  conditionClinicalStatusEnum,
  conditionVerificationStatusEnum,
  documentStatusEnum,
  documentTypeEnum,
  encounterStatusEnum,
  consultationModeEnum,
  medicationRequestStatusEnum,
  observationStatusEnum,
  primaryKeyColumn,
  reactionSeverityEnum,
  sharedReferencePolicy,
  tenantPolicy,
} from './shared';
import { appUser, clinic, clinicLocation } from './tenancy';
import { appointment, patient } from './patient';

/* ------------------------------------------------------------------------- *
 * 8. Encounter (FHIR Encounter)
 * ------------------------------------------------------------------------- */

/**
 * One consultation. The central clinical entity — Observations, Conditions and
 * MedicationRequests all hang off it.
 *
 * FINALISATION is the critical state transition. Once `isFinalized` is true the
 * clinical content becomes immutable: corrections are made by appending an
 * amendment, never by editing history. This is enforced by a database trigger
 * (migration 0001), not only by application logic, because an EMR whose past
 * records can be silently rewritten has no evidentiary value.
 */
export const encounter = pgTable(
  'encounter',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    patientId: uuid('patient_id').notNull(),
    practitionerId: uuid('practitioner_id').notNull(),
    appointmentId: uuid('appointment_id'),
    locationId: uuid('location_id'),

    status: encounterStatusEnum('status').notNull().default('IN_PROGRESS'),

    /**
     * In the room, or remote. Decides whether the Schedule X prohibition
     * applies and whether the printed prescription carries the teleconsultation
     * declaration. See `consultationModeEnum`.
     */
    consultationMode: consultationModeEnum('consultation_mode')
      .notNull()
      .default('IN_PERSON'),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),

    /* --- Clinical narrative (SOAP) --- *
     * Free text is retained alongside coded Conditions/Observations because
     * doctors in this segment will not code everything, and forcing them to
     * would breach the <adoption> constraint that dominates risk R6.
     */
    chiefComplaint: text('chief_complaint'),
    /** Subjective — history of presenting illness. */
    historyOfPresentIllness: text('history_of_present_illness'),
    /** Objective — examination findings not captured as discrete Observations. */
    examinationNotes: text('examination_notes'),
    /** Assessment — narrative; coded diagnoses live in `condition`. */
    assessmentNotes: text('assessment_notes'),
    /** Plan — advice, follow-up instructions. Printed on the prescription. */
    planNotes: text('plan_notes'),

    followUpAfterDays: integer('follow_up_after_days'),
    followUpInstructions: text('follow_up_instructions'),

    /* --- Finalisation --- */

    /**
     * Once true, clinical content is frozen. Only a DOCTOR may set this
     * (enforced by RolesGuard) and only the authoring practitioner or an
     * OWNER_ADMIN may subsequently append an amendment.
     */
    isFinalized: boolean('is_finalized').notNull().default(false),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    finalizedBy: uuid('finalized_by'),

    /**
     * Amendment chain. A correction creates a NEW encounter row referencing the
     * original; the original is never mutated. Mirrors FHIR's
     * `Encounter.partOf` + provenance pattern.
     */
    amendsEncounterId: uuid('amends_encounter_id'),
    amendmentReason: text('amendment_reason'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.patientId], foreignColumns: [patient.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.practitionerId], foreignColumns: [appUser.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.appointmentId], foreignColumns: [appointment.id] }).onDelete('set null'),
    foreignKey({ columns: [t.locationId], foreignColumns: [clinicLocation.id] }).onDelete('set null'),
    foreignKey({ columns: [t.amendsEncounterId], foreignColumns: [t.id] }).onDelete('restrict'),

    /** Patient Snapshot's primary query: most recent encounters for a patient. */
    index('encounter_clinic_patient_started_idx').on(
      t.clinicId,
      t.patientId,
      t.startedAt.desc(),
    ),
    index('encounter_clinic_practitioner_idx').on(
      t.clinicId,
      t.practitionerId,
      t.startedAt.desc(),
    ),
    /** Partial: unfinalised encounters are a small working set; used by the "resume draft" prompt. */
    index('encounter_clinic_open_idx')
      .on(t.clinicId, t.practitionerId)
      .where(sql`is_finalized = false AND status = 'IN_PROGRESS'`),

    tenantPolicy('encounter'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * Encounter internal note — PHYSICALLY ISOLATED
 * ------------------------------------------------------------------------- */

/**
 * ============================ SECURITY BOUNDARY ============================
 * Internal clinical notes that must NEVER be transmitted to a patient.
 *
 * The SoW requires that internal notes be structurally incapable of external
 * dispatch. A boolean flag on the `communication` table would NOT satisfy this:
 * one defective `WHERE is_internal = false` predicate would send a doctor's
 * private observation to the patient.
 *
 * Instead this is a separate table, and the messaging worker's database role
 * (`emr_worker_messaging`) is granted no privileges on it whatsoever — see
 * migration 0001. The worker cannot read these rows, therefore it cannot send
 * them. The guarantee is structural, not procedural.
 *
 * No code in the messaging module may import this table. Enforced by an ESLint
 * `no-restricted-imports` rule and asserted in the security test suite.
 * ===========================================================================
 */
export const encounterInternalNote = pgTable(
  'encounter_internal_note',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),

    note: text('note').notNull(),

    /** Notes remain editable after encounter finalisation — they are not part of the clinical record. */
    authorId: uuid('author_id').notNull(),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.encounterId], foreignColumns: [encounter.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.patientId], foreignColumns: [patient.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.authorId], foreignColumns: [appUser.id] }).onDelete('restrict'),
    index('encounter_internal_note_encounter_idx').on(t.clinicId, t.encounterId),
    tenantPolicy('encounter_internal_note'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * 9. Observation (FHIR Observation — vital signs)
 * ------------------------------------------------------------------------- */

/**
 * Vitals and point-of-care measurements.
 *
 * Stored as one row per measurement with a LOINC code, rather than as wide
 * columns on the encounter, so that (a) the FHIR mapping is direct, (b) trend
 * charts are a simple time-series query, and (c) new measurement types need no
 * migration.
 */
export const observation = pgTable(
  'observation',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    patientId: uuid('patient_id').notNull(),
    /** Nullable: a nurse may record vitals in the queue before the encounter opens. */
    encounterId: uuid('encounter_id'),

    status: observationStatusEnum('status').notNull().default('FINAL'),

    /** LOINC code, e.g. "8480-6" (systolic BP), "29463-7" (body weight). */
    code: text('code').notNull(),
    codeSystem: text('code_system').notNull().default('http://loinc.org'),
    /** Human label shown in the UI, e.g. "Systolic BP". */
    display: text('display').notNull(),

    /**
     * Numeric result. `numeric` not `float` — clinical values must not carry
     * floating-point representation error.
     */
    valueNumeric: numeric('value_numeric', { precision: 12, scale: 4 }),
    /** UCUM unit, e.g. "mm[Hg]", "kg", "Cel". */
    valueUnit: text('value_unit'),
    /** For non-numeric results, e.g. "Regular" for pulse rhythm. */
    valueText: text('value_text'),

    /** Reference range at time of measurement, for age/sex-appropriate flagging. */
    referenceLow: numeric('reference_low', { precision: 12, scale: 4 }),
    referenceHigh: numeric('reference_high', { precision: 12, scale: 4 }),
    /** HIGH / LOW / CRITICAL — computed at write time and surfaced in the Snapshot. */
    interpretation: text('interpretation'),

    /** When the measurement was TAKEN, which may precede when it was entered. */
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull().defaultNow(),
    recordedBy: uuid('recorded_by').notNull(),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.patientId], foreignColumns: [patient.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.encounterId], foreignColumns: [encounter.id] }).onDelete('set null'),
    foreignKey({ columns: [t.recordedBy], foreignColumns: [appUser.id] }).onDelete('restrict'),

    /** Trend queries: "show me this patient's BP over time". */
    index('observation_clinic_patient_code_idx').on(
      t.clinicId,
      t.patientId,
      t.code,
      t.effectiveAt.desc(),
    ),
    index('observation_clinic_encounter_idx').on(t.clinicId, t.encounterId),
    tenantPolicy('observation'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * 10. Condition (FHIR Condition — diagnoses)
 * ------------------------------------------------------------------------- */

export const condition = pgTable(
  'condition',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    patientId: uuid('patient_id').notNull(),
    /** Nullable: chronic conditions recorded at registration precede any encounter. */
    encounterId: uuid('encounter_id'),

    clinicalStatus: conditionClinicalStatusEnum('clinical_status').notNull().default('ACTIVE'),
    verificationStatus: conditionVerificationStatusEnum('verification_status')
      .notNull()
      .default('CONFIRMED'),

    /** ICD-10 / SNOMED CT code. Nullable — see `displayText`. */
    code: text('code'),
    codeSystem: text('code_system'),
    /**
     * The diagnosis as the doctor expressed it. NOT NULL even when a code is
     * present: doctors in this segment frequently record uncoded diagnoses, and
     * refusing to save an uncoded diagnosis is the fastest way to lose adoption.
     */
    displayText: text('display_text').notNull(),

    /** True for chronic conditions pinned to the top of the Patient Snapshot. */
    isChronic: boolean('is_chronic').notNull().default(false),

    onsetDate: timestamp('onset_date', { withTimezone: true }),
    abatementDate: timestamp('abatement_date', { withTimezone: true }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    recordedBy: uuid('recorded_by').notNull(),

    notes: text('notes'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.patientId], foreignColumns: [patient.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.encounterId], foreignColumns: [encounter.id] }).onDelete('set null'),
    foreignKey({ columns: [t.recordedBy], foreignColumns: [appUser.id] }).onDelete('restrict'),

    index('condition_clinic_patient_idx').on(t.clinicId, t.patientId, t.recordedAt.desc()),
    /** Snapshot query: active + chronic problems, pinned. */
    index('condition_clinic_active_idx')
      .on(t.clinicId, t.patientId)
      .where(sql`clinical_status = 'ACTIVE'`),
    index('condition_clinic_encounter_idx').on(t.clinicId, t.encounterId),
    tenantPolicy('condition'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * 11. AllergyIntolerance (FHIR AllergyIntolerance)
 * ------------------------------------------------------------------------- */

/**
 * SAFETY-CRITICAL. This table is read on every prescribing action to cross-check
 * against the drug being prescribed. A false negative here is a patient-harm
 * event.
 *
 * Note the deliberate distinction between `criticality` (risk of a future
 * reaction) and `reactionSeverity` (how bad a past reaction was). Clinicians use
 * both and conflating them loses information that changes prescribing decisions.
 */
export const allergyIntolerance = pgTable(
  'allergy_intolerance',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    patientId: uuid('patient_id').notNull(),
    encounterId: uuid('encounter_id'),

    category: allergyCategoryEnum('category').notNull(),
    criticality: allergyCriticalityEnum('criticality').notNull().default('UNABLE_TO_ASSESS'),

    /**
     * The substance. For MEDICATION allergies this SHOULD reference a catalogue
     * molecule so cross-checking is exact rather than string matching — but the
     * free-text path must remain open for substances outside the catalogue.
     */
    substanceMoleculeId: uuid('substance_molecule_id'),
    substanceText: text('substance_text').notNull(),
    substanceCode: text('substance_code'),

    /** Free text, e.g. "rash and facial swelling within 2 hours". */
    reactionDescription: text('reaction_description'),
    reactionSeverity: reactionSeverityEnum('reaction_severity'),

    onsetDate: timestamp('onset_date', { withTimezone: true }),
    /** Set when an allergy is later disproved; row is retained, never deleted. */
    refutedAt: timestamp('refuted_at', { withTimezone: true }),

    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    recordedBy: uuid('recorded_by').notNull(),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.patientId], foreignColumns: [patient.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.encounterId], foreignColumns: [encounter.id] }).onDelete('set null'),
    foreignKey({ columns: [t.recordedBy], foreignColumns: [appUser.id] }).onDelete('restrict'),

    /**
     * Partial index on active allergies. This is on the hot path of every
     * prescribing action and of every Patient Snapshot load.
     */
    index('allergy_clinic_patient_active_idx')
      .on(t.clinicId, t.patientId)
      .where(sql`refuted_at IS NULL`),
    index('allergy_clinic_molecule_idx')
      .on(t.clinicId, t.substanceMoleculeId)
      .where(sql`substance_molecule_id IS NOT NULL AND refuted_at IS NULL`),
    tenantPolicy('allergy_intolerance'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * Drug catalogue (shared reference data)
 * ------------------------------------------------------------------------- */

/**
 * Prescribable items. Rows owned by SYSTEM_CLINIC_ID are the shared catalogue,
 * readable by every tenant; rows owned by a real clinic are that clinic's custom
 * formulations and are private to it. See `sharedReferencePolicy`.
 *
 * PROCUREMENT DEPENDENCY (risk R5): a comprehensive Indian catalogue with
 * interaction data must be licensed. `catalogueVersion` is stamped onto every
 * MedicationRequest so that a later clinical review can establish exactly what
 * reference data was in force at the time of prescribing.
 */
export const drugCatalogueItem = pgTable(
  'drug_catalogue_item',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    /** Brand name as marketed in India, e.g. "Crocin 500". */
    brandName: text('brand_name'),
    /** Generic/molecule name, e.g. "Paracetamol". The clinical identity of the drug. */
    moleculeName: text('molecule_name').notNull(),
    /** Normalised for trigram search across brand and molecule. */
    searchNormalized: text('search_normalized').notNull(),

    strength: text('strength'), // "500 mg"
    dosageForm: text('dosage_form'), // "Tablet", "Syrup", "Injection"
    route: text('route'), // "Oral", "IV", "Topical"
    manufacturer: text('manufacturer'),

    /** Schedule H / H1 / X. Schedule X may not be prescribed via telemedicine. */
    drugSchedule: text('drug_schedule'),
    isNarcotic: boolean('is_narcotic').notNull().default(false),

    /** Version identifier of the source catalogue release. */
    catalogueVersion: text('catalogue_version').notNull(),
    isActive: boolean('is_active').notNull().default(true),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    /*
     * Drug search runs while the doctor types, several times per prescription,
     * so it has to return in well under 200ms. Leads with clinic_id for the
     * same reason every other index does — see the patient name index.
     */
    index('drug_catalogue_search_trgm_idx').using(
      'gin',
      t.clinicId.op('uuid_ops'),
      t.searchNormalized.op('gin_trgm_ops'),
    ),
    index('drug_catalogue_clinic_molecule_idx').on(t.clinicId, t.moleculeName),
    ...sharedReferencePolicy('drug_catalogue_item'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * 12. MedicationRequest (FHIR MedicationRequest — prescriptions)
 * ------------------------------------------------------------------------- */

/**
 * One prescribed drug. A prescription document is the set of MedicationRequests
 * sharing an `encounterId`.
 *
 * Immutable once the parent encounter is finalised — a dispensed prescription
 * that can be silently edited afterwards is a fraud and liability vector.
 * Changes are made by STOPPING the original and issuing a new one.
 */
export const medicationRequest = pgTable(
  'medication_request',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    patientId: uuid('patient_id').notNull(),
    encounterId: uuid('encounter_id').notNull(),
    practitionerId: uuid('practitioner_id').notNull(),

    status: medicationRequestStatusEnum('status').notNull().default('DRAFT'),

    /** Nullable: doctors must be able to prescribe items not in the catalogue. */
    catalogueItemId: uuid('catalogue_item_id'),
    /** Denormalised at write time so the historical record survives catalogue changes. */
    drugDisplayName: text('drug_display_name').notNull(),
    moleculeName: text('molecule_name'),
    strength: text('strength'),
    dosageForm: text('dosage_form'),
    route: text('route'),

    /* --- Dosing --- */
    /** Structured frequency, e.g. "1-0-1" (morning-noon-night) — the Indian convention. */
    frequency: text('frequency').notNull(),
    /** "Before food" / "After food". Clinically significant for many molecules. */
    timingRelativeToFood: text('timing_relative_to_food'),
    durationDays: integer('duration_days'),
    quantity: numeric('quantity', { precision: 10, scale: 2 }),
    /** Free-text instructions printed verbatim on the PDF. Server-side length-capped (risk R3). */
    instructions: text('instructions'),

    /** Which indication this drug addresses; links prescription to diagnosis. */
    reasonConditionId: uuid('reason_condition_id'),

    /* --- Safety --- */
    /**
     * Warnings shown to the prescriber at the time of signing, and the doctor's
     * response. Persisted so that a later review can establish what the system
     * told the clinician and what they decided — this is the clinic's evidence
     * of safe practice, and the product's evidence of having warned.
     */
    safetyWarningsShown: jsonb('safety_warnings_shown').notNull().default(sql`'[]'::jsonb`),
    safetyOverrideReason: text('safety_override_reason'),
    /** Catalogue release in force when this was prescribed (risk R5 traceability). */
    catalogueVersionAtPrescribing: text('catalogue_version_at_prescribing'),

    authoredAt: timestamp('authored_at', { withTimezone: true }).notNull().defaultNow(),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.patientId], foreignColumns: [patient.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.encounterId], foreignColumns: [encounter.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.practitionerId], foreignColumns: [appUser.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.catalogueItemId], foreignColumns: [drugCatalogueItem.id] }).onDelete('set null'),
    foreignKey({ columns: [t.reasonConditionId], foreignColumns: [condition.id] }).onDelete('set null'),

    index('medication_request_clinic_patient_idx').on(
      t.clinicId,
      t.patientId,
      t.authoredAt.desc(),
    ),
    /** Assembling the prescription PDF: all drugs for one encounter. */
    index('medication_request_clinic_encounter_idx').on(t.clinicId, t.encounterId),
    /** "What is this patient currently taking?" — shown on the Snapshot. */
    index('medication_request_clinic_active_idx')
      .on(t.clinicId, t.patientId)
      .where(sql`status = 'ACTIVE'`),
    tenantPolicy('medication_request'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * 13. DocumentReference (FHIR DocumentReference / DiagnosticReport)
 * ------------------------------------------------------------------------- */

/**
 * Metadata for every stored file: generated prescription PDFs, uploaded lab
 * reports, scanned consent forms.
 *
 * Binary content is NEVER stored in Postgres — only the S3 object key. The key
 * always embeds the tenant prefix (`clinics/{clinic_id}/…`) so that a leaked
 * key cannot be mutated into another tenant's path without failing the bucket
 * policy condition.
 */
export const documentReference = pgTable(
  'document_reference',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    patientId: uuid('patient_id').notNull(),
    encounterId: uuid('encounter_id'),

    status: documentStatusEnum('status').notNull().default('CURRENT'),
    documentType: documentTypeEnum('document_type').notNull(),

    title: text('title').notNull(),
    description: text('description'),

    /** S3 object key. Format: clinics/{clinic_id}/{type}/{yyyy}/{mm}/{uuid}.{ext} */
    objectKey: text('object_key').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),

    /**
     * SHA-256 of the file, computed at generation/upload time. For generated
     * prescriptions this is the tamper-evidence anchor: any later dispute about
     * what the document said is resolvable against this hash.
     */
    contentSha256: text('content_sha256').notNull(),

    /* --- Signing (prescriptions) --- */
    /** Base64 signature over contentSha256, bound to the signing doctor's session. */
    signatureValue: text('signature_value'),
    signedBy: uuid('signed_by'),
    signedAt: timestamp('signed_at', { withTimezone: true }),

    /* --- Patient uploads --- */
    /** PENDING / CLEAN / INFECTED. Patient-supplied files are not served until CLEAN. */
    virusScanStatus: text('virus_scan_status'),
    virusScannedAt: timestamp('virus_scanned_at', { withTimezone: true }),

    /** Supersession chain, for corrected lab reports and reissued prescriptions. */
    supersedesDocumentId: uuid('supersedes_document_id'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.patientId], foreignColumns: [patient.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.encounterId], foreignColumns: [encounter.id] }).onDelete('set null'),
    foreignKey({ columns: [t.signedBy], foreignColumns: [appUser.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.supersedesDocumentId], foreignColumns: [t.id] }).onDelete('restrict'),

    uniqueIndex('document_reference_object_key_uq').on(t.objectKey),
    index('document_reference_clinic_patient_idx').on(
      t.clinicId,
      t.patientId,
      t.createdAt.desc(),
    ),
    index('document_reference_clinic_encounter_idx').on(t.clinicId, t.encounterId),
    index('document_reference_clinic_type_idx').on(t.clinicId, t.documentType, t.createdAt.desc()),
    tenantPolicy('document_reference'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * 14. Encounter template (SoW §6.5)
 * ------------------------------------------------------------------------- */

/**
 * Reusable specialty or per-doctor consultation templates.
 *
 * Required by SoW §6.5 ("Reusable specialty/doctor templates with ability to
 * override fields"), and load-bearing for risk R6: a doctor who must retype the
 * same examination findings forty times a day will abandon the product for a
 * paper pad. Templates are the difference between typing and confirming.
 *
 * Applying a template pre-fills an EDITABLE DRAFT. Per SoW §6.4, clinical facts
 * are never carried forward as current without user action.
 */
export const encounterTemplate = pgTable(
  'encounter_template',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    name: text('name').notNull(),
    specialty: text('specialty'),

    /** Null = shared across the clinic; set = private to one practitioner. */
    practitionerId: uuid('practitioner_id'),

    /* Pre-filled narrative sections; every one is editable after application. */
    chiefComplaint: text('chief_complaint'),
    historyOfPresentIllness: text('history_of_present_illness'),
    examinationNotes: text('examination_notes'),
    assessmentNotes: text('assessment_notes'),
    planNotes: text('plan_notes'),
    followUpAfterDays: integer('follow_up_after_days'),

    /**
     * Observation codes this template prompts for, e.g. a paediatric template
     * prompting weight and height. Shape:
     * [{ code, display, unit, required }]
     */
    promptedObservations: jsonb('prompted_observations').notNull().default(sql`'[]'::jsonb`),

    /** Surfaces the doctor's most-used templates first. */
    usageCount: integer('usage_count').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.practitionerId], foreignColumns: [appUser.id] }).onDelete('cascade'),
    uniqueIndex('encounter_template_clinic_name_uq').on(t.clinicId, t.practitionerId, t.name),
    index('encounter_template_clinic_usage_idx')
      .on(t.clinicId, t.usageCount.desc())
      .where(sql`is_active = true`),
    tenantPolicy('encounter_template'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * 15. Prescription template (SoW §6.6)
 * ------------------------------------------------------------------------- */

/**
 * Reusable medicine combinations — "URI adult standard", "paediatric fever
 * ≤ 20 kg". Required by SoW §6.6.
 *
 * SAFETY NOTE: applying a template creates editable DRAFT line items and
 * re-runs every allergy and safety check against the specific patient. A
 * template must never bypass a check simply because the combination was safe
 * for a previous patient — which is exactly the shortcut this table would
 * otherwise invite.
 */
export const prescriptionTemplate = pgTable(
  'prescription_template',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    name: text('name').notNull(),
    /** Indication this combination addresses; shown in the picker. */
    indication: text('indication'),

    /** Null = shared across the clinic; set = private to one practitioner. */
    practitionerId: uuid('practitioner_id'),

    /**
     * Line items, shape:
     * [{ catalogueItemId?, drugDisplayName, strength, dosageForm, route,
     *    frequency, timingRelativeToFood, durationDays, quantity, instructions }]
     *
     * JSONB rather than a child table: template lines are never queried
     * independently of their template, and are copied into real
     * medication_request rows on application.
     */
    lineItems: jsonb('line_items').notNull().default(sql`'[]'::jsonb`),

    usageCount: integer('usage_count').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.practitionerId], foreignColumns: [appUser.id] }).onDelete('cascade'),
    uniqueIndex('prescription_template_clinic_name_uq').on(
      t.clinicId,
      t.practitionerId,
      t.name,
    ),
    index('prescription_template_clinic_usage_idx')
      .on(t.clinicId, t.usageCount.desc())
      .where(sql`is_active = true`),
    tenantPolicy('prescription_template'),
  ],
).enableRLS();
