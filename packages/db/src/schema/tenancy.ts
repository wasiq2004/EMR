/**
 * Tenancy root: Clinic, Location, User/Practitioner, and authentication sessions.
 *
 * FHIR mapping:
 *   clinic           → Organization (+ Location for the primary site)
 *   clinicLocation   → Location
 *   appUser          → Practitioner + PractitionerRole
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
  auditColumns,
  clinicIdColumn,
  primaryKeyColumn,
  tenantPolicy,
  userRoleEnum,
} from './shared';

/* ------------------------------------------------------------------------- *
 * 1. Clinic — the tenant root (FHIR Organization)
 * ------------------------------------------------------------------------- */

/**
 * The tenant boundary itself. Every other row in the database descends from a
 * clinic row via clinic_id.
 *
 * NOTE: this table is deliberately NOT protected by the standard tenant policy
 * using its own `clinic_id` column — it has none. It is protected by a policy on
 * `id` (see migration 0001), so a clinic can read only its own organisation
 * record. Clinic creation is performed by the platform provisioning path running
 * as `emr_migrator`, never by `emr_app`.
 */
export const clinic = pgTable(
  'clinic',
  {
    id: primaryKeyColumn(),

    /** Legal / display name printed on prescription letterhead. */
    name: text('name').notNull(),
    /** Subdomain used for CORS origin allowlisting: {slug}.app.example.in */
    slug: text('slug').notNull(),

    /** Clinical Establishments Act registration, where the state requires it. */
    registrationNumber: text('registration_number'),
    /** GSTIN — nullable; most single-doctor clinics are below the threshold. */
    gstin: text('gstin'),

    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    state: text('state'),
    pincode: text('pincode'),

    /** E.164. Front-desk contact number shown to patients. */
    contactPhoneE164: text('contact_phone_e164'),
    contactEmail: text('contact_email'),

    /** IANA zone, e.g. "Asia/Kolkata". Drives reminder scheduling and quiet hours. */
    timezone: text('timezone').notNull().default('Asia/Kolkata'),

    /** S3 key of the letterhead logo, composited into generated PDFs. */
    logoObjectKey: text('logo_object_key'),

    /**
     * ABDM Health Facility Registry id. Null until the clinic completes HFR
     * registration; required before any M2 (HIP) data linking.
     */
    abdmHfrId: text('abdm_hfr_id'),

    /**
     * Per-clinic settings: consultation duration, queue display preferences,
     * reminder lead times, prescription template variant. Kept as JSONB because
     * these evolve per release and carry no referential integrity.
     */
    settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),

    /**
     * Suspension flag (non-payment, or a security hold). Checked by the tenant
     * context middleware on EVERY request — a suspended clinic's valid JWT must
     * stop working immediately, not at token expiry.
     */
    isActive: boolean('is_active').notNull().default(true),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    suspensionReason: text('suspension_reason'),

    ...auditColumns(),
  },
  (t) => [
    uniqueIndex('clinic_slug_uq').on(t.slug),
    index('clinic_active_idx').on(t.isActive),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * 2. Clinic Location (FHIR Location)
 * ------------------------------------------------------------------------- */

/**
 * A consulting room or branch site. A 1-doctor clinic will have exactly one;
 * modelling it separately from the start avoids a painful migration when a
 * practice opens a second location, which is the most common growth event in
 * this segment.
 */
export const clinicLocation = pgTable(
  'clinic_location',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    name: text('name').notNull(),
    addressLine1: text('address_line1'),
    city: text('city'),
    state: text('state'),
    pincode: text('pincode'),

    /** Exactly one location per clinic should carry this; enforced by partial unique index. */
    isPrimary: boolean('is_primary').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    index('clinic_location_clinic_idx').on(t.clinicId),
    uniqueIndex('clinic_location_primary_uq')
      .on(t.clinicId)
      .where(sql`is_primary = true`),
    tenantPolicy('clinic_location'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * 3. User / Practitioner (FHIR Practitioner + PractitionerRole)
 * ------------------------------------------------------------------------- */

/**
 * A staff login. Scoped to exactly one clinic — a doctor practising at two
 * clinics has two user rows, deliberately. Cross-tenant user identity would
 * require a user→clinic join table and would make the RLS predicate
 * substantially harder to reason about; at 1–5 doctor scale the duplication is
 * cheap and the security simplification is valuable.
 */
export const appUser = pgTable(
  'app_user',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    fullName: text('full_name').notNull(),
    /** Login identifier. Unique per clinic, not globally. */
    email: text('email').notNull(),
    mobileE164: text('mobile_e164'),

    /**
     * Argon2id PHC-format hash (algorithm, parameters and salt are embedded in
     * the string). Never a bare hash, never a separate salt column, never
     * exposed by any API response contract.
     */
    passwordHash: text('password_hash').notNull(),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),

    /** Exactly one RBAC role. See docs/phase-0/04 §4 for the permission matrix. */
    role: userRoleEnum('role').notNull(),

    /* --- Practitioner attributes (null for non-clinical roles) --- */

    /**
     * NMC or State Medical Council registration number. REQUIRED to sign a
     * prescription — it is printed on the PDF and is a legal element of a valid
     * e-prescription. Enforced at the application layer for DOCTOR role.
     */
    medicalRegistrationNumber: text('medical_registration_number'),
    medicalCouncil: text('medical_council'),
    /** e.g. "MBBS, MD (General Medicine)" — printed under the signature block. */
    qualifications: text('qualifications'),
    specialty: text('specialty'),
    /** ABDM Healthcare Professional Registry id; prerequisite for M2 linking. */
    abdmHprId: text('abdm_hpr_id'),

    /** S3 key of the scanned signature image composited into prescription PDFs. */
    signatureImageObjectKey: text('signature_image_object_key'),

    /* --- Authentication state --- */

    /** Mandatory for OWNER_ADMIN and DOCTOR: they can finalise clinical records. */
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    /** TOTP seed, encrypted at the application layer with a KMS data key. */
    mfaSecretEncrypted: text('mfa_secret_encrypted'),

    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),

    isActive: boolean('is_active').notNull().default(true),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    index('app_user_clinic_idx').on(t.clinicId),
    uniqueIndex('app_user_clinic_email_uq').on(t.clinicId, t.email),
    /** Partial: only one active practitioner may hold a given registration number. */
    uniqueIndex('app_user_clinic_regno_uq')
      .on(t.clinicId, t.medicalRegistrationNumber)
      .where(sql`medical_registration_number IS NOT NULL AND is_active = true`),
    index('app_user_clinic_role_idx').on(t.clinicId, t.role).where(sql`is_active = true`),
    tenantPolicy('app_user'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * 4. Refresh session
 * ------------------------------------------------------------------------- */

/**
 * Server-side refresh token store. Server-side (rather than a self-contained
 * JWT refresh token) is what makes revocation INSTANT — required when a
 * receptionist is dismissed, and required to honour a DPDP access-termination
 * request without waiting for token expiry.
 *
 * Only the SHA-256 of the token is stored: a database disclosure must not yield
 * usable session credentials.
 */
export const refreshSession = pgTable(
  'refresh_session',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    userId: uuid('user_id').notNull(),

    tokenHash: text('token_hash').notNull(),

    /** Rotation chain — detects token replay after a refresh. */
    previousSessionId: uuid('previous_session_id'),

    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),

    /** Captured for the audit trail and for anomalous-login detection. */
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.userId], foreignColumns: [appUser.id] }).onDelete('cascade'),
    uniqueIndex('refresh_session_token_hash_uq').on(t.tokenHash),
    index('refresh_session_user_idx').on(t.clinicId, t.userId),
    index('refresh_session_expiry_idx').on(t.expiresAt).where(sql`revoked_at IS NULL`),
    tenantPolicy('refresh_session'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * 5. Service / fee catalogue (FHIR HealthcareService)
 * ------------------------------------------------------------------------- */

/**
 * Billable services and their default fees.
 *
 * Required by SoW §6.1 ("basic services/fees") and §6.10 ("configurable
 * service/consultation items"). Kept as a table rather than clinic settings
 * JSONB because invoice line items reference these, fees change over time, and
 * a historical invoice must remain interpretable after a price change.
 *
 * Amounts are in PAISE as integers — never floats. Currency arithmetic in
 * binary floating point produces reconciliation errors that are tedious to find
 * and embarrassing to explain to a clinic.
 */
export const serviceItem = pgTable(
  'service_item',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    /** e.g. "New consultation", "Follow-up (within 7 days)", "Dressing". */
    name: text('name').notNull(),
    /** Short code used at the front desk for fast entry. */
    code: text('code'),
    description: text('description'),

    defaultFeePaise: bigint('default_fee_paise', { mode: 'number' }).notNull().default(0),

    /** HSN/SAC code, only where the clinic is GST-registered. */
    hsnSacCode: text('hsn_sac_code'),
    /** Basis points (e.g. 1800 = 18%). Integer, so no float rounding. */
    taxRateBps: integer('tax_rate_bps').notNull().default(0),

    /**
     * Optional default duration in minutes, used by appointment scheduling so a
     * "New consultation" books a longer slot than a follow-up.
     */
    defaultDurationMinutes: integer('default_duration_minutes'),

    /** Restrict a service to one practitioner where fees differ by doctor. */
    practitionerId: uuid('practitioner_id'),

    isActive: boolean('is_active').notNull().default(true),
    displayOrder: integer('display_order').notNull().default(0),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.practitionerId], foreignColumns: [appUser.id] }).onDelete('set null'),
    uniqueIndex('service_item_clinic_name_uq').on(t.clinicId, t.name),
    index('service_item_clinic_active_idx')
      .on(t.clinicId, t.displayOrder)
      .where(sql`is_active = true`),
    tenantPolicy('service_item'),
  ],
).enableRLS();
