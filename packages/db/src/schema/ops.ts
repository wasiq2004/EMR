/**
 * Operational entities: Task, Invoice/Payment, AuditEvent, and import/export jobs.
 *
 * FHIR mapping:
 *   task       → Task
 *   invoice    → Invoice
 *   payment    → PaymentReconciliation
 *   auditEvent → AuditEvent
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
  appendOnlyTenantPolicies,
  auditColumns,
  auditOutcomeEnum,
  clinicIdColumn,
  invoiceStatusEnum,
  paymentMethodEnum,
  primaryKeyColumn,
  taskPriorityEnum,
  taskStatusEnum,
  tenantPolicy,
} from './shared';
import { appUser, clinic } from './tenancy';
import { patient } from './patient';
import { encounter } from './clinical';

/* ------------------------------------------------------------------------- *
 * 15. Task (FHIR Task)
 * ------------------------------------------------------------------------- */

/**
 * Front-desk and clinical to-dos. Deliberately a first-class entity rather than
 * an ad-hoc notification list, because several safety mechanisms in this system
 * terminate in a human action that must be tracked to completion:
 *
 *   - a prescription not confirmed delivered within 15 minutes (risk R2)
 *   - a duplicate-patient candidate awaiting review (risk R4)
 *   - a lab report received and needing doctor review
 *   - a follow-up call the doctor requested at the end of an encounter
 *
 * An alert nobody is accountable for is an alert nobody actions.
 */
export const task = pgTable(
  'task',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    status: taskStatusEnum('status').notNull().default('REQUESTED'),
    priority: taskPriorityEnum('priority').notNull().default('ROUTINE'),

    /** Machine-readable kind, e.g. DELIVERY_FAILED, DUPLICATE_REVIEW, FOLLOW_UP_CALL. */
    taskType: text('task_type').notNull(),
    title: text('title').notNull(),
    description: text('description'),

    patientId: uuid('patient_id'),
    encounterId: uuid('encounter_id'),

    /** Generic pointer to whatever triggered the task, for deep-linking the UI. */
    focusResourceType: text('focus_resource_type'),
    focusResourceId: uuid('focus_resource_id'),

    assignedToUserId: uuid('assigned_to_user_id'),
    /** Role-level assignment when no individual is nominated, e.g. any RECEPTIONIST. */
    assignedToRole: text('assigned_to_role'),

    dueAt: timestamp('due_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedBy: uuid('completed_by'),
    resolutionNotes: text('resolution_notes'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.patientId], foreignColumns: [patient.id] }).onDelete('set null'),
    foreignKey({ columns: [t.encounterId], foreignColumns: [encounter.id] }).onDelete('set null'),
    foreignKey({ columns: [t.assignedToUserId], foreignColumns: [appUser.id] }).onDelete('set null'),

    /** The worklist query — partial so it never scans completed history. */
    index('task_clinic_open_idx')
      .on(t.clinicId, t.priority, t.dueAt)
      .where(sql`status IN ('REQUESTED','ACCEPTED','IN_PROGRESS')`),
    index('task_clinic_assignee_idx').on(t.clinicId, t.assignedToUserId, t.status),
    index('task_clinic_patient_idx').on(t.clinicId, t.patientId),
    tenantPolicy('task'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * 16. Invoice (FHIR Invoice) — Billing-Lite
 * ------------------------------------------------------------------------- */

/**
 * Billing-Lite: consultation and procedure charges, discounts, and payment
 * receipts. Explicitly NOT an accounting system — no ledger, no GST filing, no
 * TDS. That boundary is stated in the technical assessment and should be in the
 * contract, because it is the most common place for scope to expand silently.
 *
 * All monetary amounts are stored in PAISE as integers. Never floats: currency
 * arithmetic in binary floating point produces reconciliation errors that are
 * tedious to find and embarrassing to explain to a clinic.
 */
export const invoice = pgTable(
  'invoice',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    patientId: uuid('patient_id').notNull(),
    encounterId: uuid('encounter_id'),

    /** Human-readable, sequential per clinic per financial year, e.g. "INV-2026-0142". */
    invoiceNumber: text('invoice_number').notNull(),
    status: invoiceStatusEnum('status').notNull().default('DRAFT'),

    /**
     * Line items: [{ description, quantity, unitPricePaise, amountPaise, hsnSac? }]
     * JSONB rather than a child table: line items are never queried
     * independently of their invoice, and are frozen once the invoice is issued.
     */
    lineItems: jsonb('line_items').notNull().default(sql`'[]'::jsonb`),

    subtotalPaise: bigint('subtotal_paise', { mode: 'number' }).notNull().default(0),
    discountPaise: bigint('discount_paise', { mode: 'number' }).notNull().default(0),
    discountReason: text('discount_reason'),
    taxPaise: bigint('tax_paise', { mode: 'number' }).notNull().default(0),
    totalPaise: bigint('total_paise', { mode: 'number' }).notNull().default(0),
    paidPaise: bigint('paid_paise', { mode: 'number' }).notNull().default(0),

    currency: text('currency').notNull().default('INR'),

    issuedAt: timestamp('issued_at', { withTimezone: true }),
    /** Issued invoices are immutable; corrections are credit notes. */
    isFinalized: boolean('is_finalized').notNull().default(false),
    cancelledReason: text('cancelled_reason'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.patientId], foreignColumns: [patient.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.encounterId], foreignColumns: [encounter.id] }).onDelete('set null'),

    uniqueIndex('invoice_clinic_number_uq').on(t.clinicId, t.invoiceNumber),
    index('invoice_clinic_patient_idx').on(t.clinicId, t.patientId, t.createdAt.desc()),
    /** Outstanding-dues report. */
    index('invoice_clinic_unpaid_idx')
      .on(t.clinicId, t.issuedAt)
      .where(sql`status = 'ISSUED' AND paid_paise < total_paise`),
    tenantPolicy('invoice'),
  ],
).enableRLS();

/**
 * A payment receipt against an invoice. Separate from `invoice` because partial
 * payments and mixed tender (part cash, part UPI) are routine at the front desk.
 */
export const payment = pgTable(
  'payment',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),
    invoiceId: uuid('invoice_id').notNull(),
    patientId: uuid('patient_id').notNull(),

    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    method: paymentMethodEnum('method').notNull(),

    /** UPI transaction reference, cheque number, card auth code. */
    referenceNumber: text('reference_number'),

    /**
     * The client's key for this one payment, so a retry cannot take the money
     * twice.
     *
     * A front desk is the worst place for an at-least-once write. The terminal
     * is tapped twice because the first tap did not visibly do anything, or the
     * request times out and the receptionist tries again with the patient
     * waiting — and a duplicate receipt looks exactly as real as the original.
     * Reconciling it later means deciding which of two identical ₹300 rows was
     * never actually collected, which nobody can do.
     *
     * Nullable, because payments written before this column existed have no key
     * and inventing one would be a lie about what happened. The unique index is
     * partial for the same reason.
     */
    idempotencyKey: text('idempotency_key'),

    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    receivedBy: uuid('received_by').notNull(),

    /** Refunds are negative-amount rows, never deletions of the original payment. */
    isRefund: boolean('is_refund').notNull().default(false),
    refundReason: text('refund_reason'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.invoiceId], foreignColumns: [invoice.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.patientId], foreignColumns: [patient.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.receivedBy], foreignColumns: [appUser.id] }).onDelete('restrict'),

    index('payment_clinic_invoice_idx').on(t.clinicId, t.invoiceId),
    /** Daily collection report. */
    index('payment_clinic_received_idx').on(t.clinicId, t.receivedAt.desc()),
    /*
     * One payment per key per clinic.
     *
     * Scoped to the clinic rather than globally, so two clinics generating the
     * same key cannot block each other. The database enforces this, not the
     * service: a check-then-insert in application code loses to two concurrent
     * requests, which is precisely the double-tap this exists to stop.
     */
    uniqueIndex('payment_idempotency_uq')
      .on(t.clinicId, t.idempotencyKey)
      .where(sql`idempotency_key IS NOT NULL`),
    tenantPolicy('payment'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * 17. AuditEvent (FHIR AuditEvent) — APPEND ONLY
 * ------------------------------------------------------------------------- */

/**
 * ============================ SECURITY BOUNDARY ============================
 * The immutable audit trail. Required by the DPDP security baseline and by the
 * SoW for all clinical record creation, edits, finalisations, exports and
 * document sharing.
 *
 * Immutability is enforced by THREE independent controls, because an audit log
 * that the application can rewrite is worthless in an investigation:
 *   1. RLS policies permitting only SELECT and INSERT (appendOnlyTenantPolicies)
 *   2. REVOKE UPDATE, DELETE from emr_app at the grant level (migration 0001)
 *   3. A BEFORE UPDATE OR DELETE trigger that raises an exception (migration 0001)
 *
 * Rows are written by the global AuditInterceptor, not by feature code. See
 * docs/phase-0/04 §5.
 * ===========================================================================
 */
export const auditEvent = pgTable(
  'audit_event',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),

    /* --- Who --- */
    /**
     * Not foreign-keyed to app_user: the audit record must survive deletion or
     * anonymisation of the staff account under a DPDP erasure request. Identity
     * is therefore denormalised at write time.
     */
    actorUserId: uuid('actor_user_id'),
    actorName: text('actor_name'),
    actorRole: text('actor_role'),
    /** Null for system/background actions; set to the job name instead. */
    actorType: text('actor_type').notNull().default('USER'),

    /* --- What --- */
    /** e.g. ENCOUNTER_FINALIZED, PRESCRIPTION_SIGNED, PATIENT_EXPORTED, DOCUMENT_SHARED. */
    action: text('action').notNull(),
    outcome: auditOutcomeEnum('outcome').notNull().default('SUCCESS'),
    outcomeDescription: text('outcome_description'),

    /* --- On what --- */
    resourceType: text('resource_type'),
    resourceId: uuid('resource_id'),
    /** Denormalised so the trail stays readable if the resource is later removed. */
    resourceLabel: text('resource_label'),
    /** Patient the action concerned, for per-patient access reports. */
    patientId: uuid('patient_id'),

    /* --- From where --- */
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    /** Correlates every log line, span and audit row for one request. */
    requestId: text('request_id'),
    httpMethod: text('http_method'),
    httpPath: text('http_path'),
    httpStatus: integer('http_status'),

    /**
     * Field-level before/after for mutations. Values of clinical free-text
     * fields are hashed rather than stored verbatim, so the audit log does not
     * become a second uncontrolled copy of the clinical record.
     */
    changeSummary: jsonb('change_summary'),

    /** Immutable: no updatedAt/updatedBy/version, by design. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),

    /** Primary audit review query. */
    index('audit_event_clinic_occurred_idx').on(t.clinicId, t.occurredAt.desc()),
    /** "Who accessed this patient's record?" — the DPDP subject-access query. */
    index('audit_event_clinic_patient_idx').on(t.clinicId, t.patientId, t.occurredAt.desc()),
    index('audit_event_clinic_actor_idx').on(t.clinicId, t.actorUserId, t.occurredAt.desc()),
    index('audit_event_clinic_resource_idx').on(t.clinicId, t.resourceType, t.resourceId),
    /** Security monitoring: surface failures immediately. */
    index('audit_event_failures_idx')
      .on(t.clinicId, t.occurredAt.desc())
      .where(sql`outcome <> 'SUCCESS'`),
    index('audit_event_request_idx').on(t.requestId),

    ...appendOnlyTenantPolicies('audit_event'),
  ],
).enableRLS();

/* ------------------------------------------------------------------------- *
 * Import / Export jobs — data portability
 * ------------------------------------------------------------------------- */

/**
 * Import wizard run. Staged and validated in full before ANY row is committed:
 * a half-imported patient registry is worse than no import, because staff
 * cannot tell which records are trustworthy.
 */
export const importJob = pgTable(
  'import_job',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    /** PATIENTS, ENCOUNTERS, PRESCRIPTIONS, DOCUMENTS. */
    entityType: text('entity_type').notNull(),
    sourceObjectKey: text('source_object_key').notNull(),
    sourceFilename: text('source_filename').notNull(),

    /** Column mapping the user confirmed in the wizard: { sourceColumn: targetField }. */
    columnMapping: jsonb('column_mapping').notNull().default(sql`'{}'::jsonb`),

    /** PENDING / VALIDATING / AWAITING_CONFIRMATION / COMMITTING / COMPLETED / FAILED. */
    status: text('status').notNull().default('PENDING'),

    totalRows: integer('total_rows').notNull().default(0),
    validRows: integer('valid_rows').notNull().default(0),
    errorRows: integer('error_rows').notNull().default(0),
    duplicateRows: integer('duplicate_rows').notNull().default(0),
    importedRows: integer('imported_rows').notNull().default(0),

    /** S3 key of the row-level error report handed back to the clinic. */
    errorReportObjectKey: text('error_report_object_key'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    requestedBy: uuid('requested_by').notNull(),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.requestedBy], foreignColumns: [appUser.id] }).onDelete('restrict'),
    index('import_job_clinic_idx').on(t.clinicId, t.createdAt.desc()),
    tenantPolicy('import_job'),
  ],
).enableRLS();

/**
 * Full-clinic export — the zero-lock-in guarantee made operational.
 *
 * Produces patients.csv, encounters.csv, prescriptions.csv, observations.csv,
 * allergies.csv, documents.csv plus the document binary bundle, streamed
 * directly to S3. Every export writes an audit_event: a full clinical data
 * export is exactly the action a departing employee would perform, so it must
 * be visible.
 */
export const exportJob = pgTable(
  'export_job',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    /** FULL_CLINIC, PATIENT_SUBSET, DATE_RANGE. */
    exportType: text('export_type').notNull(),
    parameters: jsonb('parameters').notNull().default(sql`'{}'::jsonb`),

    /** PENDING / BUILDING / COMPLETED / FAILED / EXPIRED. */
    status: text('status').notNull().default('PENDING'),

    resultObjectKey: text('result_object_key'),
    resultSizeBytes: bigint('result_size_bytes', { mode: 'number' }),
    resultSha256: text('result_sha256'),
    /** Export bundles self-destruct: PHI must not accumulate in object storage. */
    downloadExpiresAt: timestamp('download_expires_at', { withTimezone: true }),

    includedDocumentCount: integer('included_document_count'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    requestedBy: uuid('requested_by').notNull(),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.requestedBy], foreignColumns: [appUser.id] }).onDelete('restrict'),
    index('export_job_clinic_idx').on(t.clinicId, t.createdAt.desc()),
    index('export_job_expiry_idx')
      .on(t.downloadExpiresAt)
      .where(sql`status = 'COMPLETED'`),
    tenantPolicy('export_job'),
  ],
).enableRLS();
