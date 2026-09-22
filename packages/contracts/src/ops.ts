/**
 * Operational surfaces: clinic setup, staff, documents and sharing, tasks,
 * the audit trail, and data portability.
 */

import { z } from 'zod';
import { AuditFields, IsoDateTime, Paise, PhoneE164, Uuid } from './common';
import {
  AuditOutcome,
  DocumentType,
  TaskPriority,
  TaskStatus,
  UserRole,
  VirusScanStatus,
} from './enums';

/* ------------------------------------------------------------------------- *
 * Clinic and staff
 * ------------------------------------------------------------------------- */

export const Clinic = z.object({
  id: Uuid,
  name: z.string(),
  /** Also the login subdomain: {slug}.app.example.in */
  slug: z.string(),
  registrationNumber: z.string().nullable(),
  gstin: z.string().nullable(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  pincode: z.string().nullable(),
  contactPhoneE164: PhoneE164.nullable(),
  contactEmail: z.string().email().nullable(),
  /** Drives reminder scheduling and quiet hours. */
  timezone: z.string(),
  logoObjectKey: z.string().nullable(),
  isActive: z.boolean(),
}).extend(AuditFields.shape);
export type Clinic = z.infer<typeof Clinic>;

export const ClinicLocation = z.object({
  id: Uuid,
  name: z.string(),
  addressLine1: z.string().nullable(),
  city: z.string().nullable(),
  isPrimary: z.boolean(),
  isActive: z.boolean(),
});
export type ClinicLocation = z.infer<typeof ClinicLocation>;

export const StaffUser = z.object({
  id: Uuid,
  fullName: z.string(),
  email: z.string().email(),
  mobileE164: PhoneE164.nullable(),
  role: UserRole,
  /**
   * Required before this user can sign a prescription — it is a legal element
   * of a valid Indian e-prescription and would otherwise print blank.
   */
  medicalRegistrationNumber: z.string().nullable(),
  medicalCouncil: z.string().nullable(),
  qualifications: z.string().nullable(),
  specialty: z.string().nullable(),
  /** Mandatory for Clinic Admin and Doctor. */
  mfaEnabled: z.boolean(),
  isActive: z.boolean(),
  lastLoginAt: IsoDateTime.nullable(),
}).extend(AuditFields.shape);
export type StaffUser = z.infer<typeof StaffUser>;

/**
 * A bookable doctor, as a picker needs one.
 *
 * Four fields, and that is the point. Reception has to choose which doctor an
 * appointment is with, and the walk-in dialog offers the same list — neither
 * needs the staff directory above, which carries email addresses, roles,
 * lockout state and last-sign-in times. Granting the front desk `user:read` to
 * make a dropdown work would hand over all of it, so `/practitioners` exists
 * and is gated on `appointment:read`: whoever can see the diary can see who the
 * appointments are with.
 *
 * `hasMedicalRegistration` travels so the interface can explain up front that a
 * doctor cannot sign, rather than failing at the last step.
 */
export const Practitioner = z.object({
  id: Uuid,
  fullName: z.string(),
  qualifications: z.string().nullable(),
  hasMedicalRegistration: z.boolean(),
});
export type Practitioner = z.infer<typeof Practitioner>;

export const InviteStaff = z.object({
  fullName: z.string().trim().min(2, 'Enter a name'),
  email: z.string().email('Enter a valid email'),
  role: UserRole,
  mobileE164: PhoneE164.nullable().default(null),
  medicalRegistrationNumber: z.string().nullable().default(null),
  medicalCouncil: z.string().nullable().default(null),
  qualifications: z.string().nullable().default(null),
  specialty: z.string().nullable().default(null),
});
export type InviteStaff = z.infer<typeof InviteStaff>;

/** The signed-in user, as returned by the session endpoint. */
export const Session = z.object({
  userId: Uuid,
  fullName: z.string(),
  email: z.string().email(),
  role: UserRole,
  clinicId: Uuid,
  clinicName: z.string(),
  clinicSlug: z.string(),
  /** Gates the signing action in the UI; the server checks it again. */
  hasMedicalRegistration: z.boolean(),
  mfaEnabled: z.boolean(),
  /** Days remaining before two-factor enrolment is enforced. */
  mfaGraceDaysRemaining: z.number().int().nullable(),
});
export type Session = z.infer<typeof Session>;

export const LoginInput = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password'),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const MfaInput = z.object({
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
export type MfaInput = z.infer<typeof MfaInput>;

/* ------------------------------------------------------------------------- *
 * Documents and sharing
 * ------------------------------------------------------------------------- */

export const ClinicalDocument = z.object({
  id: Uuid,
  patientId: Uuid,
  patientName: z.string(),
  encounterId: Uuid.nullable(),
  documentType: DocumentType,
  title: z.string(),
  description: z.string().nullable(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  /**
   * PENDING until scanned. A patient upload that is not CLEAN is not viewable
   * and not shareable — this control fails closed.
   */
  virusScanStatus: VirusScanStatus.nullable(),
  signedByName: z.string().nullable(),
  signedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type ClinicalDocument = z.infer<typeof ClinicalDocument>;

export const ShareLink = z.object({
  id: Uuid,
  documentId: Uuid,
  patientId: Uuid,
  expiresAt: IsoDateTime,
  maxAccessCount: z.number().int(),
  accessCount: z.number().int(),
  otpRequired: z.boolean(),
  otpChallengeHint: z.string().nullable(),
  revokedAt: IsoDateTime.nullable(),
  createdByName: z.string(),
  purpose: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type ShareLink = z.infer<typeof ShareLink>;

/**
 * OTP defaults to on for every document type except a prescription or invoice
 * the patient is already expecting. Defaulting to open and relying on staff to
 * tick a box is how clinical documents end up in forwarded chat threads.
 */
export const CreateShareLink = z.object({
  documentId: Uuid,
  ttlHours: z.number().int().min(1).max(168).default(72),
  maxAccessCount: z.number().int().min(1).max(100).default(10),
  requireOtp: z.boolean(),
  purpose: z.string().nullable().default(null),
});
export type CreateShareLink = z.infer<typeof CreateShareLink>;

export const OTP_EXEMPT_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  'PRESCRIPTION',
  'INVOICE',
]);

/* ------------------------------------------------------------------------- *
 * Tasks
 * ------------------------------------------------------------------------- */

/**
 * Several safety mechanisms in this system terminate in a human action that
 * must be tracked to completion — an undelivered prescription, a duplicate
 * awaiting review. An alert nobody is accountable for is an alert nobody
 * actions, which is why this is a first-class entity and not a toast.
 */
export const Task = z.object({
  id: Uuid,
  status: TaskStatus,
  priority: TaskPriority,
  taskType: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  patientId: Uuid.nullable(),
  patientName: z.string().nullable(),
  encounterId: Uuid.nullable(),
  focusResourceType: z.string().nullable(),
  focusResourceId: Uuid.nullable(),
  assignedToUserId: Uuid.nullable(),
  assignedToName: z.string().nullable(),
  assignedToRole: UserRole.nullable(),
  dueAt: IsoDateTime.nullable(),
  completedAt: IsoDateTime.nullable(),
  resolutionNotes: z.string().nullable(),
  createdAt: IsoDateTime,
});
export type Task = z.infer<typeof Task>;

export const ResolveTask = z.object({
  taskId: Uuid,
  status: TaskStatus,
  resolutionNotes: z.string().nullable().default(null),
});
export type ResolveTask = z.infer<typeof ResolveTask>;

/* ------------------------------------------------------------------------- *
 * Audit
 * ------------------------------------------------------------------------- */

export const AuditEvent = z.object({
  id: Uuid,
  occurredAt: IsoDateTime,
  actorUserId: Uuid.nullable(),
  actorName: z.string().nullable(),
  actorRole: z.string().nullable(),
  actorType: z.enum(['USER', 'SYSTEM', 'EXTERNAL']),
  action: z.string(),
  outcome: AuditOutcome,
  outcomeDescription: z.string().nullable(),
  resourceType: z.string().nullable(),
  resourceId: Uuid.nullable(),
  resourceLabel: z.string().nullable(),
  patientId: Uuid.nullable(),
  ipAddress: z.string().nullable(),
  requestId: z.string().nullable(),
  httpStatus: z.number().int().nullable(),
  /**
   * True when an administrator read a clinical record they did not author.
   * Highlighted distinctly, so a practice can show clinicians exactly when
   * management viewed a record.
   */
  isElevatedVisibility: z.boolean().default(false),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const AuditQuery = z.object({
  actorUserId: Uuid.nullable().default(null),
  action: z.string().nullable().default(null),
  resourceType: z.string().nullable().default(null),
  patientId: Uuid.nullable().default(null),
  outcome: AuditOutcome.nullable().default(null),
  from: IsoDateTime.nullable().default(null),
  to: IsoDateTime.nullable().default(null),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

/* ------------------------------------------------------------------------- *
 * Import and export
 * ------------------------------------------------------------------------- */

export const ImportStage = z.enum([
  'UPLOAD',
  'MAP',
  'VALIDATE',
  'DUPLICATES',
  'PREVIEW',
  'IMPORT',
  'REPORT',
]);
export type ImportStage = z.infer<typeof ImportStage>;

export const ImportRowError = z.object({
  rowNumber: z.number().int(),
  sourceData: z.record(z.string(), z.string()),
  errors: z.array(
    z.object({ field: z.string(), code: z.string(), message: z.string() }),
  ),
});
export type ImportRowError = z.infer<typeof ImportRowError>;

export const ImportJob = z.object({
  id: Uuid,
  entityType: z.literal('PATIENTS'),
  sourceFilename: z.string(),
  stage: ImportStage,
  status: z.enum([
    'PENDING',
    'VALIDATING',
    'AWAITING_CONFIRMATION',
    'COMMITTING',
    'COMPLETED',
    'FAILED',
  ]),
  columnMapping: z.record(z.string(), z.string()),
  totalRows: z.number().int(),
  validRows: z.number().int(),
  errorRows: z.number().int(),
  duplicateRows: z.number().int(),
  importedRows: z.number().int(),
  errors: z.array(ImportRowError).default([]),
  startedAt: IsoDateTime.nullable(),
  completedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type ImportJob = z.infer<typeof ImportJob>;

/** Every field a patient import can target, with the headers we auto-match. */
export const IMPORT_TARGET_FIELDS = [
  { field: 'fullName', label: 'Full name', required: true, aliases: ['name', 'patient_name', 'pname'] },
  { field: 'mobileE164', label: 'Mobile', required: false, aliases: ['mobile', 'phone', 'contact', 'mobile_no', 'cell'] },
  { field: 'dateOfBirth', label: 'Date of birth', required: false, aliases: ['dob', 'birth_date', 'birthdate'] },
  { field: 'ageYears', label: 'Age', required: false, aliases: ['age'] },
  { field: 'gender', label: 'Gender', required: false, aliases: ['sex'] },
  { field: 'mrn', label: 'Existing record number', required: false, aliases: ['patient_id', 'reg_no', 'uhid'] },
  { field: 'addressLine1', label: 'Address', required: false, aliases: ['address', 'addr'] },
  { field: 'city', label: 'City', required: false, aliases: ['town'] },
  { field: 'state', label: 'State', required: false, aliases: [] },
  { field: 'pincode', label: 'Pincode', required: false, aliases: ['pin', 'zip', 'postal_code'] },
  { field: 'abhaNumber', label: 'ABHA number', required: false, aliases: ['abha', 'health_id'] },
] as const;

export const ExportJob = z.object({
  id: Uuid,
  exportType: z.enum(['FULL_CLINIC', 'PATIENT_SUBSET', 'DATE_RANGE']),
  status: z.enum(['PENDING', 'BUILDING', 'COMPLETED', 'FAILED', 'EXPIRED']),
  resultSizeBytes: z.number().int().nullable(),
  resultSha256: z.string().nullable(),
  /** Bundles self-destruct: patient data must not accumulate in storage. */
  downloadExpiresAt: IsoDateTime.nullable(),
  includedDocumentCount: z.number().int().nullable(),
  requestedByName: z.string(),
  startedAt: IsoDateTime.nullable(),
  completedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type ExportJob = z.infer<typeof ExportJob>;

/* ------------------------------------------------------------------------- *
 * Reports
 * ------------------------------------------------------------------------- */

export const ReportSummary = z.object({
  rangeFrom: IsoDateTime,
  rangeTo: IsoDateTime,
  visits: z.number().int(),
  newPatients: z.number().int(),
  collectionsPaise: Paise,
  outstandingPaise: Paise,
  appointmentsBooked: z.number().int(),
  noShows: z.number().int(),
  series: z.array(
    z.object({
      date: z.string(),
      visits: z.number().int(),
      collectionsPaise: Paise,
    }),
  ),
  byPractitioner: z.array(
    z.object({
      practitionerId: Uuid,
      practitionerName: z.string(),
      visits: z.number().int(),
      collectionsPaise: Paise,
    }),
  ),
});
export type ReportSummary = z.infer<typeof ReportSummary>;
