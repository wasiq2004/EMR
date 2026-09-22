/**
 * Shared schema primitives: enumerations, reusable column bags, and the tenant
 * isolation policy helper.
 *
 * SECURITY: `tenantPolicy()` is the single definition of the tenant boundary for
 * the entire system. Every table that carries clinical or operational data MUST
 * apply it and MUST be created with FORCE ROW LEVEL SECURITY (see
 * migrations/0001_roles_and_rls.sql). A table that omits either is a cross-tenant
 * leak waiting to happen; CI enforces this invariant (see docs/phase-0/04 §7).
 */

import { sql } from 'drizzle-orm';
import {
  integer,
  pgEnum,
  pgPolicy,
  pgRole,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/* ------------------------------------------------------------------------- *
 * Database roles
 * ------------------------------------------------------------------------- */

/**
 * The role the API connects as. Created in migration 0001 with NOBYPASSRLS and
 * no DDL privileges, so application code is structurally incapable of disabling
 * a tenant policy. Migrations run as a separate `emr_migrator` owner role.
 */
export const emrApp = pgRole('emr_app').existing();

/**
 * The WhatsApp/SMS dispatch worker. It holds no privilege at all on
 * `encounter_internal_note`, which is what makes an internal note structurally
 * undispatchable. It still needs a tenant policy on the tables it CAN reach —
 * an RLS policy is scoped to the roles it names, so a role with no applicable
 * policy sees zero rows no matter what it has been granted.
 */
export const emrWorkerMessaging = pgRole('emr_worker_messaging').existing();

/** Analytics and the read replica. SELECT only, and still tenant-bound. */
export const emrReadonly = pgRole('emr_readonly').existing();

/**
 * Every role that reaches a tenant table through the application.
 *
 * Policies name all of them and grants decide what each may do. Naming only
 * `emr_app` left the worker and the reporting role able to see nothing at all:
 * their grants were real, but with no policy applying to them, forced RLS
 * returned zero rows.
 */
export const tenantRoles = [emrApp, emrWorkerMessaging, emrReadonly];

/**
 * Reserved tenant that owns globally shared reference data (drug catalogue, ICD
 * code sets). Real clinics can READ rows owned by this tenant but can never
 * write to it — see `sharedReferencePolicy()`.
 */
export const SYSTEM_CLINIC_ID = '00000000-0000-0000-0000-000000000000';

/* ------------------------------------------------------------------------- *
 * Enumerations — FHIR R4 aligned
 *
 * Values mirror the corresponding FHIR R4 valueset so the ABDM mapping layer is
 * a rename, not a translation. Where we deviate (e.g. communication delivery
 * states, which FHIR models coarsely), the FHIR equivalent is noted inline.
 * ------------------------------------------------------------------------- */

/** RBAC roles per the SoW. One role per user per clinic. */
export const userRoleEnum = pgEnum('user_role', [
  'OWNER_ADMIN',
  'DOCTOR',
  'RECEPTIONIST',
  'NURSE_ASSISTANT',
  'AUDITOR',
]);

/** FHIR administrative-gender. `UNKNOWN` is required — it is common in walk-ins. */
export const genderEnum = pgEnum('gender', ['MALE', 'FEMALE', 'OTHER', 'UNKNOWN']);

/**
 * Appointment status.
 *
 * Values are the SoW §6.3 set, named to align with FHIR Appointment.status:
 *   SoW "Scheduled"       → SCHEDULED
 *   SoW "Confirmed"       → CONFIRMED      (patient acknowledged the reminder)
 *   SoW "Checked-in"      → ARRIVED        (FHIR: arrived)
 *   SoW "In Consultation" → IN_PROGRESS    (FHIR: checked-in)
 *   SoW "Completed"       → FULFILLED      (FHIR: fulfilled)
 *   SoW "Cancelled"       → CANCELLED
 *   SoW "No-show"         → NOSHOW
 */
export const appointmentStatusEnum = pgEnum('appointment_status', [
  'SCHEDULED',
  'CONFIRMED', // patient confirmed, typically via the WhatsApp reminder
  'ARRIVED', // physically checked in — this is what puts them in the live queue
  'IN_PROGRESS', // in consultation
  'FULFILLED',
  'CANCELLED',
  'NOSHOW',
]);

/** FHIR Encounter.status. */
export const encounterStatusEnum = pgEnum('encounter_status', [
  'PLANNED',
  'IN_PROGRESS',
  'FINISHED',
  'CANCELLED',
  'ENTERED_IN_ERROR',
]);

/**
 * Whether the patient was in the room.
 *
 * Not cosmetic. India's Telemedicine Practice Guidelines put Schedule X drugs
 * and narcotics on a prohibited list for teleconsultation — no exceptions and no
 * clinical override — and a teleconsultation prescription must carry a
 * declaration that an in-person one does not. Neither rule can be applied
 * without knowing which kind of consultation this was, so the system recorded
 * neither until this column existed.
 *
 * Defaults to IN_PERSON: that is the overwhelmingly common case in this segment,
 * and it is the SAFE default, because it is the mode with fewer restrictions to
 * get wrong in the other direction.
 */
export const consultationModeEnum = pgEnum('consultation_mode', [
  'IN_PERSON',
  'TELECONSULTATION',
]);

/** Where a message template stands with the provider. */
export const templateStatusEnum = pgEnum('message_template_status', [
  'DRAFT',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PAUSED',
  'DISABLED',
]);

/**
 * What a broadcast is FOR, which decides which consent it needs.
 *
 * This is the distinction the whole broadcast feature turns on. A reminder that
 * a prescription is ready rides on the consent a patient gave to be contacted
 * about their care. "Free eye camp on Sunday" does not — it is marketing, it
 * needs marketing consent, and sending it under a clinical consent is the thing
 * that gets a clinic's number blocked and its patients angry.
 */
export const broadcastPurposeEnum = pgEnum('broadcast_purpose', [
  /** Care-related: recalls, camps for existing conditions, clinic closures. */
  'CLINICAL',
  /** Promotional. Requires MARKETING_COMMUNICATION consent, separately. */
  'MARKETING',
]);

export const broadcastStatusEnum = pgEnum('broadcast_status', [
  'DRAFT',
  'SCHEDULED',
  'SENDING',
  'PAUSED',
  'SENT',
  'CANCELLED',
  'FAILED',
]);

/** Why a patient was left out of a broadcast. Shown before it is sent. */
export const broadcastExclusionEnum = pgEnum('broadcast_exclusion_reason', [
  'NO_MOBILE',
  'NO_CONSENT',
  'OPTED_OUT',
  'DUPLICATE_NUMBER',
  'DECEASED_OR_MERGED',
]);

/**
 * What a platform operator may do.
 *
 * Three levels, because "can see that a clinic exists" and "can suspend it" are
 * not the same authority and should not be held by the same people by default.
 */
export const platformRoleEnum = pgEnum('platform_role', [
  /** Read-only: tenant list, health, usage. Changes nothing. */
  'SUPPORT',
  /** Suspend, restore, change a plan. The day-to-day operator. */
  'OPERATOR',
  /** The above, plus managing other platform users. */
  'PLATFORM_ADMIN',
]);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'SUSPENDED',
  'CANCELLED',
]);

/** FHIR Condition.clinicalStatus. */
export const conditionClinicalStatusEnum = pgEnum('condition_clinical_status', [
  'ACTIVE',
  'RECURRENCE',
  'RELAPSE',
  'INACTIVE',
  'REMISSION',
  'RESOLVED',
]);

/** FHIR Condition.verificationStatus. */
export const conditionVerificationStatusEnum = pgEnum('condition_verification_status', [
  'UNCONFIRMED',
  'PROVISIONAL',
  'DIFFERENTIAL',
  'CONFIRMED',
  'REFUTED',
  'ENTERED_IN_ERROR',
]);

/** FHIR AllergyIntolerance.category. */
export const allergyCategoryEnum = pgEnum('allergy_category', [
  'MEDICATION',
  'FOOD',
  'ENVIRONMENT',
  'BIOLOGIC',
]);

/**
 * FHIR AllergyIntolerance.criticality — the clinical risk of a FUTURE reaction.
 * Distinct from reaction severity, which describes a reaction that already
 * happened. Conflating the two is a known source of prescribing error, so both
 * are modelled.
 */
export const allergyCriticalityEnum = pgEnum('allergy_criticality', [
  'LOW',
  'HIGH',
  'UNABLE_TO_ASSESS',
]);

/** FHIR AllergyIntolerance.reaction.severity. */
export const reactionSeverityEnum = pgEnum('reaction_severity', [
  'MILD',
  'MODERATE',
  'SEVERE',
]);

/** FHIR Observation.status. */
export const observationStatusEnum = pgEnum('observation_status', [
  'REGISTERED',
  'PRELIMINARY',
  'FINAL',
  'AMENDED',
  'CORRECTED',
  'CANCELLED',
  'ENTERED_IN_ERROR',
]);

/** FHIR MedicationRequest.status. */
export const medicationRequestStatusEnum = pgEnum('medication_request_status', [
  'DRAFT',
  'ACTIVE',
  'ON_HOLD',
  'STOPPED',
  'COMPLETED',
  'CANCELLED',
  'ENTERED_IN_ERROR',
]);

/** FHIR DocumentReference.status. */
export const documentStatusEnum = pgEnum('document_status', [
  'CURRENT',
  'SUPERSEDED',
  'ENTERED_IN_ERROR',
]);

/**
 * Document classification. Drives retention policy and whether a document may be
 * externally shared by default.
 */
export const documentTypeEnum = pgEnum('document_type', [
  'PRESCRIPTION', // system-generated, signed
  'LAB_REPORT',
  'IMAGING_REPORT',
  'DISCHARGE_SUMMARY',
  'REFERRAL_LETTER',
  'CONSENT_FORM',
  'INVOICE',
  'PATIENT_UPLOAD', // supplied by the patient — must be virus scanned
  'OTHER',
]);

/** Communication channel. WhatsApp is the primary channel; SMS is the fallback. */
export const communicationChannelEnum = pgEnum('communication_channel', [
  'WHATSAPP',
  'SMS',
  'EMAIL',
]);

export const communicationDirectionEnum = pgEnum('communication_direction', [
  'INBOUND',
  'OUTBOUND',
]);

/**
 * Delivery lifecycle. FHIR Communication.status is coarser (preparation /
 * in-progress / completed / not-done); the mapping layer collapses these.
 * We keep the finer states because reconciling undelivered prescriptions is an
 * explicit requirement (risk R2).
 */
export const communicationStatusEnum = pgEnum('communication_status', [
  'QUEUED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'RECEIVED', // inbound only
]);

/** Whether an outbound WhatsApp message went as a template or a session message. */
export const whatsappMessageKindEnum = pgEnum('whatsapp_message_kind', [
  'TEMPLATE', // business-initiated; permitted at any time
  'SESSION', // free-form; only inside an open 24-hour service window
]);

/**
 * Inbox triage state for a conversation, per SoW §6.8
 * ("status such as Open, Waiting, Closed").
 */
export const conversationStatusEnum = pgEnum('conversation_status', [
  'OPEN', // needs a clinic response
  'WAITING', // replied; awaiting the patient
  'CLOSED', // resolved
]);

/** FHIR Task.status. */
export const taskStatusEnum = pgEnum('task_status', [
  'REQUESTED',
  'ACCEPTED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
]);

/** FHIR Task.priority. */
export const taskPriorityEnum = pgEnum('task_priority', [
  'ROUTINE',
  'URGENT',
  'ASAP',
  'STAT',
]);

/** FHIR Consent.status. */
export const consentStatusEnum = pgEnum('consent_status', [
  'DRAFT',
  'ACTIVE',
  'INACTIVE',
  'REJECTED',
]);

/**
 * Consent purpose.
 *
 * SoW §10 requires separate operational / clinical / data-sharing / WhatsApp /
 * marketing categories, and DPDP Rules 2025 require purpose-specific,
 * independently withdrawable consent. Hence a discrete row per purpose, never a
 * bundled "I agree to everything" flag.
 */
export const consentScopeEnum = pgEnum('consent_scope', [
  'TREATMENT', // clinical care
  'DATA_PROCESSING', // DPDP lawful basis for holding the record (operational)
  'WHATSAPP_COMMUNICATION', // SoW §10 — distinct from marketing; covers transactional messaging
  'MARKETING_COMMUNICATION', // must be separately obtainable and withdrawable
  'DATA_SHARING_THIRD_PARTY',
  'ABDM_LINKAGE',
]);

/** FHIR Invoice.status. */
export const invoiceStatusEnum = pgEnum('invoice_status', [
  'DRAFT',
  'ISSUED',
  'BALANCED', // fully paid
  'CANCELLED',
]);

export const paymentMethodEnum = pgEnum('payment_method', [
  'CASH',
  'UPI',
  'CARD',
  'NETBANKING',
  'CHEQUE',
  'OTHER',
]);

/**
 * FHIR AuditEvent.outcome, using the FHIR numeric semantics by name.
 * SERIOUS_FAILURE and above should alert.
 */
export const auditOutcomeEnum = pgEnum('audit_outcome', [
  'SUCCESS', // 0
  'MINOR_FAILURE', // 4  — e.g. validation rejected
  'SERIOUS_FAILURE', // 8  — e.g. authorisation denied
  'MAJOR_FAILURE', // 12 — e.g. tenant assertion violated
]);

/* ------------------------------------------------------------------------- *
 * Reusable column bags
 * ------------------------------------------------------------------------- */

/**
 * Primary key.
 *
 * NOTE (deviation flagged for client ratification): the SoW mandates UUIDv4.
 * We comply here via gen_random_uuid(). We recommend UUIDv7 — PostgreSQL 18
 * ships uuidv7() natively — because random v4 keys cause B-tree page splits and
 * index write amplification on append-heavy clinical tables (observation,
 * audit_event). Switching is a one-line default change with no type change.
 * See docs/phase-0/03-database-schema.md §7.
 */
export const primaryKeyColumn = () =>
  uuid('id').primaryKey().default(sql`gen_random_uuid()`);

/**
 * The tenant discriminator. Present on EVERY table per the SoW mandate.
 * The foreign key to clinic(id) is declared per-table to avoid a circular import.
 */
export const clinicIdColumn = () => uuid('clinic_id').notNull();

/**
 * Audit columns required on every table by the SoW.
 *
 * `createdBy` / `updatedBy` are intentionally NOT foreign-keyed to app_user:
 * staff records may be deleted or anonymised under a DPDP erasure request, and
 * the provenance of a clinical record must survive that. The actor's identity at
 * the time of the action is preserved immutably in audit_event instead.
 */
export const auditColumns = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
  /** Optimistic concurrency. Incremented by trigger; a stale write is rejected. */
  version: integer('version').notNull().default(1),
});

/* ------------------------------------------------------------------------- *
 * Tenant isolation policies
 * ------------------------------------------------------------------------- */

/**
 * The standard tenant boundary.
 *
 * `nullif(current_setting('app.clinic_id', true), '')` fails CLOSED: if the
 * tenant context middleware has not run, or set an empty value, the expression
 * is NULL, the comparison is NULL, and the row is invisible. There is no code
 * path that produces "all tenants" — the absence of context yields zero rows,
 * never everything.
 *
 * Applies to SELECT, INSERT, UPDATE and DELETE (`for: 'all'`). WITH CHECK
 * additionally prevents writing a row INTO another tenant, which USING alone
 * would not catch.
 */
export const tenantPolicy = (tableName: string) =>
  pgPolicy(`${tableName}_tenant_isolation`, {
    as: 'permissive',
    for: 'all',
    to: tenantRoles,
    using: sql`clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid`,
    withCheck: sql`clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid`,
  });

/**
 * Policy set for globally shared reference data (the drug catalogue).
 *
 * READ widens to the system tenant; WRITE does not. This is deliberately FOUR
 * policies rather than one `FOR ALL`, and the reason is a real hole that one
 * policy left open:
 *
 *   - `USING` decides which rows a DELETE may remove, and `WITH CHECK` never
 *     applies to DELETE at all. A single `FOR ALL` policy whose `USING`
 *     included the system tenant therefore let ANY clinic delete the shared
 *     catalogue every other clinic prescribes from.
 *   - `USING` also decides which rows an UPDATE may touch, so the same policy
 *     let a clinic re-parent a shared row onto itself, removing it for
 *     everyone.
 *
 * Splitting them means the widened `USING` applies to reads only. Writes are
 * confined to the clinic's own rows, so a clinic can add a compounded
 * preparation and can never touch the shared list.
 */
export const sharedReferencePolicy = (tableName: string) => [
  pgPolicy(`${tableName}_shared_read`, {
    as: 'permissive',
    for: 'select',
    to: tenantRoles,
    using: sql`clinic_id IN (
      nullif(current_setting('app.clinic_id', true), '')::uuid,
      '${sql.raw(SYSTEM_CLINIC_ID)}'::uuid
    )`,
  }),
  pgPolicy(`${tableName}_own_insert`, {
    as: 'permissive',
    for: 'insert',
    to: tenantRoles,
    withCheck: sql`clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid`,
  }),
  pgPolicy(`${tableName}_own_update`, {
    as: 'permissive',
    for: 'update',
    to: tenantRoles,
    using: sql`clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid`,
    withCheck: sql`clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid`,
  }),
  pgPolicy(`${tableName}_own_delete`, {
    as: 'permissive',
    for: 'delete',
    to: tenantRoles,
    using: sql`clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid`,
  }),
];

/**
 * Policy for the audit log: readable and insertable within the tenant, never
 * updatable or deletable. Immutability is additionally enforced by REVOKE at the
 * grant level and by a BEFORE UPDATE OR DELETE trigger — three independent
 * controls, because a mutable audit log is worthless in a regulatory
 * investigation.
 */
export const appendOnlyTenantPolicies = (tableName: string) => [
  pgPolicy(`${tableName}_tenant_read`, {
    as: 'permissive',
    for: 'select',
    to: tenantRoles,
    using: sql`clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid`,
  }),
  pgPolicy(`${tableName}_tenant_append`, {
    as: 'permissive',
    for: 'insert',
    to: tenantRoles,
    withCheck: sql`clinic_id = nullif(current_setting('app.clinic_id', true), '')::uuid`,
  }),
];
