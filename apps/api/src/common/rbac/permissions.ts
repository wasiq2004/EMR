/**
 * The server-side RBAC matrix — the single source of truth for authorisation.
 *
 * DESIGN PRINCIPLES
 *
 * 1. DENY BY DEFAULT. A (role, resource, action) triple absent from the matrix
 *    is denied. An endpoint that declares no permission is unreachable, not
 *    public.
 *
 * 2. CLINICAL ACTS REQUIRE A CLINICIAN. Finalising an encounter and signing a
 *    prescription are restricted to DOCTOR — including against OWNER_ADMIN.
 *    An administrator, even the practice owner, is not necessarily a registered
 *    medical practitioner and must not be able to produce a document bearing a
 *    practitioner's registration number. This is a legal constraint, not a
 *    product preference, and it is why the matrix is not a seniority hierarchy.
 *
 *    Note the distinction from READ access: per SoW §5, Clinic Owner / Super
 *    Admin has visibility of "all clinic data subject to policy", so
 *    OWNER_ADMIN CAN read clinical content. They simply cannot author or sign
 *    it. An owner who also practises holds a separate DOCTOR account.
 *
 * 3. THE AUDITOR SEES THE TRAIL, NOT THE PATIENT. An AUDITOR reads audit
 *    events, configuration and aggregate reports — never clinical content.
 *    An audit role with PHI access defeats the purpose of having one.
 *
 * 4. INTERNAL NOTES ARE CLINICIAN-ONLY. A doctor's private working note is not
 *    part of the clinical record and is excluded even from OWNER_ADMIN. This is
 *    a policy choice under SoW §5's "subject to policy" clause: clinicians will
 *    not write candid notes they believe management reads. Configurable if the
 *    owner decides otherwise — see docs/phase-0/04 §4.1.
 */

import type { UserRole } from '../tenancy/tenant-context';

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
] as const;

export type Resource = (typeof RESOURCES)[number];
export type Action = (typeof ACTIONS)[number];
export type Permission = `${Resource}:${Action}`;

const p = (resource: Resource, ...actions: Action[]): Permission[] =>
  actions.map((a) => `${resource}:${a}` as Permission);

/* ------------------------------------------------------------------------- *
 * OWNER_ADMIN — runs the practice. Full visibility, no clinical authorship.
 *
 * Per SoW §5: "Clinic setup, users, roles, billing configuration, integrations,
 * exports, audit visibility, all clinic data subject to policy."
 * ------------------------------------------------------------------------- */
const OWNER_ADMIN: Permission[] = [
  ...p('clinic', 'read', 'update'),
  ...p('user', 'read', 'create', 'update', 'delete'),
  ...p('patient', 'read', 'create', 'update', 'merge'),
  ...p('appointment', 'read', 'create', 'update', 'delete'),
  ...p('encounter', 'read'),
  // Full clinical read per SoW §5. Every such access is additionally tagged
  // OWNER_CLINICAL_ACCESS in audit_event, so a practice can demonstrate to its
  // clinicians exactly when management viewed a clinical record.
  ...p('encounterClinicalContent', 'read'),
  ...p('observation', 'read'),
  ...p('condition', 'read'),
  ...p('allergy', 'read'),
  ...p('prescription', 'read'),
  ...p('document', 'read', 'create', 'share'),
  ...p('communication', 'read', 'create'),
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
  //   encounterClinicalContent:create/update, internalNote:* (see header note 4).
];

/**
 * Permissions whose use is additionally tagged in the audit trail because the
 * actor is not the clinician who authored the record. Not a restriction — a
 * transparency measure, so clinicians can see when management read a record.
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
  // Encounter metadata only — enough to see that Dr. X saw the patient at 10:15
  // and the visit is complete, without exposing the clinical record.
  ...p('encounter', 'read'),
  ...p('document', 'read', 'create', 'share'),
  ...p('communication', 'read', 'create'),
  ...p('task', 'read', 'create', 'update'),
  ...p('consent', 'read', 'create'),
  ...p('invoice', 'read', 'create', 'update'),
  ...p('payment', 'read', 'create'),
  // DELIBERATELY ABSENT, per the SoW: encounter:finalize, prescription:sign.
  // Also absent: prescription:create, encounterClinicalContent:*, internalNote:*.
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
  ...p('allergy', 'read', 'create'),
  ...p('prescription', 'read'),
  ...p('document', 'read', 'create'),
  ...p('communication', 'read', 'create'),
  ...p('task', 'read', 'create', 'update'),
  ...p('consent', 'read'),
  // DELIBERATELY ABSENT: internalNote:*, encounter:finalize, prescription:sign.
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
  // DELIBERATELY ABSENT: everything containing patient-identifiable clinical
  // content. Reports served to an AUDITOR are aggregate-only, enforced by a
  // separate response contract, not by a UI choice.
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

/**
 * Permissions that additionally require the actor to be a registered medical
 * practitioner with a non-null `medical_registration_number`.
 *
 * Holding the DOCTOR role is necessary but not sufficient: a doctor account
 * created without a registration number cannot sign, because the registration
 * number is a legally required element of a valid Indian e-prescription and
 * would otherwise be printed blank.
 */
export const REQUIRES_MEDICAL_REGISTRATION: ReadonlySet<Permission> = new Set<Permission>([
  'encounter:finalize',
  'prescription:sign',
]);
