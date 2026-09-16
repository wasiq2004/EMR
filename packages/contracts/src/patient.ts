/**
 * Patient registry, duplicate detection and consent.
 *
 * Duplicate prevention (risk R4) is the dominant concern, and the Indian
 * context defeats the naive design: one mobile number routinely serves a whole
 * family, transliteration is unstable (Mohd / Mohammed / Muhammad), date of
 * birth is frequently unknown, and no identifier can be made mandatory.
 */

import { z } from 'zod';
import { AuditFields, IsoDate, IsoDateTime, PhoneE164, Uuid } from './common';
import { ConsentScope, ConsentStatus, Gender } from './enums';

export const Patient = z.object({
  id: Uuid,
  /** Spoken aloud at the desk, e.g. "MRN-000142". Unique within the clinic. */
  mrn: z.string(),
  fullName: z.string(),
  mobileE164: PhoneE164.nullable(),
  /** True when the number belongs to a relative. Suppresses direct WhatsApp. */
  mobileBelongsToRelative: z.boolean(),
  alternatePhoneE164: PhoneE164.nullable(),
  email: z.string().email().nullable(),
  gender: Gender,

  /** Exact date of birth when known. */
  dateOfBirth: IsoDate.nullable(),
  /**
   * Stated age, captured when the date of birth is unknown — which is most
   * walk-ins. Paired with `ageRecordedAt` so current age can be derived later;
   * storing a bare age would silently rot and corrupt paediatric dosing.
   */
  ageYears: z.number().int().min(0).max(130).nullable(),
  ageRecordedAt: IsoDate.nullable(),

  bloodGroup: z.string().nullable(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  pincode: z.string().nullable(),

  abhaNumber: z.string().nullable(),

  /** Free-text flag surfaced prominently on the Snapshot. */
  clinicalAlert: z.string().nullable(),

  emergencyContactName: z.string().nullable(),
  emergencyContactPhoneE164: PhoneE164.nullable(),
  emergencyContactRelation: z.string().nullable(),

  /** Clinic-defined labels, e.g. "Camp patient", "Corporate", "Insurance". */
  tags: z.array(z.string()),
  /** Staff notes on the record. Explicitly NOT clinical content. */
  notes: z.string().nullable(),

  isActive: z.boolean(),
  mergedIntoPatientId: Uuid.nullable(),
}).extend(AuditFields.shape);
export type Patient = z.infer<typeof Patient>;

/** The compact shape used in search results, pickers and queue rows. */
export const PatientSummary = Patient.pick({
  id: true,
  mrn: true,
  fullName: true,
  mobileE164: true,
  gender: true,
  dateOfBirth: true,
  ageYears: true,
  ageRecordedAt: true,
  tags: true,
}).extend({
  lastVisitAt: IsoDateTime.nullable(),
  /** Shown as a warning chip wherever the patient is listed. */
  hasHighCriticalityAllergy: z.boolean().default(false),
});
export type PatientSummary = z.infer<typeof PatientSummary>;

/* ------------------------------------------------------------------------- *
 * Registration
 * ------------------------------------------------------------------------- */

/**
 * Either a date of birth or a stated age is required, never neither. Refusing
 * to register a patient whose exact birthday is unknown is not an option in
 * this market.
 */
const RegisterPatientBase = z
  .object({
    fullName: z.string().trim().min(2, 'Enter the patient name'),
    mobileE164: PhoneE164.nullable(),
    mobileBelongsToRelative: z.boolean().default(false),
    gender: Gender,
    dateOfBirth: IsoDate.nullable().default(null),
    ageYears: z.number().int().min(0).max(130).nullable().default(null),
    email: z.string().email().nullable().default(null),
    addressLine1: z.string().nullable().default(null),
    city: z.string().nullable().default(null),
    state: z.string().nullable().default(null),
    pincode: z.string().regex(/^\d{6}$/, 'A pincode is 6 digits').nullable().default(null),
    bloodGroup: z.string().nullable().default(null),
    emergencyContactName: z.string().nullable().default(null),
    emergencyContactPhoneE164: PhoneE164.nullable().default(null),
    emergencyContactRelation: z.string().nullable().default(null),
    tags: z.array(z.string()).default([]),
    notes: z.string().nullable().default(null),

    /**
     * Proof that a duplicate search ran before this form opened. The server
     * rejects a registration without it — search-before-create is enforced by
     * the workflow, not left to discipline.
     */
    searchToken: z.string().min(1),
    /** Required when the receptionist dismisses a likely-duplicate warning. */
    duplicateOverrideReason: z.string().nullable().default(null),
  });

/** Age or date of birth — one of the two, never neither. */
const hasAgeOrDob = (v: { dateOfBirth: string | null; ageYears: number | null }) =>
  v.dateOfBirth !== null || v.ageYears !== null;

const AGE_REQUIRED = {
  message: 'Enter either a date of birth or an approximate age',
  path: ['ageYears'],
};

export const RegisterPatient = RegisterPatientBase.refine(hasAgeOrDob, AGE_REQUIRED);
export type RegisterPatient = z.infer<typeof RegisterPatient>;

export const UpdatePatient = RegisterPatientBase.omit({
  searchToken: true,
  duplicateOverrideReason: true,
})
  .partial()
  .extend({ version: z.number().int().min(1) });
export type UpdatePatient = z.infer<typeof UpdatePatient>;

/* ------------------------------------------------------------------------- *
 * Duplicate detection
 * ------------------------------------------------------------------------- */

export const DuplicateMatchReason = z.enum([
  'SAME_MOBILE',
  'SIMILAR_NAME',
  'SAME_NAME_AND_DOB',
  'SAME_ABHA',
]);

export const DuplicateCandidate = z.object({
  patient: PatientSummary,
  reasons: z.array(DuplicateMatchReason),
  /** 0–1 trigram similarity on the normalised name. */
  nameSimilarity: z.number().min(0).max(1).nullable(),
});
export type DuplicateCandidate = z.infer<typeof DuplicateCandidate>;

export const DuplicateCheckResult = z.object({
  /** Passed to the registration form to prove a search happened. */
  searchToken: z.string(),
  /**
   * Everyone already registered on this number. A family sharing one handset is
   * routine, so this is shown as a picker rather than treated as an error.
   */
  onSameMobile: z.array(PatientSummary),
  /** Fuzzy matches across other numbers. */
  similar: z.array(DuplicateCandidate),
});
export type DuplicateCheckResult = z.infer<typeof DuplicateCheckResult>;

export const MergePatients = z.object({
  survivingPatientId: Uuid,
  mergedPatientId: Uuid,
  reason: z.string().trim().min(4, 'Record why these are the same person'),
});
export type MergePatients = z.infer<typeof MergePatients>;

/* ------------------------------------------------------------------------- *
 * Consent
 * ------------------------------------------------------------------------- */

export const Consent = z.object({
  id: Uuid,
  patientId: Uuid,
  scope: ConsentScope,
  status: ConsentStatus,
  /** Version of the notice text the patient was shown. Required by DPDP. */
  policyVersion: z.string(),
  captureMethod: z.enum(['IN_PERSON_SIGNED', 'VERBAL_RECORDED', 'DIGITAL_OTP']),
  presentedLanguage: z.string(),
  grantedAt: IsoDateTime,
  expiresAt: IsoDateTime.nullable(),
  withdrawnAt: IsoDateTime.nullable(),
  withdrawnReason: z.string().nullable(),
});
export type Consent = z.infer<typeof Consent>;
