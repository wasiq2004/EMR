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
  // DELIBERATELY ABSENT — authorship of clinical content, not visibility of it:
  //   encounter:finalize, prescription:sign, prescription:create,
  //   encounterClinicalContent:create/update, internalNote:*
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
