/**
 * Operational surfaces: clinic setup, staff, documents and sharing, tasks,
 * the audit trail, and data portability.
 */

import { z } from 'zod';
import { AuditFields, IsoDate, IsoDateTime, Paise, PhoneE164, Uuid } from './common';
import {
  AuditOutcome,
  DocumentType,
  PaymentMethod,
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

/**
 * Saving a clinic location.
 *
 * Deliberately small: a location is a name and where it is. Street address and
 * phone belong to the clinic itself — putting them here too would give a clinic
 * two addresses that can disagree, and nothing downstream would know which to
 * print.
 */
export const SaveLocation = z.object({
  id: Uuid.optional(),
  name: z.string().trim().min(2, 'Name the location as staff refer to it'),
  city: z.string().trim().nullish(),
  state: z.string().trim().nullish(),
  pincode: z
    .string()
    .trim()
    .regex(/^[1-9][0-9]{5}$/, 'An Indian PIN code is six digits')
    .nullish(),
  /** Exactly one is primary; promoting one demotes the others server-side. */
  isPrimary: z.boolean().default(false),
  isActive: z.boolean().default(true),
});
export type SaveLocation = z.infer<typeof SaveLocation>;

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
  /**
   * The practitioner's own registration number and council, for the signature
   * block on a printed prescription.
   *
   * It has to travel, because a prescription bearing a registration number that
   * is not the signing doctor's is a forged medical document — and the number
   * was previously hardcoded in the print view, so every doctor in every clinic
   * printed the same one.
   *
   * Null for everyone who cannot sign, which is most roles.
   */
  medicalRegistrationNumber: z.string().nullable(),
  medicalCouncil: z.string().nullable(),
  qualifications: z.string().nullable(),
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

/**
 * Changing your own password.
 *
 * THE CURRENT PASSWORD IS REQUIRED, and not as a formality. Without it, anyone
 * who gets hold of a signed-in session — a shared reception terminal left
 * unlocked, a borrowed laptop — converts temporary access into permanent
 * ownership of a clinician's account, which is the account that signs
 * prescriptions. Re-entering it is the only thing standing between those two.
 *
 * TWELVE CHARACTERS, matching what the screen has always promised. Deliberately
 * no composition rules — no "one uppercase, one symbol" — because they push
 * people toward `Password1!` and then toward writing it on the monitor. Length
 * is the property that actually helps, and a short memorable phrase beats a
 * mangled word.
 */
export const ChangePasswordInput = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: z
      .string()
      .min(12, 'Use at least 12 characters')
      // Argon2 has no practical input limit, but an unbounded field is a way to
      // make the server spend CPU hashing megabytes.
      .max(200, 'That is longer than 200 characters'),
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    message: 'The new password is the same as the current one',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.infer<typeof ChangePasswordInput>;

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

/**
 * The ceiling on one import.
 *
 * Not a performance guess. Validation and the commit both run inside a single
 * request, and a batch has to either land whole or not at all — so the limit is
 * the number of rows that can be validated and inserted in one transaction
 * without holding it open long enough to matter. A clinic with more than fifty
 * thousand patients splits the file, which is tedious but honest; the
 * alternative is a half-imported registry, which is the one outcome this whole
 * module exists to prevent.
 */
export const IMPORT_MAX_ROWS = 50_000;

/**
 * What the file's columns mean.
 *
 * Keyed by the heading as it appears in the clinic's own file, pointing at a
 * field in `IMPORT_TARGET_FIELDS`. An empty value means "do not import this
 * column", which is a real answer rather than a missing one — old systems carry
 * columns nobody has needed for years.
 */
export const ImportColumnMapping = z.record(z.string(), z.string());
export type ImportColumnMapping = z.infer<typeof ImportColumnMapping>;

export const ValidateImport = z.object({
  columnMapping: ImportColumnMapping,
});
export type ValidateImport = z.infer<typeof ValidateImport>;

/** One row that will not be imported, and why, in the clinic's own terms. */
export const ImportRowProblem = z.object({
  /** 1-based, counting the heading as row 1 — what a spreadsheet shows. */
  rowNumber: z.number().int().positive(),
  /** The name on the row, so it can be found in the file without the number. */
  label: z.string(),
  field: z.string().nullable(),
  message: z.string(),
  kind: z.enum(['INVALID', 'DUPLICATE_IN_FILE', 'ALREADY_REGISTERED']),
});
export type ImportRowProblem = z.infer<typeof ImportRowProblem>;

export const ImportJobRow = z.object({
  id: Uuid,
  entityType: z.string(),
  sourceFilename: z.string(),
  status: z.enum([
    'AWAITING_MAPPING',
    'AWAITING_CONFIRMATION',
    'COMMITTING',
    'COMPLETED',
    'FAILED',
  ]),
  totalRows: z.number().int(),
  validRows: z.number().int(),
  errorRows: z.number().int(),
  duplicateRows: z.number().int(),
  importedRows: z.number().int(),
  columnMapping: ImportColumnMapping,
  /** The headings found in the file, in the order they appear. */
  columns: z.array(z.string()),
  requestedByName: z.string().nullable(),
  startedAt: IsoDateTime.nullable(),
  completedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type ImportJobRow = z.infer<typeof ImportJobRow>;

/** What the upload step hands back: the real headings and the first few rows. */
export const ImportUploadResult = z.object({
  job: ImportJobRow,
  /** Suggested mapping, from the headings. Always shown for confirmation. */
  suggestedMapping: ImportColumnMapping,
  /** The first few rows as they were read, so the mapping can be checked. */
  sampleRows: z.array(z.record(z.string(), z.string())),
  /**
   * Set when the file was not valid UTF-8 and had to be decoded as Windows-1252.
   * Surfaced rather than silently handled: it is the usual sign of an export
   * from an old desktop system, and names are where it shows.
   */
  decodedAs: z.enum(['utf-8', 'windows-1252']),
});
export type ImportUploadResult = z.infer<typeof ImportUploadResult>;

export const ImportValidationResult = z.object({
  job: ImportJobRow,
  /** Capped for display. The downloadable report has every one. */
  problems: z.array(ImportRowProblem),
  problemsTruncated: z.boolean(),
});
export type ImportValidationResult = z.infer<typeof ImportValidationResult>;

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

/* ------------------------------------------------------------------------- *
 * Clinic analytics — the administrator's view of the practice
 * ------------------------------------------------------------------------- */

/**
 * WHY THIS IS SEPARATE FROM `ReportSummary`.
 *
 * `ReportSummary` is the dashboard: a fixed trailing window, six numbers and a
 * sparkline, and it answers "how is this week going". This answers "where did
 * the money come from last quarter, and which doctor is full" — a filtered
 * question with a date range, and the two have different shapes for a reason.
 * Bolting filters onto the dashboard would make every screen pay for the
 * grouping nobody on it asked for.
 *
 * It is also governed differently. The dashboard is aggregate-only so an AUDITOR
 * may read it; this needs `report:read` as well and carries the same property —
 * no figure below can be traced to one patient. Per-doctor and per-service
 * breakdowns are about the clinic's own staff and price list, not about people.
 */

export const AnalyticsFilters = z.object({
  /** Inclusive. */
  from: IsoDate,
  /** EXCLUSIVE, matching the calendar and the availability endpoints. */
  to: IsoDate,
  practitionerId: Uuid.nullish(),
  locationId: Uuid.nullish(),
  serviceItemId: Uuid.nullish(),
  paymentMethod: PaymentMethod.nullish(),
});
export type AnalyticsFilters = z.infer<typeof AnalyticsFilters>;

/** One row of a grouped total. */
export const AnalyticsBreakdown = z.object({
  /** Null where the dimension is genuinely absent — "no doctor assigned". */
  id: Uuid.nullable(),
  label: z.string(),
  count: z.number().int(),
  amountPaise: Paise,
});
export type AnalyticsBreakdown = z.infer<typeof AnalyticsBreakdown>;

/**
 * Money.
 *
 * COLLECTED AND INVOICED ARE DIFFERENT NUMBERS and both are given, because
 * showing one and calling it "revenue" is how a clinic ends up budgeting against
 * money it has not received. Collected is what arrived in the range; invoiced is
 * what was billed in it; outstanding is what is owed *now* and is deliberately
 * not range-filtered — a debt from March is still a debt in June, and scoping it
 * to the range would make it shrink as the window moved.
 */
export const RevenueAnalytics = z.object({
  collectedPaise: Paise,
  invoicedPaise: Paise,
  /** Owed as of now, across all time. Not filtered by the range — see above. */
  outstandingPaise: Paise,
  refundedPaise: Paise,
  byMethod: z.array(AnalyticsBreakdown),
  byPractitioner: z.array(AnalyticsBreakdown),
  byService: z.array(AnalyticsBreakdown),
  /** Collections per day, for the chart. */
  series: z.array(z.object({ date: IsoDate, collectedPaise: Paise })),
});
export type RevenueAnalytics = z.infer<typeof RevenueAnalytics>;

/**
 * Patients.
 *
 * NEW IS BY REGISTRATION DATE, returning is "registered before the range and
 * seen within it". A patient registered and seen in the same range counts as
 * new, not both — otherwise the two add up to more than the number of people
 * who came.
 */
export const PatientAnalytics = z.object({
  newCount: z.number().int(),
  returningCount: z.number().int(),
  /** Everybody seen in the range, which is `newCount + returningCount`. */
  seenCount: z.number().int(),
  registrations: z.array(z.object({ date: IsoDate, count: z.number().int() })),
});
export type PatientAnalytics = z.infer<typeof PatientAnalytics>;

/**
 * Appointments.
 *
 * The percentages have explicit denominators, because the obvious ones are
 * wrong. A no-show rate over *all* appointments counts tomorrow's bookings as
 * attended; over *closed* ones it counts a cancellation as a kept appointment.
 * So both rates are over appointments that reached a terminal state, and
 * `closedCount` is reported so the reader can see what they are a share of.
 */
export const AppointmentAnalytics = z.object({
  bookedCount: z.number().int(),
  completedCount: z.number().int(),
  noShowCount: z.number().int(),
  cancelledCount: z.number().int(),
  walkInCount: z.number().int(),
  /** Completed + no-show + cancelled: the denominator for both rates below. */
  closedCount: z.number().int(),
  /** Null when nothing has closed yet — a rate over zero is not zero. */
  noShowPct: z.number().int().nullable(),
  cancellationPct: z.number().int().nullable(),
  /**
   * Booked minutes over offered minutes, from the practitioner schedules.
   *
   * Null when no schedules cover the range: a clinic that has not entered its
   * working hours has no denominator, and reporting 0% would read as "nobody
   * came" rather than "we do not know". Cancellations and no-shows are excluded
   * from the numerator — a doctor is not busy during an appointment nobody
   * attended.
   */
  utilisationPct: z.number().int().nullable(),
  offeredMinutes: z.number().int().nullable(),
  bookedMinutes: z.number().int(),
});
export type AppointmentAnalytics = z.infer<typeof AppointmentAnalytics>;

/**
 * Outstanding invoices by age.
 *
 * Aged from `issued_at`, not from the invoice date, because an invoice drafted in
 * March and issued in June has been owed since June. Buckets are the ones a
 * clinic chases on: this week, this month, and the two that need a phone call.
 */
export const InvoiceAgeing = z.object({
  buckets: z.array(
    z.object({
      label: z.string(),
      count: z.number().int(),
      amountPaise: Paise,
    }),
  ),
  totalPaise: Paise,
  /** The oldest unpaid invoice's age in days, or null if nothing is owed. */
  oldestDays: z.number().int().nullable(),
});
export type InvoiceAgeing = z.infer<typeof InvoiceAgeing>;

export const ClinicAnalytics = z.object({
  from: IsoDate,
  to: IsoDate,
  revenue: RevenueAnalytics,
  patients: PatientAnalytics,
  appointments: AppointmentAnalytics,
  ageing: InvoiceAgeing,
});
export type ClinicAnalytics = z.infer<typeof ClinicAnalytics>;

/** The views a CSV export can be taken of. */
export const ANALYTICS_EXPORTS = [
  { value: 'revenue-by-method', label: 'Revenue by payment method' },
  { value: 'revenue-by-doctor', label: 'Revenue by doctor' },
  { value: 'revenue-by-service', label: 'Revenue by service' },
  { value: 'collections-daily', label: 'Collections per day' },
  { value: 'registrations-daily', label: 'Registrations per day' },
  { value: 'invoice-ageing', label: 'Outstanding invoices by age' },
] as const;
export type AnalyticsExport = (typeof ANALYTICS_EXPORTS)[number]['value'];
