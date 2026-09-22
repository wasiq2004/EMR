/**
 * The platform plane.
 *
 * Everything else in this schema is tenant data, protected by forced row-level
 * security keyed on `app.clinic_id`. This file is the other side: the records
 * that belong to whoever RUNS the platform rather than to any clinic.
 *
 * THE CONSTRAINT THAT SHAPES ALL OF IT. A platform operator sees no patient
 * data. Not redacted, not access-logged, not behind a confirmation — absent.
 * That was a product decision and it is also the only version of this that is
 * defensible: a clinic hands over its patients' records on the understanding
 * that the software vendor is not a party to them.
 *
 * SO THE GUARANTEE IS A GRANT, NOT A POLICY. `emr_platform` is given privileges
 * on these tables and on `clinic`, and on NOTHING else. It cannot read
 * `patient`, `encounter`, `communication` or any other clinical table, because
 * it has no privilege on them — not because a predicate evaluates false. Same
 * shape as the messaging worker's inability to read internal notes.
 *
 * Which means every number a platform operator sees is an AGGREGATE, computed
 * by a job that runs inside a tenant context and writes a count. The panel
 * reads counts. It never reads rows.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
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
  auditColumns,
  platformRoleEnum,
  primaryKeyColumn,
  subscriptionStatusEnum,
  tenantPolicy,
} from './shared';
import { clinic } from './tenancy';

/* ------------------------------------------------------------------------- *
 * Platform user
 *
 * NOT an `app_user`. That table is clinic-scoped — every row has a clinic_id
 * and is invisible outside its tenant — so a platform operator modelled there
 * would have to belong to a clinic, which is the wrong shape and would put a
 * cross-tenant identity inside the tenant boundary.
 *
 * Separate table, separate sign-in, separate session cookie. The two identity
 * systems never mix, and a clinic user cannot be escalated into a platform one
 * by editing a column.
 * ------------------------------------------------------------------------- */

export const platformUser = pgTable(
  'platform_user',
  {
    id: primaryKeyColumn(),

    fullName: text('full_name').notNull(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),

    role: platformRoleEnum('role').notNull().default('SUPPORT'),

    /**
     * Mandatory, with no grace period.
     *
     * A clinic user gets a few days to enrol because a clinic cannot stop
     * working while its receptionist finds an authenticator app. An account
     * that can suspend every clinic on the platform does not get that
     * latitude.
     */
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    mfaSecretEncrypted: text('mfa_secret_encrypted'),

    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),

    ...auditColumns(),
  },
  (t) => [uniqueIndex('platform_user_email_uq').on(t.email)],
);

/* ------------------------------------------------------------------------- *
 * Subscription
 *
 * What a clinic is paying for, and what it is therefore allowed to do. One per
 * clinic. Suspension lives on `clinic` (is_active / suspended_at) because the
 * request path already re-reads that on every request; this table holds the
 * commercial state that decides whether it SHOULD be suspended.
 * ------------------------------------------------------------------------- */

export const subscription = pgTable(
  'subscription',
  {
    id: primaryKeyColumn(),
    clinicId: uuid('clinic_id').notNull(),

    plan: text('plan').notNull().default('pilot'),
    status: subscriptionStatusEnum('status').notNull().default('TRIAL'),

    /** Paise, so money is never a float. */
    monthlyPricePaise: integer('monthly_price_paise').notNull().default(0),

    /*
     * Limits, not quotas on clinical work.
     *
     * A clinic that hits its patient limit is not stopped from treating
     * someone — it is told to upgrade, and the platform operator sees it. A
     * system that refuses to register a patient because of a billing state is
     * a system that harms a patient over an invoice.
     */
    maxPractitioners: integer('max_practitioners'),
    maxPatients: integer('max_patients'),
    /** WhatsApp messages included per month; overage is billed. */
    includedMessagesPerMonth: integer('included_messages_per_month'),

    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationReason: text('cancellation_reason'),

    notes: text('notes'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    uniqueIndex('subscription_clinic_uq').on(t.clinicId),
    index('subscription_status_idx').on(t.status),
    // A clinic reads its OWN subscription — "you are on the pilot plan, 40 of
    // 50 patients" belongs in the clinic's settings, not only in the vendor's
    // console. The platform role reads across tenants through its own grant.
    tenantPolicy('subscription'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * Daily usage
 *
 * COUNTS, NEVER ROWS. This is the only thing a platform operator sees about
 * what happens inside a clinic, and it is deliberately incapable of carrying
 * anything identifying: integers and a date.
 *
 * Written by a job that runs INSIDE each tenant's context — so the aggregation
 * itself is subject to the same row-level security as everything else, and the
 * only thing that crosses the boundary is a number it computed.
 * ------------------------------------------------------------------------- */

export const clinicUsageDaily = pgTable(
  'clinic_usage_daily',
  {
    id: primaryKeyColumn(),
    clinicId: uuid('clinic_id').notNull(),
    day: date('day').notNull(),

    activeUsers: integer('active_users').notNull().default(0),
    patientsRegistered: integer('patients_registered').notNull().default(0),
    patientsTotal: integer('patients_total').notNull().default(0),
    appointments: integer('appointments').notNull().default(0),
    encounters: integer('encounters').notNull().default(0),
    prescriptions: integer('prescriptions').notNull().default(0),
    messagesSent: integer('messages_sent').notNull().default(0),
    messagesFailed: integer('messages_failed').notNull().default(0),
    documentsUploaded: integer('documents_uploaded').notNull().default(0),
    storageBytes: bigint('storage_bytes', { mode: 'number' }).notNull().default(0),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('cascade'),
    uniqueIndex('clinic_usage_daily_uq').on(t.clinicId, t.day),
    index('clinic_usage_day_idx').on(t.day),
    tenantPolicy('clinic_usage_daily'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * Platform audit
 *
 * Separate from `audit_event`, which is a clinic's record of what happened
 * inside its own walls and which that clinic can read. This is the record of
 * what the VENDOR did to a clinic — suspending it, changing its plan, resetting
 * an administrator's password.
 *
 * Kept apart for two reasons. A clinic reading its own audit trail should not
 * have to filter out the vendor's entries to find its staff's; and a vendor
 * action taken against a clinic is exactly the thing that clinic may later
 * dispute, so it belongs in a log the clinic cannot write to.
 * ------------------------------------------------------------------------- */

export const platformAuditEvent = pgTable(
  'platform_audit_event',
  {
    id: primaryKeyColumn(),

    actorPlatformUserId: uuid('actor_platform_user_id'),
    actorName: text('actor_name'),
    actorRole: text('actor_role'),

    action: text('action').notNull(),
    outcome: text('outcome').notNull().default('SUCCESS'),

    /** Which clinic it was done to. Null for platform-wide actions. */
    targetClinicId: uuid('target_clinic_id'),
    targetClinicName: text('target_clinic_name'),

    /**
     * Why. Required by the API for anything that changes a clinic's state —
     * a suspension with no stated reason is indistinguishable from a mistake.
     */
    reason: text('reason'),

    /** Before and after, for a change. Never clinical content. */
    changeSummary: jsonb('change_summary'),

    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),

    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('platform_audit_occurred_idx').on(t.occurredAt),
    index('platform_audit_clinic_idx').on(t.targetClinicId, t.occurredAt),
    index('platform_audit_actor_idx').on(t.actorPlatformUserId, t.occurredAt),
  ],
);
