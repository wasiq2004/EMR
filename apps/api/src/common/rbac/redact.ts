import { can, type UserRole } from '@emr/contracts';

/**
 * Field-level redaction for records that are readable in outline by more roles
 * than may read their contents.
 *
 * WHY THIS FILE EXISTS. `RequirePermission` guards a ROUTE. That is the right
 * granularity almost everywhere, and it was the wrong granularity in exactly
 * two places:
 *
 *   GET /encounters/:id      guarded on `encounter:read`, which reception and
 *                            the pharmacy counter both hold — and it returned
 *                            `select()`, every column, the whole SOAP note
 *                            included. The handler was even commented
 *                            "Metadata only. Reception can see that a visit
 *                            happened, not what was said." The comment was
 *                            the intent; the query was the behaviour.
 *
 *   GET /patients/:id/snapshot
 *                            guarded on `patient:read` alone, and it bundles
 *                            allergies, diagnoses, active medications and
 *                            vitals into one payload. A single permission was
 *                            therefore standing in for five, and the four it
 *                            was covering for are the ones `rbac.ts` lists as
 *                            DELIBERATELY ABSENT from those roles.
 *
 * So the permission matrix said one thing and two endpoints did another. These
 * functions make the payload follow the matrix rather than the route.
 *
 * They are pure and take the role explicitly — no request context, no database
 * — because the interesting assertion is "a pharmacist cannot see a diagnosis",
 * and that should be testable without booting anything.
 */

/**
 * The clinical narrative on an encounter: what the clinician wrote, as opposed
 * to the fact that a consultation took place.
 *
 * `followUpInstructions` is in here because it is advice given to a patient,
 * and `amendmentReason` because a reason for correcting a note routinely quotes
 * the note. `followUpAfterDays` is NOT: "come back in 7 days" is scheduling
 * information, the front desk needs it to book the return visit, and a bare
 * interval discloses nothing about the condition.
 */
export const CLINICAL_NARRATIVE_FIELDS = [
  'chiefComplaint',
  'historyOfPresentIllness',
  'examinationNotes',
  'assessmentNotes',
  'planNotes',
  'followUpInstructions',
  'amendmentReason',
] as const;

export type ClinicalNarrativeField = (typeof CLINICAL_NARRATIVE_FIELDS)[number];

/** Whether this role may read what was written in a consultation. */
export function mayReadClinicalContent(role: UserRole): boolean {
  return can(role, 'encounterClinicalContent:read');
}

/**
 * Blanks the narrative on an encounter for a role that may see the visit but
 * not its contents. Everything else — who, when, with whom, finalised or not —
 * is untouched, because that is what reception and the counter legitimately
 * need.
 *
 * Returns the row UNCHANGED, same object, when the role may read content. The
 * doctor's own consultation screen goes through this function on every load and
 * must not pay for it.
 */
export function redactEncounter<T extends object>(row: T, role: UserRole): T {
  if (mayReadClinicalContent(role)) return row;

  const redacted = { ...row } as Record<string, unknown>;
  for (const field of CLINICAL_NARRATIVE_FIELDS) {
    // Only blank what the row actually carries. Inventing `planNotes: null` on
    // a projection that never selected it would turn "not asked for" into
    // "empty", and a caller cannot tell those apart.
    //
    // `T extends object` rather than a Partial of the narrative fields: a
    // projection that selects none of them is a legitimate argument, and the
    // narrower constraint rejected it outright under TypeScript's weak-type
    // check — an object with no properties in common.
    if (field in redacted) redacted[field] = null;
  }
  return redacted as T;
}

/** The shape `snapshot()` returns, as far as redaction is concerned. */
interface RedactableSnapshot {
  allergies?: unknown[];
  conditions?: unknown[];
  activeMedications?: unknown[];
  latestVitals?: unknown[];
  recentEncounters?: Array<{ chiefComplaint?: unknown; diagnoses?: unknown[] }>;
}

/**
 * Applies each section of the patient snapshot to its own permission.
 *
 * An EMPTY ARRAY, not a missing key or an error. The snapshot is a sidebar: a
 * role that cannot read diagnoses should see no diagnoses section, not a failed
 * request that takes the allergy list down with it. Allergies in particular
 * must survive every other redaction — the pharmacy counter holds
 * `allergy:read` precisely so that handing penicillin to a penicillin-allergic
 * patient stays a thing the software can prevent.
 */
export function redactSnapshot<T extends RedactableSnapshot>(snapshot: T, role: UserRole): T {
  const out = { ...snapshot };

  if (!can(role, 'allergy:read')) out.allergies = [];
  if (!can(role, 'condition:read')) out.conditions = [];
  if (!can(role, 'prescription:read')) out.activeMedications = [];
  if (!can(role, 'observation:read')) out.latestVitals = [];

  const mayReadDiagnoses = can(role, 'condition:read');
  const mayReadNarrative = mayReadClinicalContent(role);

  if (out.recentEncounters && (!mayReadDiagnoses || !mayReadNarrative)) {
    out.recentEncounters = out.recentEncounters.map((visit) => ({
      ...visit,
      ...(mayReadNarrative ? {} : { chiefComplaint: null }),
      ...(mayReadDiagnoses ? {} : { diagnoses: [] }),
    }));
  }

  return out;
}
