/**
 * Enumerations, mirrored verbatim from the Drizzle schema
 * (`packages/db/src/schema/shared.ts`).
 *
 * Values match the corresponding FHIR R4 valueset by name, so the ABDM mapping
 * layer stays a rename rather than a translation. If you change a value here,
 * change it there in the same commit — these two files are a pair.
 */

import { z } from 'zod';

export const UserRole = z.enum([
  'OWNER_ADMIN',
  'DOCTOR',
  'RECEPTIONIST',
  'NURSE_ASSISTANT',
  /**
   * Dispenses against a finalised prescription and runs the medicine counter.
   *
   * NOT a prescriber and not a diagnostician: a pharmacist may read the
   * medication a doctor ordered and record what was handed over, and may never
   * alter the order. Where the two disagree, the mechanism is a clarification
   * back to the prescriber, which is a record rather than a phone call.
   */
  'PHARMACIST',
  /**
   * Analyses the clinic's own data without seeing whose it is.
   *
   * De-identified by construction: this role holds no `patient:read`, so there
   * is no endpoint it can call that returns a name, a phone number or an MRN.
   * Cohorts are described by age band and code, never by person.
   */
  'RESEARCH_ANALYST',
  'AUDITOR',
]);
export type UserRole = z.infer<typeof UserRole>;

export const Gender = z.enum(['MALE', 'FEMALE', 'OTHER', 'UNKNOWN']);
export type Gender = z.infer<typeof Gender>;

/**
 * SoW §6.3 status set. `ARRIVED` is what places a patient in the live queue —
 * a walk-in is created directly in this state rather than being booked first.
 */
export const AppointmentStatus = z.enum([
  'SCHEDULED',
  'CONFIRMED',
  'ARRIVED',
  'IN_PROGRESS',
  'FULFILLED',
  'CHECKED_OUT',
  'CANCELLED',
  'NOSHOW',
]);
export type AppointmentStatus = z.infer<typeof AppointmentStatus>;

export const EncounterStatus = z.enum([
  'PLANNED',
  'IN_PROGRESS',
  'FINISHED',
  'CANCELLED',
  'ENTERED_IN_ERROR',
]);
export type EncounterStatus = z.infer<typeof EncounterStatus>;

/**
 * Whether the patient was in the room.
 *
 * Gates two things that are law rather than preference: Schedule X drugs and
 * narcotics may not be prescribed in a teleconsultation at all, and a
 * teleconsultation prescription must carry a declaration an in-person one does
 * not.
 */
export const ConsultationMode = z.enum(['IN_PERSON', 'TELECONSULTATION']);
export type ConsultationMode = z.infer<typeof ConsultationMode>;

export const CONSULTATION_MODE_LABEL: Record<ConsultationMode, string> = {
  IN_PERSON: 'In person',
  TELECONSULTATION: 'Teleconsultation',
};

export const ConditionClinicalStatus = z.enum([
  'ACTIVE',
  'RECURRENCE',
  'RELAPSE',
  'INACTIVE',
  'REMISSION',
  'RESOLVED',
]);
export type ConditionClinicalStatus = z.infer<typeof ConditionClinicalStatus>;

export const AllergyCategory = z.enum(['MEDICATION', 'FOOD', 'ENVIRONMENT', 'BIOLOGIC']);
export type AllergyCategory = z.infer<typeof AllergyCategory>;

/**
 * Risk of a FUTURE reaction — distinct from `ReactionSeverity`, which describes
 * a reaction that already happened. Conflating the two is a known source of
 * prescribing error, so both are modelled.
 */
export const AllergyCriticality = z.enum(['LOW', 'HIGH', 'UNABLE_TO_ASSESS']);
export type AllergyCriticality = z.infer<typeof AllergyCriticality>;

export const ReactionSeverity = z.enum(['MILD', 'MODERATE', 'SEVERE']);
export type ReactionSeverity = z.infer<typeof ReactionSeverity>;

export const MedicationRequestStatus = z.enum([
  'DRAFT',
  'ACTIVE',
  'ON_HOLD',
  'STOPPED',
  'COMPLETED',
  'CANCELLED',
  'ENTERED_IN_ERROR',
]);
export type MedicationRequestStatus = z.infer<typeof MedicationRequestStatus>;

export const DocumentType = z.enum([
  'PRESCRIPTION',
  'LAB_REPORT',
  'IMAGING_REPORT',
  'DISCHARGE_SUMMARY',
  'REFERRAL_LETTER',
  'CONSENT_FORM',
  'INVOICE',
  'PATIENT_UPLOAD',
  'OTHER',
]);
export type DocumentType = z.infer<typeof DocumentType>;

/**
 * Patient uploads must reach CLEAN before they are viewable or shareable.
 * `PENDING` is the default rather than null — a nullable scan status fails open,
 * which is the one thing this control must not do.
 */
export const VirusScanStatus = z.enum(['PENDING', 'CLEAN', 'INFECTED']);
export type VirusScanStatus = z.infer<typeof VirusScanStatus>;

export const CommunicationChannel = z.enum(['WHATSAPP', 'SMS', 'EMAIL']);
export type CommunicationChannel = z.infer<typeof CommunicationChannel>;

export const CommunicationDirection = z.enum(['INBOUND', 'OUTBOUND']);
export type CommunicationDirection = z.infer<typeof CommunicationDirection>;

export const CommunicationStatus = z.enum([
  'QUEUED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'RECEIVED',
]);
export type CommunicationStatus = z.infer<typeof CommunicationStatus>;

/** Free-form messages are permitted only inside the 24-hour service window. */
export const WhatsappMessageKind = z.enum(['TEMPLATE', 'SESSION']);
export type WhatsappMessageKind = z.infer<typeof WhatsappMessageKind>;

export const ConversationStatus = z.enum(['OPEN', 'WAITING', 'CLOSED']);
export type ConversationStatus = z.infer<typeof ConversationStatus>;

export const TaskStatus = z.enum([
  'REQUESTED',
  'ACCEPTED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskPriority = z.enum(['ROUTINE', 'URGENT', 'ASAP', 'STAT']);
export type TaskPriority = z.infer<typeof TaskPriority>;

/**
 * DPDP requires purpose-specific, independently withdrawable consent — hence a
 * discrete row per purpose, never a bundled "I agree to everything" flag.
 */
export const ConsentScope = z.enum([
  'TREATMENT',
  'DATA_PROCESSING',
  'WHATSAPP_COMMUNICATION',
  'MARKETING_COMMUNICATION',
  'DATA_SHARING_THIRD_PARTY',
  'ABDM_LINKAGE',
]);
export type ConsentScope = z.infer<typeof ConsentScope>;

export const ConsentStatus = z.enum(['DRAFT', 'ACTIVE', 'INACTIVE', 'REJECTED']);
export type ConsentStatus = z.infer<typeof ConsentStatus>;

export const InvoiceStatus = z.enum(['DRAFT', 'ISSUED', 'BALANCED', 'CANCELLED']);
export type InvoiceStatus = z.infer<typeof InvoiceStatus>;

export const PaymentMethod = z.enum([
  'CASH',
  'UPI',
  'CARD',
  'NETBANKING',
  'CHEQUE',
  'OTHER',
]);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

export const AuditOutcome = z.enum([
  'SUCCESS',
  'MINOR_FAILURE',
  'SERIOUS_FAILURE',
  'MAJOR_FAILURE',
]);
export type AuditOutcome = z.infer<typeof AuditOutcome>;

/** Human labels. Enum values are wire format; these are what people read. */
export const ROLE_LABEL: Record<UserRole, string> = {
  OWNER_ADMIN: 'Clinic Admin',
  DOCTOR: 'Doctor',
  RECEPTIONIST: 'Receptionist',
  NURSE_ASSISTANT: 'Nurse',
  PHARMACIST: 'Pharmacist',
  // "Analyst", not "Research Analyst". The person doing this at a five-doctor
  // clinic is the practice manager on a Friday afternoon, and nobody wants a
  // job title they have to live up to printed in the corner of the screen.
  RESEARCH_ANALYST: 'Analyst',
  AUDITOR: 'Auditor',
};

export const APPOINTMENT_STATUS_LABEL: Record<AppointmentStatus, string> = {
  SCHEDULED: 'Scheduled',
  CONFIRMED: 'Confirmed',
  ARRIVED: 'Waiting',
  IN_PROGRESS: 'In consultation',
  FULFILLED: 'Consultation done',
  CHECKED_OUT: 'Checked out',
  CANCELLED: 'Cancelled',
  NOSHOW: 'No-show',
};

export const CONSENT_SCOPE_LABEL: Record<ConsentScope, string> = {
  TREATMENT: 'Treatment',
  DATA_PROCESSING: 'Data processing',
  WHATSAPP_COMMUNICATION: 'WhatsApp messages',
  MARKETING_COMMUNICATION: 'Marketing',
  DATA_SHARING_THIRD_PARTY: 'Sharing with third parties',
  ABDM_LINKAGE: 'National health record linkage',
};

export const TASK_TYPE_LABEL: Record<string, string> = {
  DELIVERY_FAILED: 'Message not delivered',
  DUPLICATE_REVIEW: 'Possible duplicate',
  FOLLOW_UP_CALL: 'Follow-up call',
  REPORT_REVIEW: 'Report awaiting review',
};
