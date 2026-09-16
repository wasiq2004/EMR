/**
 * The clinical record: encounter, vitals, diagnoses, allergies, prescribing,
 * and the Patient Snapshot read model.
 *
 * Two rules run through all of it:
 *   - Coded OR free text, never coded-only. Doctors in this segment will not
 *     code every diagnosis, and refusing to save an uncoded one is the fastest
 *     available way to lose adoption.
 *   - Corrections append. A finalised encounter is immutable; a correction is a
 *     new record linked to the original.
 */

import { z } from 'zod';
import { AuditFields, IsoDateTime, Uuid } from './common';
import {
  AllergyCategory,
  AllergyCriticality,
  ConditionClinicalStatus,
  EncounterStatus,
  MedicationRequestStatus,
  ReactionSeverity,
} from './enums';

/* ------------------------------------------------------------------------- *
 * Observation — vitals
 * ------------------------------------------------------------------------- */

export const Observation = z.object({
  id: Uuid,
  patientId: Uuid,
  encounterId: Uuid.nullable(),
  /** LOINC, e.g. "8480-6" systolic BP, "29463-7" body weight. */
  code: z.string(),
  display: z.string(),
  valueNumeric: z.number().nullable(),
  /** UCUM, e.g. "mm[Hg]", "kg", "Cel". */
  valueUnit: z.string().nullable(),
  valueText: z.string().nullable(),
  referenceLow: z.number().nullable(),
  referenceHigh: z.number().nullable(),
  /** Computed at write time and surfaced on the Snapshot. */
  interpretation: z.enum(['NORMAL', 'LOW', 'HIGH', 'CRITICAL']).nullable(),
  /** When the measurement was TAKEN, which may precede when it was entered. */
  effectiveAt: IsoDateTime,
  recordedBy: Uuid,
});
export type Observation = z.infer<typeof Observation>;

/** The vitals a general template prompts for. Order is the entry order. */
export const VITAL_CODES = [
  { code: '8480-6', display: 'Systolic BP', unit: 'mm[Hg]', low: 90, high: 140 },
  { code: '8462-4', display: 'Diastolic BP', unit: 'mm[Hg]', low: 60, high: 90 },
  { code: '8867-4', display: 'Pulse', unit: '/min', low: 60, high: 100 },
  { code: '8310-5', display: 'Temperature', unit: 'Cel', low: 36.1, high: 37.5 },
  { code: '9279-1', display: 'Respiratory rate', unit: '/min', low: 12, high: 20 },
  { code: '2708-6', display: 'SpO2', unit: '%', low: 95, high: 100 },
  { code: '29463-7', display: 'Weight', unit: 'kg', low: null, high: null },
  { code: '8302-2', display: 'Height', unit: 'cm', low: null, high: null },
] as const;

export const RecordObservation = z.object({
  patientId: Uuid,
  encounterId: Uuid.nullable(),
  code: z.string(),
  display: z.string(),
  valueNumeric: z.number().nullable(),
  valueUnit: z.string().nullable(),
  valueText: z.string().nullable(),
});
export type RecordObservation = z.infer<typeof RecordObservation>;

/* ------------------------------------------------------------------------- *
 * Condition — diagnoses
 * ------------------------------------------------------------------------- */

export const Condition = z.object({
  id: Uuid,
  patientId: Uuid,
  encounterId: Uuid.nullable(),
  clinicalStatus: ConditionClinicalStatus,
  /** ICD-10 or SNOMED. Nullable by design — see `displayText`. */
  code: z.string().nullable(),
  codeSystem: z.string().nullable(),
  /** The diagnosis as the doctor expressed it. Always present. */
  displayText: z.string(),
  /** Pinned to the top of the Snapshot. */
  isChronic: z.boolean(),
  onsetDate: IsoDateTime.nullable(),
  recordedAt: IsoDateTime,
  recordedBy: Uuid,
  notes: z.string().nullable(),
});
export type Condition = z.infer<typeof Condition>;

export const RecordCondition = z.object({
  patientId: Uuid,
  encounterId: Uuid.nullable(),
  displayText: z.string().trim().min(2, 'Enter the diagnosis'),
  code: z.string().nullable().default(null),
  codeSystem: z.string().nullable().default(null),
  isChronic: z.boolean().default(false),
  clinicalStatus: ConditionClinicalStatus.default('ACTIVE'),
  notes: z.string().nullable().default(null),
});
export type RecordCondition = z.infer<typeof RecordCondition>;

/* ------------------------------------------------------------------------- *
 * Allergy — safety critical
 * ------------------------------------------------------------------------- */

export const Allergy = z.object({
  id: Uuid,
  patientId: Uuid,
  category: AllergyCategory,
  /** Risk of a FUTURE reaction. Drives whether prescribing is blocked. */
  criticality: AllergyCriticality,
  /** Set when the allergy references a catalogue molecule — exact matching. */
  substanceMoleculeId: Uuid.nullable(),
  substanceText: z.string(),
  reactionDescription: z.string().nullable(),
  /** How bad a PAST reaction was. Distinct from criticality. */
  reactionSeverity: ReactionSeverity.nullable(),
  onsetDate: IsoDateTime.nullable(),
  /** A disproved allergy is marked, never deleted — it stays clinically relevant. */
  refutedAt: IsoDateTime.nullable(),
  recordedAt: IsoDateTime,
  recordedBy: Uuid,
});
export type Allergy = z.infer<typeof Allergy>;

export const RecordAllergy = z.object({
  patientId: Uuid,
  category: AllergyCategory,
  criticality: AllergyCriticality,
  substanceText: z.string().trim().min(2, 'Name the substance'),
  substanceMoleculeId: Uuid.nullable().default(null),
  reactionDescription: z.string().nullable().default(null),
  reactionSeverity: ReactionSeverity.nullable().default(null),
});
export type RecordAllergy = z.infer<typeof RecordAllergy>;

/* ------------------------------------------------------------------------- *
 * Drug catalogue and prescribing
 * ------------------------------------------------------------------------- */

export const DrugCatalogueItem = z.object({
  id: Uuid,
  brandName: z.string().nullable(),
  moleculeName: z.string(),
  strength: z.string().nullable(),
  dosageForm: z.string().nullable(),
  route: z.string().nullable(),
  manufacturer: z.string().nullable(),
  /** H / H1 / X. Schedule X may not be prescribed via telemedicine. */
  drugSchedule: z.string().nullable(),
  isNarcotic: z.boolean(),
  catalogueVersion: z.string(),
  /** Learned from this clinic's prescribing history; ranked first in search. */
  isFavourite: z.boolean().default(false),
});
export type DrugCatalogueItem = z.infer<typeof DrugCatalogueItem>;

/**
 * A warning shown at the moment of prescribing, and what the clinician did
 * about it. Persisted on the prescription: the clinic's evidence of safe
 * practice, and the product's evidence of having warned.
 */
export const SafetyWarning = z.object({
  kind: z.enum([
    'ALLERGY_EXACT',
    'ALLERGY_CLASS',
    'DUPLICATE_THERAPY',
    'SCHEDULE_X_TELEMEDICINE',
  ]),
  /** BLOCKING requires acknowledgement; ADVISORY can be dismissed inline. */
  severity: z.enum(['BLOCKING', 'ADVISORY']),
  /** Legal restrictions cannot be overridden at all. */
  overridable: z.boolean(),
  title: z.string(),
  detail: z.string(),
  substanceText: z.string().nullable(),
  criticality: AllergyCriticality.nullable(),
  recordedAt: IsoDateTime.nullable(),
});
export type SafetyWarning = z.infer<typeof SafetyWarning>;

export const MedicationRequest = z.object({
  id: Uuid,
  patientId: Uuid,
  encounterId: Uuid,
  practitionerId: Uuid,
  status: MedicationRequestStatus,
  /** Null when prescribed as free text, which must always remain possible. */
  catalogueItemId: Uuid.nullable(),
  /** Denormalised so the record survives catalogue changes. */
  drugDisplayName: z.string(),
  moleculeName: z.string().nullable(),
  strength: z.string().nullable(),
  dosageForm: z.string().nullable(),
  route: z.string().nullable(),
  /** The Indian convention: morning-noon-night, e.g. "1-0-1". */
  frequency: z.string(),
  timingRelativeToFood: z.enum(['BEFORE_FOOD', 'AFTER_FOOD', 'WITH_FOOD']).nullable(),
  durationDays: z.number().int().positive().nullable(),
  quantity: z.number().nullable(),
  instructions: z.string().nullable(),
  safetyWarningsShown: z.array(SafetyWarning),
  safetyOverrideReason: z.string().nullable(),
  catalogueVersionAtPrescribing: z.string().nullable(),
  authoredAt: IsoDateTime,
});
export type MedicationRequest = z.infer<typeof MedicationRequest>;

export const PrescriptionLine = z.object({
  catalogueItemId: Uuid.nullable().default(null),
  drugDisplayName: z.string().trim().min(2, 'Choose or type a medicine'),
  moleculeName: z.string().nullable().default(null),
  strength: z.string().nullable().default(null),
  dosageForm: z.string().nullable().default(null),
  route: z.string().nullable().default(null),
  frequency: z.string().trim().min(1, 'Enter a dosage, e.g. 1-0-1'),
  timingRelativeToFood: z
    .enum(['BEFORE_FOOD', 'AFTER_FOOD', 'WITH_FOOD'])
    .nullable()
    .default(null),
  durationDays: z.number().int().positive().nullable().default(null),
  quantity: z.number().nullable().default(null),
  instructions: z.string().nullable().default(null),
  safetyWarningsShown: z.array(SafetyWarning).default([]),
  /** Required by the server whenever a BLOCKING warning was overridden. */
  safetyOverrideReason: z.string().nullable().default(null),
});
export type PrescriptionLine = z.infer<typeof PrescriptionLine>;

/**
 * Dosage shorthand. Clinicians type the left column; patients read the right.
 * Translation happens at render time, never at entry, so the clinician's speed
 * is not traded against the patient's comprehension.
 */
export const DOSAGE_SHORTHAND: Record<string, string> = {
  '1-0-1': '1 in the morning and 1 at night',
  '1-1-1': '1 three times a day',
  '1-0-0': '1 in the morning',
  '0-0-1': '1 at night',
  '0-1-0': '1 at noon',
  '1-1-0': '1 in the morning and 1 at noon',
  '2-0-2': '2 in the morning and 2 at night',
  '1/2-0-1/2': 'Half in the morning and half at night',
  SOS: 'Only when needed',
  STAT: 'Immediately, once',
};

/** Latin abbreviations normalised to the numeric pattern on entry. */
export const FREQUENCY_ALIASES: Record<string, string> = {
  OD: '1-0-0',
  BD: '1-0-1',
  BID: '1-0-1',
  TDS: '1-1-1',
  TID: '1-1-1',
  QID: '1-1-1-1',
  HS: '0-0-1',
};

export function expandFrequency(input: string): string {
  const key = input.trim().toUpperCase();
  return FREQUENCY_ALIASES[key] ?? input.trim();
}

export function describeFrequency(frequency: string, form = 'tablet'): string {
  const plain = DOSAGE_SHORTHAND[frequency.toUpperCase()] ?? DOSAGE_SHORTHAND[frequency];
  if (!plain) return frequency;
  return plain.replace(/^(\d+|Half)/, (m) => `${m} ${form}`);
}

/* ------------------------------------------------------------------------- *
 * Encounter
 * ------------------------------------------------------------------------- */

export const Encounter = z.object({
  id: Uuid,
  patientId: Uuid,
  practitionerId: Uuid,
  appointmentId: Uuid.nullable(),
  status: EncounterStatus,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.nullable(),

  /* Clinical narrative, retained alongside coded data because doctors in this
     segment will not code everything and forcing them loses adoption. */
  chiefComplaint: z.string().nullable(),
  historyOfPresentIllness: z.string().nullable(),
  examinationNotes: z.string().nullable(),
  assessmentNotes: z.string().nullable(),
  planNotes: z.string().nullable(),

  followUpAfterDays: z.number().int().positive().nullable(),
  followUpInstructions: z.string().nullable(),

  /** Once true, clinical content is frozen at the database level. */
  isFinalized: z.boolean(),
  finalizedAt: IsoDateTime.nullable(),
  finalizedBy: Uuid.nullable(),
  amendsEncounterId: Uuid.nullable(),
  amendmentReason: z.string().nullable(),
}).extend(AuditFields.shape);
export type Encounter = z.infer<typeof Encounter>;

/** Everything the consultation screen edits, autosaved every few seconds. */
export const EncounterDraft = z.object({
  chiefComplaint: z.string().nullable().default(null),
  historyOfPresentIllness: z.string().nullable().default(null),
  examinationNotes: z.string().nullable().default(null),
  assessmentNotes: z.string().nullable().default(null),
  planNotes: z.string().nullable().default(null),
  followUpAfterDays: z.number().int().positive().nullable().default(null),
  followUpInstructions: z.string().nullable().default(null),
});
export type EncounterDraft = z.infer<typeof EncounterDraft>;

export const FinaliseEncounter = z.object({
  encounterId: Uuid,
  version: z.number().int(),
  /** Confirms the doctor previewed the exact artefact the patient receives. */
  previewAcknowledged: z.literal(true),
});
export type FinaliseEncounter = z.infer<typeof FinaliseEncounter>;

export const AmendEncounter = z.object({
  encounterId: Uuid,
  amendmentReason: z.string().trim().min(8, 'Explain what is being corrected'),
});
export type AmendEncounter = z.infer<typeof AmendEncounter>;

/** Not part of the clinical record, and structurally undispatchable. */
export const InternalNote = z.object({
  id: Uuid,
  encounterId: Uuid,
  patientId: Uuid,
  note: z.string(),
  authorId: Uuid,
  authorName: z.string(),
  createdAt: IsoDateTime,
});
export type InternalNote = z.infer<typeof InternalNote>;

export const EncounterTemplate = z.object({
  id: Uuid,
  name: z.string(),
  specialty: z.string().nullable(),
  practitionerId: Uuid.nullable(),
  chiefComplaint: z.string().nullable(),
  historyOfPresentIllness: z.string().nullable(),
  examinationNotes: z.string().nullable(),
  assessmentNotes: z.string().nullable(),
  planNotes: z.string().nullable(),
  followUpAfterDays: z.number().int().nullable(),
  promptedObservations: z.array(
    z.object({ code: z.string(), display: z.string(), unit: z.string().nullable() }),
  ),
  usageCount: z.number().int(),
});
export type EncounterTemplate = z.infer<typeof EncounterTemplate>;

export const PrescriptionTemplate = z.object({
  id: Uuid,
  name: z.string(),
  indication: z.string().nullable(),
  practitionerId: Uuid.nullable(),
  lineItems: z.array(PrescriptionLine),
  usageCount: z.number().int(),
});
export type PrescriptionTemplate = z.infer<typeof PrescriptionTemplate>;

/* ------------------------------------------------------------------------- *
 * Patient Snapshot — one aggregate read
 * ------------------------------------------------------------------------- */

/**
 * Deliberately a single response rather than six round trips. The budget is a
 * full render in under a second; below that doctors stop opening it, and the
 * allergy lives here.
 */
export const PatientSnapshot = z.object({
  patientId: Uuid,
  /** Active allergies, highest criticality first. Rendered above the fold. */
  allergies: z.array(Allergy),
  /** Chronic first, then other active problems. */
  conditions: z.array(Condition),
  activeMedications: z.array(MedicationRequest),
  /** Most recent vitals, one per distinct code. */
  latestVitals: z.array(Observation),
  recentEncounters: z.array(
    z.object({
      id: Uuid,
      startedAt: IsoDateTime,
      practitionerName: z.string(),
      chiefComplaint: z.string().nullable(),
      diagnoses: z.array(z.string()),
      isFinalized: z.boolean(),
    }),
  ),
  recentDocuments: z.array(
    z.object({
      id: Uuid,
      title: z.string(),
      documentType: z.string(),
      createdAt: IsoDateTime,
    }),
  ),
  outstandingPaise: z.number().int(),
});
export type PatientSnapshot = z.infer<typeof PatientSnapshot>;
