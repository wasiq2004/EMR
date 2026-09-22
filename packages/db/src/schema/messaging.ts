/**
 * Templates and broadcasts.
 *
 * Separate from `comms.ts` because the concerns are genuinely different:
 * `comms.ts` is one conversation with one patient, and this is authored content
 * sent to many. They share the `communication` log, which is where every
 * dispatched message lands whichever path produced it.
 */

import { sql } from 'drizzle-orm';
import {
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
  broadcastPurposeEnum,
  broadcastStatusEnum,
  clinicIdColumn,
  communicationStatusEnum,
  primaryKeyColumn,
  templateStatusEnum,
  tenantPolicy,
} from './shared';
import { clinic } from './tenancy';
import { patient } from './patient';

/* ------------------------------------------------------------------------- *
 * Message templates
 *
 * WhatsApp does not let a business open a conversation with free text. Outside
 * the 24-hour service window every outbound message must be a template the
 * provider approved beforehand, so this table is not a convenience — it is the
 * only way a reminder or a broadcast can leave the building.
 *
 * Approval lives with the provider and can be withdrawn retroactively and
 * without warning, so `status` mirrors their state rather than ours, and the
 * sending path reads it instead of assuming.
 * ------------------------------------------------------------------------- */

export const messageTemplate = pgTable(
  'message_template',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    /** The provider's name for it, e.g. `appointment_reminder_v2`. */
    name: text('name').notNull(),
    language: text('language').notNull().default('en'),
    category: text('category'),

    status: templateStatusEnum('status').notNull().default('DRAFT'),
    /** The provider's reason, when REJECTED or PAUSED. */
    statusReason: text('status_reason'),

    /** Body with {{1}}-style placeholders, exactly as approved. */
    body: text('body').notNull(),
    headerText: text('header_text'),
    footerText: text('footer_text'),
    buttons: jsonb('buttons').$type<{ type: string; text: string; url?: string }[]>(),

    /**
     * What each placeholder means, so a broadcast can be composed without the
     * author counting braces: `[{ index: 1, label: 'Patient first name' }]`.
     */
    variables: jsonb('variables').$type<{ index: number; label: string }[]>(),

    /**
     * Which consent this template's content requires.
     *
     * A template is written for a purpose, and recording it here stops
     * marketing copy going out under a template someone registered as clinical.
     */
    purpose: broadcastPurposeEnum('purpose').notNull().default('CLINICAL'),

    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    uniqueIndex('message_template_name_uq').on(t.clinicId, t.name, t.language),
    index('message_template_status_idx').on(t.clinicId, t.status),
    tenantPolicy('message_template'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * Broadcast
 *
 * One authored message, many recipients, one record of what happened.
 *
 * THE AUDIENCE IS FROZEN AT SEND, NOT RE-EVALUATED DURING IT.
 * `audienceFilter` records what was asked for; `broadcast_recipient` records
 * who that resolved to, written in one transaction when the broadcast starts.
 * A filter re-run mid-send would pick up patients registered after it began and
 * drop ones whose consent lapsed an hour in — so "who did we message?" would
 * have no answer, and that is the only question anyone asks afterwards.
 * ------------------------------------------------------------------------- */

export const broadcast = pgTable(
  'broadcast',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    name: text('name').notNull(),
    purpose: broadcastPurposeEnum('purpose').notNull(),
    status: broadcastStatusEnum('status').notNull().default('DRAFT'),

    templateId: uuid('template_id').notNull(),
    templateVariables: jsonb('template_variables').$type<Record<string, string>>(),

    /** What was asked for. Who it reached is in broadcast_recipient. */
    audienceFilter: jsonb('audience_filter').$type<Record<string, unknown>>(),

    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledReason: text('cancelled_reason'),

    /*
     * Counters, maintained as the send progresses.
     *
     * Denormalised on purpose: a broadcast to several thousand patients would
     * otherwise aggregate its child table on every progress poll, and the
     * progress bar is polled precisely while that table is being written to.
     */
    recipientCount: integer('recipient_count').notNull().default(0),
    sentCount: integer('sent_count').notNull().default(0),
    deliveredCount: integer('delivered_count').notNull().default(0),
    readCount: integer('read_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),

    /** Who was left out and why, counted per reason. Shown BEFORE sending. */
    exclusionSummary: jsonb('exclusion_summary').$type<Record<string, number>>(),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.templateId], foreignColumns: [messageTemplate.id] }).onDelete('restrict'),
    index('broadcast_clinic_status_idx').on(t.clinicId, t.status),
    index('broadcast_scheduled_idx')
      .on(t.scheduledFor)
      .where(sql`status = 'SCHEDULED'`),
    tenantPolicy('broadcast'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * Broadcast recipient
 *
 * One row per patient the broadcast actually went to, written when it starts
 * and never recomputed. This is the answer to "who did we message", which is
 * what a complaint, an audit or a regulator asks for.
 * ------------------------------------------------------------------------- */

export const broadcastRecipient = pgTable(
  'broadcast_recipient',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    broadcastId: uuid('broadcast_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    /** The number as it was at send time, not as it is now. */
    mobileE164: text('mobile_e164').notNull(),

    /** Set once the dispatched message row exists. Null while queued. */
    communicationId: uuid('communication_id'),
    status: communicationStatusEnum('status').notNull().default('QUEUED'),
    failureReason: text('failure_reason'),

    /** Which consent record permitted this. The audit trail needs the specific one. */
    consentId: uuid('consent_id'),

    sentAt: timestamp('sent_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.broadcastId], foreignColumns: [broadcast.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.patientId], foreignColumns: [patient.id] }).onDelete('restrict'),

    // One row per patient per broadcast. This is what makes a resumed or
    // retried send idempotent: the insert conflicts rather than messaging
    // someone a second time.
    uniqueIndex('broadcast_recipient_uq').on(t.broadcastId, t.patientId),
    index('broadcast_recipient_status_idx').on(t.broadcastId, t.status),
    tenantPolicy('broadcast_recipient'),
  ],
).enableRLS();
