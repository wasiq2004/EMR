/**
 * Communication: WhatsApp account binding, service-window tracking, the
 * dispatchable message log, inbound webhook receipts, and external share links.
 *
 * FHIR mapping:
 *   communication → Communication
 *
 * ARCHITECTURAL NOTE: this module contains ONLY externally dispatchable
 * content. Internal clinical notes live in `encounter_internal_note`
 * (clinical.ts) and are unreachable from here by database grant, not by
 * convention. See the security boundary comment on that table.
 */

import { sql } from 'drizzle-orm';
import {
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
  communicationChannelEnum,
  communicationDirectionEnum,
  communicationStatusEnum,
  conversationStatusEnum,
  primaryKeyColumn,
  reminderChannelEnum,
  reminderKindEnum,
  reminderStatusEnum,
  tenantPolicy,
  whatsappMessageKindEnum,
} from './shared';
import { appUser, clinic } from './tenancy';
import { patient } from './patient';
import { documentReference, encounter } from './clinical';

/* ------------------------------------------------------------------------- *
 * WhatsApp account binding
 * ------------------------------------------------------------------------- */

/**
 * The clinic's own WhatsApp Business Account, attached during onboarding via
 * Meta Embedded Signup. Each clinic has its own WABA and phone number so that
 * messages come from "Dr. Sharma's Clinic", not from the platform.
 *
 * This table is also the tenant resolver for inbound webhooks: Meta identifies
 * the destination only by `phoneNumberId`, so this is the sole place in the
 * system where tenant context originates from an external party. It is always
 * resolved by lookup here and never trusted from the webhook payload.
 */
export const whatsappAccount = pgTable(
  'whatsapp_account',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    /** Meta WABA id. */
    wabaId: text('waba_id').notNull(),
    /** Meta phone number id — the webhook routing key. */
    phoneNumberId: text('phone_number_id').notNull(),
    displayPhoneE164: text('display_phone_e164').notNull(),
    verifiedName: text('verified_name'),

    /**
     * Long-lived system user access token, encrypted with a KMS data key.
     * Never logged, never returned by any API contract.
     */
    accessTokenEncrypted: text('access_token_encrypted').notNull(),

    /**
     * Meta's quality rating (GREEN / YELLOW / RED) and messaging tier. A RED
     * rating precedes number suspension (risk R9), so it is polled nightly and
     * surfaced to the clinic before it becomes an outage.
     */
    qualityRating: text('quality_rating'),
    messagingTier: text('messaging_tier'),

    /**
     * Whether Cloud API Local Storage (India data residency) is enabled for this
     * number. Should be true for every Indian clinic; a false value is a
     * compliance finding surfaced on the admin dashboard.
     */
    localStorageRegion: text('local_storage_region'),

    isActive: boolean('is_active').notNull().default(true),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    /** Globally unique: two clinics can never share a WhatsApp number. */
    uniqueIndex('whatsapp_account_phone_number_id_uq').on(t.phoneNumberId),
    uniqueIndex('whatsapp_account_clinic_uq').on(t.clinicId).where(sql`is_active = true`),
    tenantPolicy('whatsapp_account'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * WhatsApp conversation — the 24-hour service window
 * ------------------------------------------------------------------------- */

/**
 * Tracks the customer service window per patient.
 *
 * WhatsApp permits free-form ("session") messages only within 24 hours of the
 * patient's most recent inbound message. Outside that window, only approved
 * templates may be sent. Getting this wrong is failure mode 1 of risk R2, and it
 * fails SILENTLY — Meta simply rejects the send.
 *
 * `windowExpiresAt` is therefore computed and persisted on every inbound
 * message, and the messaging service consults it before choosing between a
 * session message and a template. It is never inferred at send time from a
 * scan of message history, which would be both slow and racy.
 *
 * COMMERCIAL NOTE: from 1 October 2026 Meta bills per message for service and
 * utility messages sent inside an open window, which were previously free.
 * `billableMessageCount` exists so per-clinic metering is in place before that
 * change lands rather than after.
 */
export const whatsappConversation = pgTable(
  'whatsapp_conversation',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    patientId: uuid('patient_id'),

    /** E.164 of the patient handset. Present even when patientId is unresolved. */
    counterpartyE164: text('counterparty_e164').notNull(),

    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
    lastOutboundAt: timestamp('last_outbound_at', { withTimezone: true }),

    /**
     * lastInboundAt + 24 hours. Session messages are permitted only while
     * now() < windowExpiresAt.
     */
    windowExpiresAt: timestamp('window_expires_at', { withTimezone: true }),

    /**
     * Front-desk triage state for the Inbox UI.
     * SoW §6.8 requires conversation status (Open / Waiting / Closed) and
     * assignment to a doctor or staff member.
     */
    status: conversationStatusEnum('status').notNull().default('OPEN'),
    isUnread: boolean('is_unread').notNull().default(false),
    assignedToUserId: uuid('assigned_to_user_id'),

    /**
     * True when inbound messages could not be matched to exactly one patient.
     * SoW §6.8 requires an unlinked conversation queue — and in India this is
     * an expected path, not an error: one mobile number routinely serves a
     * whole family, so a multi-match is as common as a no-match.
     */
    isUnlinked: boolean('is_unlinked').notNull().default(false),

    /** Per-conversation metering for billing and margin analysis. */
    billableMessageCount: integer('billable_message_count').notNull().default(0),

    /** Patient has opted out of non-essential messaging. Honoured immediately. */
    isOptedOut: boolean('is_opted_out').notNull().default(false),
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.patientId], foreignColumns: [patient.id] }).onDelete('set null'),
    foreignKey({ columns: [t.assignedToUserId], foreignColumns: [appUser.id] }).onDelete('set null'),

    uniqueIndex('whatsapp_conversation_clinic_counterparty_uq').on(
      t.clinicId,
      t.counterpartyE164,
    ),
    /** Inbox ordering. */
    index('whatsapp_conversation_clinic_activity_idx').on(
      t.clinicId,
      t.lastInboundAt.desc(),
    ),
    index('whatsapp_conversation_unread_idx')
      .on(t.clinicId)
      .where(sql`is_unread = true`),
    /** The unlinked queue — staff link these to a patient in one click. */
    index('whatsapp_conversation_unlinked_idx')
      .on(t.clinicId, t.lastInboundAt.desc())
      .where(sql`is_unlinked = true`),
    index('whatsapp_conversation_status_idx')
      .on(t.clinicId, t.status)
      .where(sql`status <> 'CLOSED'`),
    tenantPolicy('whatsapp_conversation'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * 14. Communication (FHIR Communication)
 * ------------------------------------------------------------------------- */

/**
 * Every message sent to or received from a patient, across all channels.
 *
 * ============================ SECURITY BOUNDARY ============================
 * This is the ONLY table the messaging worker may read message content from.
 * Every row here is, by definition, externally dispatchable. There is
 * deliberately no `isInternal` column — the internal/external distinction is
 * expressed as two different tables, so that no predicate bug can promote an
 * internal note into an outbound message.
 * ===========================================================================
 */
export const communication = pgTable(
  'communication',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    patientId: uuid('patient_id'),
    conversationId: uuid('conversation_id'),
    /** Nullable: reminders and marketing are not tied to an encounter. */
    encounterId: uuid('encounter_id'),

    channel: communicationChannelEnum('channel').notNull(),
    direction: communicationDirectionEnum('direction').notNull(),
    status: communicationStatusEnum('status').notNull().default('QUEUED'),

    /** TEMPLATE vs SESSION. Null for non-WhatsApp channels. */
    messageKind: whatsappMessageKindEnum('message_kind'),
    /** Meta-approved template name, when messageKind = TEMPLATE. */
    templateName: text('template_name'),
    templateLanguage: text('template_language'),
    templateVariables: jsonb('template_variables'),

    /** Rendered message text. For templates, the resolved body as sent. */
    body: text('body'),

    /** Attached document (prescription PDF, lab report). */
    documentId: uuid('document_id'),

    /** Provider-side identifier, used to reconcile delivery receipts. */
    providerMessageId: text('provider_message_id'),
    providerErrorCode: text('provider_error_code'),
    providerErrorMessage: text('provider_error_message'),

    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),

    /** Set when a staff member composed it; null for system-generated messages. */
    sentByUserId: uuid('sent_by_user_id'),

    /**
     * Idempotency key. Prevents the same prescription being dispatched twice by
     * a retried job — duplicate prescription delivery confuses patients and
     * costs money on every send.
     */
    idempotencyKey: text('idempotency_key'),

    /** Cost in paise, for per-clinic metering (risk R2, commercial). */
    costPaise: integer('cost_paise'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.patientId], foreignColumns: [patient.id] }).onDelete('set null'),
    foreignKey({ columns: [t.conversationId], foreignColumns: [whatsappConversation.id] }).onDelete('set null'),
    foreignKey({ columns: [t.encounterId], foreignColumns: [encounter.id] }).onDelete('set null'),
    foreignKey({ columns: [t.documentId], foreignColumns: [documentReference.id] }).onDelete('set null'),
    foreignKey({ columns: [t.sentByUserId], foreignColumns: [appUser.id] }).onDelete('set null'),

    uniqueIndex('communication_provider_message_id_uq')
      .on(t.providerMessageId)
      .where(sql`provider_message_id IS NOT NULL`),
    uniqueIndex('communication_idempotency_uq')
      .on(t.clinicId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),

    index('communication_clinic_patient_idx').on(t.clinicId, t.patientId, t.queuedAt.desc()),
    index('communication_clinic_conversation_idx').on(
      t.clinicId,
      t.conversationId,
      t.queuedAt.desc(),
    ),
    /**
     * Reconciliation sweep: prescriptions sent but not confirmed delivered
     * within 15 minutes raise a front-desk Task (risk R2 detective control).
     */
    index('communication_undelivered_idx')
      .on(t.clinicId, t.sentAt)
      .where(sql`status IN ('QUEUED','SENT') AND direction = 'OUTBOUND'`),
    tenantPolicy('communication'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * Webhook event receipts
 * ------------------------------------------------------------------------- */

/**
 * Raw inbound webhook payloads, persisted before processing.
 *
 * Meta delivers at-least-once and retries aggressively, so the unique
 * constraint on `providerEventId` is what makes inbound processing idempotent.
 * Raw payloads are retained for 90 days for integration debugging, then purged
 * by the maintenance queue — they contain patient message content and must not
 * be kept indefinitely under DPDP storage limitation.
 */
export const webhookEvent = pgTable(
  'webhook_event',
  {
    id: primaryKeyColumn(),
    /** Resolved by phoneNumberId lookup, never read from the payload. */
    clinicId: clinicIdColumn(),

    provider: text('provider').notNull().default('META_WHATSAPP'),
    providerEventId: text('provider_event_id').notNull(),
    eventType: text('event_type').notNull(),

    payload: jsonb('payload').notNull(),
    signatureVerified: boolean('signature_verified').notNull(),

    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    processingError: text('processing_error'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    uniqueIndex('webhook_event_provider_event_uq').on(t.provider, t.providerEventId),
    index('webhook_event_unprocessed_idx')
      .on(t.receivedAt)
      .where(sql`processed_at IS NULL`),
    index('webhook_event_clinic_idx').on(t.clinicId, t.receivedAt.desc()),
    tenantPolicy('webhook_event'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * Share link — authenticated external document access
 * ------------------------------------------------------------------------- */

/**
 * Time-limited external access to a document.
 *
 * Deliberately NOT a raw S3 presigned URL. A presigned URL cannot be revoked
 * once issued, produces no access audit trail, and exposes the bucket
 * structure. For sharing a clinical document with a patient or a referred
 * consultant, all three of those are unacceptable.
 *
 * Instead: an opaque token resolved server-side, with expiry, an optional OTP
 * challenge to the patient's registered mobile, an access cap, and revocation.
 * Every access appends an audit_event. Full design in docs/phase-0/04 §6.
 */
export const shareLink = pgTable(
  'share_link',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    documentId: uuid('document_id').notNull(),
    patientId: uuid('patient_id').notNull(),

    /** SHA-256 of a 256-bit random token. The token itself is never stored. */
    tokenHash: text('token_hash').notNull(),

    /**
     * When set, the recipient must satisfy an OTP sent to this number before
     * the document is released. Required by default for any document type other
     * than a prescription the patient themselves requested.
     */
    otpChallengeE164: text('otp_challenge_e164'),
    otpVerifiedAt: timestamp('otp_verified_at', { withTimezone: true }),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    maxAccessCount: integer('max_access_count').notNull().default(10),
    accessCount: integer('access_count').notNull().default(0),

    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by'),

    createdByUserId: uuid('created_by_user_id').notNull(),
    /** Why the link was created — appears in the audit trail. */
    purpose: text('purpose'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.documentId], foreignColumns: [documentReference.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.patientId], foreignColumns: [patient.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.createdByUserId], foreignColumns: [appUser.id] }).onDelete('restrict'),

    uniqueIndex('share_link_token_hash_uq').on(t.tokenHash),
    index('share_link_clinic_document_idx').on(t.clinicId, t.documentId),
    index('share_link_expiry_idx').on(t.expiresAt).where(sql`revoked_at IS NULL`),
    tenantPolicy('share_link'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * ScheduledReminder — work with a due date, claimed before it is done
 * ------------------------------------------------------------------------- */

/**
 * One reminder, waiting for its time.
 *
 * WHY A TABLE AND NOT A QUEUE. There is no Redis-backed job runner in this
 * product and adding one for this would be the wrong trade: a clinic reminder is
 * due in three days, not three seconds, and the thing that must never happen is
 * sending it twice. A row with a status is inspectable — a receptionist asking
 * "did the reminder go out?" gets an answer from the same screen that shows the
 * message — and it survives a restart without any broker to keep running. The
 * scheduler is a cron line calling `POST /jobs/run-due`.
 *
 * THE CLAIM IS THE WHOLE DESIGN. `run-due` takes rows with
 * `UPDATE ... WHERE status = 'PENDING'` and `FOR UPDATE SKIP LOCKED` before it
 * sends anything, so two overlapping cron runs — which is what happens the first
 * time a send is slow — cannot both pick up the same row. The send itself then
 * carries an idempotency key derived from this row's id, so even a claim that
 * somehow raced cannot produce two messages.
 *
 * WHAT IT IS NOT. It is not a general job table. Everything here is "tell
 * somebody something at a time", and the three columns that would make it
 * general — a payload blob, a handler name, a retry policy — are deliberately
 * absent. A follow-up reminder and an appointment reminder differ by `kind` and
 * by nothing else.
 */
export const scheduledReminder = pgTable(
  'scheduled_reminder',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    patientId: uuid('patient_id').notNull(),

    /**
     * What this reminder is for.
     *
     * `FOLLOW_UP` comes from a signed consultation's `follow_up_after_days`.
     * `APPOINTMENT` is a future kind for the day-before nudge; it is in the enum
     * now so adding it later is not a migration of this column.
     */
    kind: reminderKindEnum('kind').notNull(),

    /** The consultation that asked for it, where there was one. */
    encounterId: uuid('encounter_id'),
    /** The appointment being reminded about, for `APPOINTMENT`. */
    appointmentId: uuid('appointment_id'),

    /**
     * When it becomes sendable, as an instant.
     *
     * Computed from the clinic's own timezone and its quiet-hours window at
     * scheduling time, not at send time — so the row says exactly when it will
     * go out and a clinic changing its hours next month does not retroactively
     * move reminders already promised to patients.
     */
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),

    channel: reminderChannelEnum('channel').notNull().default('WHATSAPP'),

    status: reminderStatusEnum('status').notNull().default('PENDING'),

    /**
     * Set the instant a runner claims the row, before any sending happens.
     *
     * Also the stuck-work signal: a row in `SENDING` with a `claimed_at` an hour
     * old is a runner that died mid-send, and that is a different problem from a
     * row that failed. Without this they are indistinguishable.
     */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),

    attempts: integer('attempts').notNull().default(0),
    /**
     * Why the last attempt failed, in words a receptionist can act on.
     *
     * Kept on the row rather than only in a log, because the question is always
     * asked about one patient — "why didn't Mrs Rao get hers" — and an answer
     * that requires grepping a log file is an answer nobody gets.
     */
    lastError: text('last_error'),

    sentAt: timestamp('sent_at', { withTimezone: true }),

    /**
     * The message that was actually sent.
     *
     * The reminder is the intention; the `communication` row is the delivery and
     * owns the lifecycle, the provider id and the delivery receipt. Keeping them
     * separate means a reminder can be skipped without a message existing, and a
     * message can be read and reported on without knowing it began as a
     * reminder.
     */
    communicationId: uuid('communication_id'),

    /**
     * Whether a copy goes to the clinic's own number.
     *
     * Per-reminder rather than read from settings at send time, so turning the
     * setting off does not silently change what was already scheduled — and so
     * the row records what was actually intended. Off by default: a clinic
     * copying itself on every patient reminder is a clinic whose phone becomes
     * unusable, and it is the patient's appointment, not the clinic's.
     */
    notifyClinic: boolean('notify_clinic').notNull().default(false),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.patientId], foreignColumns: [patient.id] }).onDelete('restrict'),

    /*
     * The due-work index, which is the only hot read on this table.
     *
     * Partial on PENDING, because that is the only status `run-due` looks at and
     * the table is otherwise almost entirely history. A clinic three years in
     * has tens of thousands of SENT rows and a handful of pending ones; an index
     * covering all of them would be mostly dead weight on every scan.
     */
    index('scheduled_reminder_due_idx')
      .on(t.clinicId, t.dueAt)
      .where(sql`status = 'PENDING'`),

    /** "What has this patient been sent", which is how the question is asked. */
    index('scheduled_reminder_patient_idx').on(t.clinicId, t.patientId, t.dueAt.desc()),

    /*
     * One live reminder per encounter per kind.
     *
     * Signing a consultation schedules a follow-up reminder. Amending it, or any
     * other path that reaches the same code twice, must not schedule a second —
     * the patient would get two identical messages and nobody would be able to
     * say why. Partial on the statuses that are still going to produce a
     * message, so a CANCELLED reminder does not block rescheduling a new one.
     */
    uniqueIndex('scheduled_reminder_encounter_uq')
      .on(t.encounterId, t.kind)
      .where(sql`encounter_id IS NOT NULL AND status IN ('PENDING', 'SENDING', 'SENT')`),

    tenantPolicy('scheduled_reminder'),
  ],
).enableRLS();
