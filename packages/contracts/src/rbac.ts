/**
 * The RBAC matrix — the single source of truth for authorisation.
 *
 * This lives in `@emr/contracts` so the API guard and the web navigation read
 * one definition instead of two that drift. THE API IS STILL THE ENFORCEMENT
 * POINT. The frontend consumes this only to avoid offering actions that will be
 * refused; it is never a security boundary. A client that lies about its role
 * gets a 403 from the server, which is the only answer that counts.
 *
 * DESIGN PRINCIPLES (unchanged from the original server-side matrix)
 *
 * 1. DENY BY DEFAULT. A (role, resource, action) triple absent from the matrix
 *    is denied. An endpoint that declares no permission is unreachable.
 *
 * 2. CLINICAL ACTS REQUIRE A CLINICIAN. Finalising an encounter and signing a
 *    prescription are restricted to DOCTOR — including against OWNER_ADMIN. An
 *    administrator, even the practice owner, is not necessarily a registered
 *    medical practitioner and must not be able to produce a document bearing a
 *    practitioner's registration number. This is a legal constraint, not a
 *    product preference, and it is why the matrix is not a seniority hierarchy.
 *
 * 3. THE AUDITOR SEES THE TRAIL, NOT THE PATIENT. An AUDITOR reads audit
 *    events, configuration and aggregate reports — never clinical content.
 *
 * 4. INTERNAL NOTES ARE CLINICIAN-ONLY. A doctor's private working note is not
 *    part of the clinical record and is excluded even from OWNER_ADMIN.
 */

import type { UserRole } from './enums';

export const RESOURCES = [
  'clinic',
  'user',
  'patient',
  'appointment',
  'encounter',
  'encounterClinicalContent',
  'internalNote',
  'observation',
  'condition',
  'allergy',
  'prescription',
  'document',
  'communication',
  'task',
  'consent',
  'invoice',
  'payment',
  'report',
  'auditEvent',
  'import',
  'export',

  /* ---- Pharmacy ------------------------------------------------------- *
   *
   * Separate resources rather than one `pharmacy`, because the boundaries
   * inside a pharmacy are real. The person who dispenses is often not the
   * person allowed to approve a purchase order or write off expired stock, and
   * a single resource would make those the same permission.
   */

  /** The pharmacy's own sellable products, mapped to the drug catalogue. */
  'pharmacyProduct',
  'supplier',
  /** Orders, receipts and purchase returns — the money side of stock. */
  'purchaseOrder',
  /** Batches, quantities and the movement ledger. */
  'stock',
  /** Handing medicine over against a finalised prescription. */
  'dispense',
  /**
   * A question from the counter back to the prescriber.
   *
   * Its own resource because the two ends are different roles: a pharmacist
   * raises it and a doctor answers it, so neither one's permission set can
   * describe it alone.
   */
  'clarification',
  /** Over-the-counter and prescription-linked sales at the medicine counter. */
  'pharmacySale',

  /* ---- Governed analytics --------------------------------------------- *
   *
   * Deliberately NOT `report`, which is the clinic's own operational reporting
   * and is read by owners and doctors. These are de-identified cohorts, and
   * keeping them apart is what lets the analyst role hold one and not the
   * other.
   */
  'cohort',
  /**
   * Aggregate and data-quality reads over the clinical tables.
   *
   * Holding this NEVER implies patient:read. Every endpoint behind it returns
   * counts, bands and codes; there is no projection that includes a name.
   */
  'analytics',
] as const;

export const ACTIONS = [
  'read',
  'create',
  'update',
  'delete',
  'finalize',
  'sign',
  'share',
  'merge',
  'execute',
  /**
   * Change how a channel is set up — connect a WhatsApp number, sync its
   * templates, disconnect it. Distinct from `communication:create`, which is
   * permission to send ONE message to ONE patient: a receptionist needs that
   * every hour and must never be able to repoint the clinic's number.
   */
  'configure',
  /**
   * Send to many patients at once. Its own action because the blast radius is
   * categorically different — a mistake in a reply reaches one person, and a
   * mistake in a broadcast reaches the register.
   */
  'broadcast',
  /**
   * Commit money on the clinic's behalf — approve a purchase order, accept a
   * goods receipt at the quoted rate.
   *
   * Separate from `create` because raising an order and authorising the spend
   * are routinely different people, and at a small clinic the second one is
   * the owner. A pharmacist who can do both needs no approval step, which is
   * a decision the clinic should make rather than the software.
   */
  'approve',
  /**
   * Answer a clarification and close it.
   *
   * Held by the prescriber, not by whoever asked. A pharmacist who could
   * resolve their own clarification would have found a way to change a
   * prescription with an extra step.
   */
  'resolve',
] as const;

export type Resource = (typeof RESOURCES)[number];
export type Action = (typeof ACTIONS)[number];
export type Permission = `${Resource}:${Action}`;

const p = (resource: Resource, ...actions: Action[]): Permission[] =>
  actions.map((a) => `${resource}:${a}` as Permission);

/* ------------------------------------------------------------------------- *
 * OWNER_ADMIN — runs the practice. Full visibility, no clinical authorship.
 * ------------------------------------------------------------------------- */
const OWNER_ADMIN: Permission[] = [
  ...p('clinic', 'read', 'update'),
  ...p('user', 'read', 'create', 'update', 'delete'),
  ...p('patient', 'read', 'create', 'update', 'merge'),
  ...p('appointment', 'read', 'create', 'update', 'delete'),
  ...p('encounter', 'read'),
  // Full clinical READ. Every such access is additionally tagged
  // OWNER_CLINICAL_ACCESS in the audit trail, so a practice can demonstrate to
  // its clinicians exactly when management viewed a clinical record.
  ...p('encounterClinicalContent', 'read'),
  ...p('observation', 'read'),
  ...p('condition', 'read'),
  ...p('allergy', 'read'),
  ...p('prescription', 'read'),
  ...p('document', 'read', 'create', 'share'),
  // Configure and broadcast are admin-only. See the ACTIONS notes for why they
  // are not folded into `create`.
  ...p('communication', 'read', 'create', 'configure', 'broadcast'),
  ...p('task', 'read', 'create', 'update'),
  ...p('consent', 'read', 'create', 'update'),
  ...p('invoice', 'read', 'create', 'update', 'delete'),
  ...p('payment', 'read', 'create', 'update'),
  ...p('report', 'read'),
  ...p('auditEvent', 'read'),
  ...p('import', 'read', 'create', 'execute'),
  ...p('export', 'read', 'create', 'execute'),

  /*
   * Pharmacy: configure it and see the money, do not work the counter.
   *
   * The owner sets up products, suppliers and tax, approves spend and reads
   * every report. `dispense:create` is absent on purpose — handing medicine to
   * a patient is a licensed act and belongs to the pharmacist, and an owner who
   * needs to do it in a pinch should hold the pharmacist role too rather than
   * have the boundary quietly removed for everyone.
   */
  ...p('pharmacyProduct', 'read', 'create', 'update', 'delete'),
  ...p('supplier', 'read', 'create', 'update', 'delete'),
  ...p('purchaseOrder', 'read', 'create', 'update', 'approve'),
  ...p('stock', 'read', 'update'),
  ...p('dispense', 'read'),
  ...p('clarification', 'read'),
  ...p('pharmacySale', 'read', 'create'),

  /* Governed analytics, which an owner reads but does not need to define. */
  ...p('cohort', 'read'),
  ...p('analytics', 'read'),

  // DELIBERATELY ABSENT — authorship of clinical content, not visibility of it:
  //   encounter:finalize, prescription:sign, prescription:create,
  //   encounterClinicalContent:create/update, internalNote:*
  // And not the counter itself: dispense:create, clarification:resolve.
];

/**
 * Permissions tagged in the audit trail because the actor is not the clinician
 * who authored the record. A transparency measure, not a restriction.
 */
export const ELEVATED_VISIBILITY_PERMISSIONS: ReadonlySet<Permission> =
  new Set<Permission>(['encounterClinicalContent:read']);

/* ------------------------------------------------------------------------- *
 * DOCTOR — the only role that may practise medicine in this system.
 * ------------------------------------------------------------------------- */
const DOCTOR: Permission[] = [
  ...p('clinic', 'read'),
  ...p('user', 'read'),
  ...p('patient', 'read', 'create', 'update'),
  ...p('appointment', 'read', 'create', 'update'),
  ...p('encounter', 'read', 'create', 'update', 'finalize'),
  ...p('encounterClinicalContent', 'read', 'create', 'update'),
  ...p('internalNote', 'read', 'create', 'update', 'delete'),
  ...p('observation', 'read', 'create', 'update'),
  ...p('condition', 'read', 'create', 'update'),
  ...p('allergy', 'read', 'create', 'update'),
  ...p('prescription', 'read', 'create', 'update', 'sign'),
  ...p('document', 'read', 'create', 'share'),
  ...p('communication', 'read', 'create'),
  ...p('task', 'read', 'create', 'update'),
  ...p('consent', 'read', 'create'),
  ...p('invoice', 'read'),
  ...p('report', 'read'),
  ...p('export', 'read', 'create', 'execute'),

  /*
   * The prescriber's end of the pharmacy hand-off.
   *
   * `clarification:resolve` is the point: the counter asks, the doctor answers,
   * and the answer is attached to the prescription instead of happening on a
   * phone call nobody can later reconstruct. Read access to dispensing exists
   * so a doctor can see whether the patient actually collected the medicine —
   * which is the single most useful thing pharmacy data tells a clinician.
   */
  ...p('clarification', 'read', 'resolve'),
  ...p('dispense', 'read'),
  ...p('stock', 'read'),
  ...p('analytics', 'read'),
];

/* ------------------------------------------------------------------------- *
 * RECEPTIONIST — front desk. No clinical content, in or out.
 * ------------------------------------------------------------------------- */
const RECEPTIONIST: Permission[] = [
  ...p('clinic', 'read'),
  ...p('patient', 'read', 'create', 'update'),
  ...p('appointment', 'read', 'create', 'update', 'delete'),
  // Encounter METADATA only — enough to see that Dr X saw the patient at 10:15
  // and the visit is complete, without exposing the clinical record.
  ...p('encounter', 'read'),
  ...p('document', 'read', 'create', 'share'),
  ...p('communication', 'read', 'create'),
  ...p('task', 'read', 'create', 'update'),
  ...p('consent', 'read', 'create'),
  ...p('invoice', 'read', 'create', 'update'),
  ...p('payment', 'read', 'create'),
  /*
   * Stock READ and nothing else.
   *
   * "Do you have this in stock?" is asked at the front desk twenty times a day,
   * and the alternative is the receptionist walking to the counter. It is a
   * quantity against a product name — no batch, no cost, no patient.
   */
  ...p('stock', 'read'),
];

/* ------------------------------------------------------------------------- *
 * NURSE_ASSISTANT — records vitals and allergies; does not diagnose or prescribe.
 * ------------------------------------------------------------------------- */
const NURSE_ASSISTANT: Permission[] = [
  ...p('clinic', 'read'),
  ...p('patient', 'read', 'update'),
  ...p('appointment', 'read', 'update'),
  ...p('encounter', 'read'),
  ...p('encounterClinicalContent', 'read'),
  ...p('observation', 'read', 'create', 'update'),
  ...p('condition', 'read'),
  // Allergy CREATE is granted deliberately — the nurse is usually the person
  // who asks the question at triage, and blocking it means the allergy is never
  // recorded at all.
  ...p('allergy', 'read', 'create'),
  ...p('prescription', 'read'),
  ...p('document', 'read', 'create'),
  ...p('communication', 'read', 'create'),
  ...p('task', 'read', 'create', 'update'),
  ...p('consent', 'read'),
];

/* ------------------------------------------------------------------------- *
 * PHARMACIST — works the medicine counter. Reads orders, never writes them.
 *
 * The shape of this role is one sentence: everything needed to hand the right
 * medicine to the right person and account for it, and nothing that could
 * change what was prescribed.
 *
 * So `prescription:read` without `update`, and `clarification:create` without
 * `resolve`. A pharmacist who disagrees with a prescription raises a question
 * and waits; that is slower than editing it, and it is the only version that is
 * safe and the only version that leaves a record.
 * ------------------------------------------------------------------------- */
const PHARMACIST: Permission[] = [
  ...p('clinic', 'read'),
  ...p('user', 'read'),

  /*
   * Patient READ, deliberately, and nothing more.
   *
   * Dispensing safely needs the person's name, age and allergies — handing out
   * amoxicillin to a penicillin-allergic patient is the exact failure this
   * guards against. It does not need the consultation note, the diagnosis or
   * the history, and none of those are here.
   */
  ...p('patient', 'read'),
  ...p('allergy', 'read'),

  /* Enough encounter context to know which visit an order came from. */
  ...p('encounter', 'read'),
  ...p('prescription', 'read'),

  /* The counter itself. */
  ...p('dispense', 'read', 'create', 'update'),
  ...p('clarification', 'read', 'create'),
  ...p('stock', 'read', 'create', 'update'),
  ...p('pharmacyProduct', 'read', 'create', 'update'),
  ...p('supplier', 'read', 'create', 'update'),
  /*
   * Raises a purchase order but does not approve it. A clinic that wants the
   * pharmacist to do both grants `purchaseOrder:approve` to the role from
   * Settings; the default is the safer split.
   */
  ...p('purchaseOrder', 'read', 'create', 'update'),
  ...p('pharmacySale', 'read', 'create', 'update'),

  /* Its own operational reporting: what moved, what is expiring, what is out. */
  ...p('report', 'read'),

  /* Tasks, because a clarification and a stock-out both generate follow-up. */
  ...p('task', 'read', 'create', 'update'),

  // DELIBERATELY ABSENT:
  //   encounterClinicalContent:read  — the consultation note is not needed to
  //                                    dispense, so it is not visible.
  //   condition:read                 — the diagnosis likewise.
  //   prescription:update / :sign    — a finalised order is read-only, always.
  //   clarification:resolve          — the prescriber answers, not the asker.
  //   purchaseOrder:approve          — raising and authorising spend are split.
  //   invoice:* / payment:*          — clinic billing is the front desk's;
  //                                    pharmacySale is the counter's own.
];

/* ------------------------------------------------------------------------- *
 * RESEARCH_ANALYST — learns from the clinic's data without learning whose.
 *
 * The guarantee is the SHAPE OF THE PERMISSION SET, not a flag on a query.
 * This role holds no `patient:read`, no `encounterClinicalContent:read` and no
 * `document:read`, so there is no endpoint reachable with this session that
 * returns a name, a mobile number, an MRN or a date of birth. De-identification
 * is therefore not a mode that can be left switched off — it is the absence of
 * any route to the identifying data.
 *
 * `analytics:read` and `cohort:*` are the whole of the clinical surface, and
 * every handler behind them projects counts, age bands and codes.
 * ------------------------------------------------------------------------- */
const RESEARCH_ANALYST: Permission[] = [
  ...p('clinic', 'read'),

  /* Define, save, run and share a cohort definition. */
  ...p('cohort', 'read', 'create', 'update', 'delete'),

  /* Aggregates, trends and data quality. */
  ...p('analytics', 'read'),

  /*
   * Export is granted and is not a contradiction.
   *
   * What it exports is a cohort — rows of bands and codes with the definition,
   * the generation time and the source version attached, per the blueprint's
   * provenance requirement. The export handler reads the same de-identified
   * projection every screen does; there is no privileged path for it.
   */
  ...p('export', 'read', 'create'),

  // DELIBERATELY ABSENT, and this list is the privacy guarantee:
  //   patient:read, encounter:read, encounterClinicalContent:read,
  //   observation:read, condition:read, allergy:read, prescription:read,
  //   document:read, communication:read, invoice:read, auditEvent:read.
  //
  // An analyst who needs to act on a specific person is asking for a different
  // job, which is the clinician's. See docs for why un-blinding was rejected.
];

/* ------------------------------------------------------------------------- *
 * AUDITOR — compliance review. Sees who did what, never what was recorded.
 * ------------------------------------------------------------------------- */
const AUDITOR: Permission[] = [
  ...p('clinic', 'read'),
  ...p('user', 'read'),
  ...p('auditEvent', 'read'),
  ...p('consent', 'read'),
  ...p('report', 'read'),
];

export const PERMISSION_MATRIX: Readonly<Record<UserRole, ReadonlySet<Permission>>> =
  Object.freeze({
    OWNER_ADMIN: new Set(OWNER_ADMIN),
    DOCTOR: new Set(DOCTOR),
    RECEPTIONIST: new Set(RECEPTIONIST),
    NURSE_ASSISTANT: new Set(NURSE_ASSISTANT),
    PHARMACIST: new Set(PHARMACIST),
    RESEARCH_ANALYST: new Set(RESEARCH_ANALYST),
    AUDITOR: new Set(AUDITOR),
  });

export function can(role: UserRole, permission: Permission): boolean {
  return PERMISSION_MATRIX[role]?.has(permission) ?? false;
}

/** True only if the role holds every permission listed. */
export function canAll(role: UserRole, permissions: Permission[]): boolean {
  return permissions.every((permission) => can(role, permission));
}

/** True if the role holds at least one of the permissions listed. */
export function canAny(role: UserRole, permissions: Permission[]): boolean {
  return permissions.some((permission) => can(role, permission));
}

/**
 * Permissions that additionally require the actor to be a registered medical
 * practitioner with a non-null medical registration number.
 *
 * Holding DOCTOR is necessary but not sufficient: a doctor account created
 * without a registration number cannot sign, because the number is a legally
 * required element of a valid Indian e-prescription and would otherwise print
 * blank on the document.
 */
export const REQUIRES_MEDICAL_REGISTRATION: ReadonlySet<Permission> =
  new Set<Permission>(['encounter:finalize', 'prescription:sign']);
