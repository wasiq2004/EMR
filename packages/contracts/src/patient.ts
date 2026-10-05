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

    /**
     * One value per registration attempt, held across retries.
     *
     * A BODY FIELD, not a header. The web client has always passed an
     * `Idempotency-Key` header here and nothing on the server read it, so the
     * protection existed only as an option name in `api-client.ts`. Optional
     * rather than required: unlike a payment or a stock receipt, registering the
     * same patient twice is a mess somebody can merge rather than money that
     * moved — so an integration without a key is served rather than refused.
     */
    idempotencyKey: z.string().min(8).max(200).nullish(),
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
  // An edit is not a registration. Carrying the key over would collide with the
  // one that created the record.
  idempotencyKey: true,
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

/**
 * Recording that a patient consented.
 *
 * WHY THIS EXISTS AT ALL, stated plainly: it did not, until now. The schema, the
 * read endpoint and the screen were all there, and consent could be displayed —
 * but nothing in the product could write one. The only consents in any database
 * were the ones the verification fixtures inserted with raw SQL. A clinic
 * running this could not record a consent, which matters beyond tidiness: the
 * WhatsApp send path refuses a patient with no `WHATSAPP_COMMUNICATION` consent,
 * so reminders and broadcasts were gated on a thing the product offered no way
 * to obtain.
 *
 * EVERY FIELD HERE IS A DPDP REQUIREMENT, not bookkeeping. The Act requires that
 * a data principal was shown a specific notice, in a language they chose, and
 * that the manner of capture is recorded — which is why none of these have
 * convenient defaults that would let a clinic record a consent nobody actually
 * gave.
 */
export const RecordConsent = z.object({
  scope: ConsentScope,
  /**
   * Which version of the notice the patient was shown.
   *
   * Required, because "they consented" is not a defensible record without it: a
   * consent given against last year's notice does not cover a purpose added
   * since, and without the version nobody can tell which notice applied.
   */
  policyVersion: z.string().trim().min(1, 'Which version of the notice did they see?'),
  captureMethod: z.enum(['IN_PERSON_SIGNED', 'VERBAL_RECORDED', 'DIGITAL_OTP']),
  /**
   * The language the notice was presented in.
   *
   * DPDP gives the data principal the choice of language, so recording English
   * by default for a patient who was read the notice in Tamil would make the
   * record untrue in exactly the way the provision exists to prevent.
   */
  presentedLanguage: z.string().trim().min(2).default('en'),
  /** Null is open-ended. ABDM linkage consents are always time-bounded. */
  expiresAt: IsoDateTime.nullish(),
  /** Object key of a signed paper form, where one was captured. */
  evidenceObjectKey: z.string().trim().nullish(),
});
export type RecordConsent = z.infer<typeof RecordConsent>;

/**
 * Withdrawing a consent.
 *
 * A WITHDRAWAL IS NOT A DELETE. The row stays and gains `withdrawn_at`, because
 * the clinic needs to be able to show both that consent was held and that it was
 * withdrawn — and because a message sent last week was lawfully sent. Erasing
 * the consent would make that send look unlawful in hindsight.
 *
 * It takes effect immediately everywhere, because every consumer checks at the
 * point of use rather than caching: the reminder runner checks consent at SEND
 * time precisely so that a withdrawal between scheduling and sending stops the
 * message.
 */
export const WithdrawConsent = z.object({
  /**
   * Optional, deliberately.
   *
   * Requiring a reason to withdraw consent would be a dark pattern: a patient
   * exercising a right under the Act should not have to justify it to a
   * receptionist before the system will accept it.
   */
  reason: z.string().trim().max(500).nullish(),
});
export type WithdrawConsent = z.infer<typeof WithdrawConsent>;
