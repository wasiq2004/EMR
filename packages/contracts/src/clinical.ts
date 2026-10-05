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
import { AuditFields, IsoDateTime, Paise, Uuid } from './common';
import {
  AllergyCategory,
  AllergyCriticality,
  ConditionClinicalStatus,
  ConsultationMode,
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

/**
 * The vitals the consultation screen prompts for, in entry order.
 *
 * THE UNIT IS FIXED PER MEASURE and is not a field anybody fills in. A weight
 * entered in pounds into a column labelled kg is not a data-entry error that
 * shows up as a validation message — it shows up later as a dose calculated on
 * the wrong body weight. So the unit is attached to the code here, the server
 * writes this one, and the interface prints it beside the box rather than
 * offering a choice.
 *
 * `criticalLow`/`criticalHigh` are a SECOND band outside `low`/`high`. The
 * difference matters at a counter: a systolic of 145 is high and ordinary, and a
 * systolic of 210 is somebody who should not be sent back to the waiting room.
 * Flagging both the same way makes the second read like the first.
 *
 * These are ADULT outpatient ranges. They are not paediatric — a pulse of 120 is
 * alarming in an adult and unremarkable in a two-year-old — and nothing here
 * adjusts for age, so a flag is a prompt to look and never a diagnosis. The
 * reading is stored as measured whatever band it falls in.
 */
export const VITAL_CODES = [
  {
    code: '8480-6',
    display: 'Systolic BP',
    unit: 'mm[Hg]',
    low: 90,
    high: 140,
    criticalLow: 80,
    criticalHigh: 180,
    step: 1,
  },
  {
    code: '8462-4',
    display: 'Diastolic BP',
    unit: 'mm[Hg]',
    low: 60,
    high: 90,
    criticalLow: 50,
    criticalHigh: 120,
    step: 1,
  },
  {
    code: '8867-4',
    display: 'Pulse',
    unit: '/min',
    low: 60,
    high: 100,
    criticalLow: 40,
    criticalHigh: 130,
    step: 1,
  },
  {
    code: '8310-5',
    display: 'Temperature',
    unit: 'Cel',
    low: 36.1,
    high: 37.5,
    criticalLow: 35,
    criticalHigh: 39.5,
    step: 0.1,
  },
  {
    code: '9279-1',
    display: 'Respiratory rate',
    unit: '/min',
    low: 12,
    high: 20,
    criticalLow: 8,
    criticalHigh: 30,
    step: 1,
  },
  {
    code: '2708-6',
    display: 'SpO2',
    unit: '%',
    low: 95,
    high: 100,
    criticalLow: 90,
    criticalHigh: null,
    step: 1,
  },
  {
    code: '29463-7',
    display: 'Weight',
    unit: 'kg',
    low: null,
    high: null,
    criticalLow: null,
    criticalHigh: null,
    step: 0.1,
  },
  {
    code: '8302-2',
    display: 'Height',
    unit: 'cm',
    low: null,
    high: null,
    criticalLow: null,
    criticalHigh: null,
    step: 0.5,
  },
] as const;

export type VitalCode = (typeof VITAL_CODES)[number];

/** The reference definition for a LOINC code, or undefined if it is not a vital. */
export function vitalFor(code: string): VitalCode | undefined {
  return VITAL_CODES.find((v) => v.code === code);
}

/**
 * Where a reading falls against its reference range.
 *
 * DERIVED ON THE SERVER AT WRITE TIME, from the code alone. The client does not
 * get to say whether a reading is normal, for two reasons. A browser running
 * last month's deployment would stamp last month's thresholds onto today's
 * records with nothing to show which. And "is this dangerous" is a clinical
 * assertion — accepting the caller's word for it means the field says only what
 * the caller chose to claim, which makes it useless as a filter and worse than
 * absent on a record somebody later relies on.
 *
 * This used to live on the client, and `RecordObservation` stripped the result
 * before it reached the database — so every vital ever recorded, a systolic of
 * 210 included, was stored with no interpretation at all.
 */
export function interpretVital(
  code: string,
  value: number,
): 'NORMAL' | 'LOW' | 'HIGH' | 'CRITICAL' | null {
  const vital = vitalFor(code);
  /*
   * Null, not NORMAL, when there is no range to check against — weight, height,
   * or something a template added. We have not checked it, which is not the
   * same as having checked it and found it fine.
   */
  if (!vital) return null;
  if (vital.low === null && vital.high === null) return null;

  if (vital.criticalLow !== null && value < vital.criticalLow) return 'CRITICAL';
  if (vital.criticalHigh !== null && value > vital.criticalHigh) return 'CRITICAL';
  if (vital.low !== null && value < vital.low) return 'LOW';
  if (vital.high !== null && value > vital.high) return 'HIGH';
  return 'NORMAL';
}

/**
 * Body mass index, in kg per square metre.
 *
 * DERIVED WHERE IT IS SHOWN, never stored. A stored BMI is a third copy of two
 * numbers already on the record, and the copy stops agreeing the first time
 * somebody corrects a mistyped weight — leaving a record that reports a BMI its
 * own height and weight do not produce. Computing it on read costs nothing and
 * cannot drift.
 *
 * Returns null whenever the inputs cannot support a figure, so a missing height
 * reads as "not calculated" rather than as a plausible number.
 */
export function bodyMassIndex(
  weightKg: number | null | undefined,
  heightCm: number | null | undefined,
): number | null {
  if (!weightKg || !heightCm) return null;
  /*
   * Guards against a height entered in metres (1.7) or inches (67). Both are
   * things people type, and both produce a confident, completely wrong BMI
   * rather than an error.
   */
  if (heightCm < 50 || heightCm > 260) return null;
  if (weightKg < 1 || weightKg > 400) return null;
  const metres = heightCm / 100;
  return Math.round((weightKg / (metres * metres)) * 10) / 10;
}

/**
 * The band a BMI falls in, using the ASIAN cut-offs.
 *
 * India uses lower thresholds than the WHO international ones — overweight from
 * 23 rather than 25, obese from 27.5 rather than 30 — because cardiometabolic
 * risk rises at a lower BMI in South Asian populations. Applying the
 * international bands here would tell a large share of this product's patients
 * they are a healthy weight when their own national guidance says otherwise.
 */
export function bmiBand(bmi: number): { label: string; tone: 'low' | 'normal' | 'high' } {
  if (bmi < 18.5) return { label: 'Underweight', tone: 'low' };
  if (bmi < 23) return { label: 'Normal', tone: 'normal' };
  if (bmi < 27.5) return { label: 'Overweight', tone: 'high' };
  return { label: 'Obese', tone: 'high' };
}

/**
 * What a caller may state about an observation.
 *
 * The reference range and the interpretation are NOT here, on purpose: they are
 * derived server-side from the code. They were absent before as well, but by
 * accident — the service read three fields this schema had never declared, so
 * `parseBody` removed them and the service wrote null every time while reading
 * as though it did otherwise.
 */
export const RecordObservation = z.object({
  patientId: Uuid,
  encounterId: Uuid.nullable(),
  code: z.string(),
  display: z.string(),
  valueNumeric: z.number().nullable(),
  /**
   * Optional, and overridden for a known vital.
   *
   * The unit belongs to the measure, not to the entry. A caller recording
   * something outside `VITAL_CODES` supplies its own UCUM unit.
   */
  valueUnit: z.string().nullable(),
  valueText: z.string().nullable(),
  /**
   * When the measurement was TAKEN. Defaults to now.
   *
   * A nurse entering a set of vitals twenty minutes after taking them is
   * recording what the patient was at the bedside, not at the keyboard, and a
   * trend built from entry times is a trend of how busy the front desk was.
   */
  effectiveAt: IsoDateTime.nullish(),
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

/**
 * One entry in the diagnosis catalogue.
 *
 * A SUGGESTION, NEVER A REQUIREMENT. `condition.code` is nullable and the
 * typeahead always accepts what was typed, because a doctor who cannot find the
 * code for what they are looking at needs to write it down and move on. Picking
 * the nearest wrong code is the failure the catalogue exists to avoid, not the
 * behaviour it exists to produce — a code travels onto an insurance claim and
 * into the next clinician's reading with the authority of a standard, which free
 * text visibly does not claim.
 */
export const DiagnosisCatalogueItem = z.object({
  id: Uuid,
  code: z.string(),
  codeSystem: z.string(),
  displayText: z.string(),
  category: z.string().nullable(),
  /** Pre-ticks the chronic box when picked. Still editable — see the column. */
  isChronicByDefault: z.boolean(),
  /**
   * Whether this clinic added it, rather than it coming from the shared set.
   *
   * Shown in the picker so a doctor can tell their own clinic's shorthand from a
   * standard code, and so an administrator can see what has accumulated.
   */
  isOwn: z.boolean().default(false),
  /** How often this clinic has recorded it, so common ones sort first. */
  uses: z.number().int().default(0),
});
export type DiagnosisCatalogueItem = z.infer<typeof DiagnosisCatalogueItem>;

/**
 * Adding a code this clinic uses and the shared set does not have.
 *
 * Written under the clinic's OWN tenant, never the shared one — see migration
 * `0011`, which asserts that no write policy admits the system tenant. One
 * clinic renaming a diagnosis must not rename it for every clinic on the
 * deployment.
 */
export const AddDiagnosisCode = z.object({
  code: z.string().trim().min(1, 'Enter the code'),
  /**
   * Required, because a bare code is ambiguous.
   *
   * J02.9 means one thing in ICD-10 and another in ICD-11, and a record carrying
   * one without the other cannot be read in ten years or handed to ABDM.
   */
  codeSystem: z.string().trim().min(1).default('http://hl7.org/fhir/sid/icd-10'),
  displayText: z.string().trim().min(2, 'Enter the diagnosis as it should read'),
  category: z.string().trim().nullish(),
  isChronicByDefault: z.boolean().default(false),
  /** Extra words to search by — abbreviations the clinic actually types. */
  synonyms: z.string().trim().nullish(),
});
export type AddDiagnosisCode = z.infer<typeof AddDiagnosisCode>;

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
/**
 * Adding a drug the shared catalogue does not have.
 *
 * Prescribing an uncatalogued drug has always worked — the combobox offers
 * "prescribe as typed" and the line stores a null `catalogueItemId`. This is the
 * separate act of keeping it, so the next doctor finds it by searching and the
 * allergy check has a molecule to reason about.
 *
 * WHY `moleculeName` IS REQUIRED AND THE BRAND IS NOT. Safety is computed from
 * the molecule: `drug-classes.ts` maps molecules to classes so that prescribing
 * "Mox 500" to a penicillin-allergic patient is caught by the class, not by the
 * brand name containing the word "penicillin". A catalogue row with a brand and
 * no molecule would search well and check nothing — which is worse than not
 * being in the catalogue at all, because the doctor would reasonably assume a
 * catalogued drug had been checked.
 *
 * Written under the clinic's OWN tenant, never the shared one. Migration `0013`
 * asserts that no write policy on any shared catalogue admits the system tenant.
 */
export const AddDrugToCatalogue = z.object({
  /** As marketed, e.g. "Mox 500". Optional — a generic has no brand. */
  brandName: z.string().trim().max(120).nullish(),
  /**
   * The molecule, required.
   *
   * A combination is written as the clinic writes it — "Amoxicillin + Clavulanic
   * acid" — because that is what the allergy cross-check splits on and what a
   * doctor reads back.
   */
  moleculeName: z.string().trim().min(2, 'Name the molecule, not just the brand'),
  strength: z.string().trim().max(60).nullish(),
  dosageForm: z.string().trim().max(60).nullish(),
  route: z.string().trim().max(60).nullish(),
  manufacturer: z.string().trim().max(120).nullish(),
  /**
   * H, H1 or X. Schedule X may not be prescribed by telemedicine, and the server
   * enforces that — so getting this wrong on a clinic's own row would defeat a
   * legal control. Left null when unknown rather than guessed at.
   */
  drugSchedule: z.enum(['H', 'H1', 'X']).nullish(),
});
export type AddDrugToCatalogue = z.infer<typeof AddDrugToCatalogue>;

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
/**
 * Changing the dose on a line already on the prescription.
 *
 * ONLY THE DOSE. The drug itself is not editable — swapping amoxicillin for
 * azithromycin on an existing line would slide past the allergy and
 * duplicate-therapy checks that ran when the line was created, and the safety
 * warnings stored against it would then describe a drug that is no longer there.
 * Changing the medicine means removing the line and adding the right one, which
 * re-runs the checks.
 *
 * A signed prescription is not editable at all; the service refuses it.
 */
export const ReviseDosage = z.object({
  frequency: z.string().trim().min(1, 'Enter a dosage, e.g. 1-0-1'),
  timingRelativeToFood: z
    .enum(['BEFORE_FOOD', 'AFTER_FOOD', 'WITH_FOOD'])
    .nullish(),
  durationDays: z.number().int().positive().max(365).nullish(),
  quantity: z.number().positive().max(1000).nullish(),
  instructions: z.string().trim().max(500).nullish(),
  route: z.string().trim().max(60).nullish(),
});
export type ReviseDosage = z.infer<typeof ReviseDosage>;

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


/**
 * The frequencies the picker offers, in the order a prescriber reaches for them.
 *
 * India writes dosage positionally — "1-0-1" is morning-noon-night — and that
 * convention is what goes on the printed prescription, so it is what is stored.
 * These are the presets; the field stays free text underneath, because a
 * tapering course ("2-0-2 for 3 days then 1-0-1") is a real prescription that no
 * preset list will ever contain.
 */
export const FREQUENCY_PRESETS = [
  { value: '1-0-0', label: '1-0-0', hint: 'Morning' },
  { value: '0-0-1', label: '0-0-1', hint: 'Night' },
  { value: '1-0-1', label: '1-0-1', hint: 'Morning + night' },
  { value: '1-1-1', label: '1-1-1', hint: 'Three times' },
  { value: '1-1-1-1', label: '1-1-1-1', hint: 'Four times' },
  { value: '0-1-0', label: '0-1-0', hint: 'Noon' },
  { value: '1-1-0', label: '1-1-0', hint: 'Morning + noon' },
  { value: '2-0-2', label: '2-0-2', hint: 'Two, twice' },
  { value: '1/2-0-1/2', label: '½-0-½', hint: 'Half, twice' },
  { value: 'SOS', label: 'SOS', hint: 'When needed' },
  { value: 'STAT', label: 'STAT', hint: 'Once, now' },
] as const;

/** The durations a course usually runs for. Still free to type any number. */
export const DURATION_PRESETS = [3, 5, 7, 10, 15, 30] as const;

export const TIMING_OPTIONS = [
  { value: 'BEFORE_FOOD', label: 'Before food' },
  { value: 'AFTER_FOOD', label: 'After food' },
  { value: 'WITH_FOOD', label: 'With food' },
] as const;

/**
 * Routes of administration, as an outpatient clinic uses them.
 *
 * A catalogue entry's own route wins when it has one — an injection is not
 * going to be taken orally — and this list is for the rest.
 */
export const ROUTE_OPTIONS = [
  'Oral',
  'Topical',
  'Inhaled',
  'Nasal',
  'Ophthalmic',
  'Otic',
  'Rectal',
  'Vaginal',
  'Sublingual',
  'IM',
  'IV',
  'Subcutaneous',
] as const;

/**
 * How many units a day a positional frequency means.
 *
 * "1-0-1" is two. "1/2-0-1/2" is one. "2-0-2" is four. Returns null for SOS and
 * STAT, where the answer is genuinely unknown — an as-needed drug has no daily
 * total, and guessing one would put a confident wrong number on a pharmacy
 * label.
 */
export function dosesPerDay(frequency: string): number | null {
  const normalised = expandFrequency(frequency);
  const upper = normalised.toUpperCase();
  if (upper === 'SOS' || upper === 'STAT') return null;

  const parts = normalised.split('-');
  if (parts.length < 2) return null;

  let total = 0;
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === '') return null;
    // Halves and quarters are written as fractions on Indian prescriptions.
    const fraction = /^(\d+)\/(\d+)$/.exec(trimmed);
    const value = fraction
      ? Number(fraction[1]) / Number(fraction[2])
      : Number(trimmed);
    if (!Number.isFinite(value) || value < 0) return null;
    total += value;
  }
  return total > 0 ? total : null;
}

/**
 * How much to dispense for a whole course.
 *
 * Doses per day times days, rounded UP to a whole unit — half a tablet cannot
 * be dispensed, and rounding down sends the patient home one short on the last
 * day. Null when the frequency has no daily total, so the pharmacy is told
 * nothing rather than told a guess.
 */
export function quantityForCourse(
  frequency: string,
  durationDays: number | null | undefined,
): number | null {
  if (!durationDays || durationDays < 1) return null;
  const perDay = dosesPerDay(frequency);
  if (perDay === null) return null;
  return Math.ceil(perDay * durationDays);
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
  /**
   * In the room, or remote. Read by the prescribing safety check and printed on
   * the prescription — a teleconsultation carries a declaration that an
   * in-person consultation does not.
   */
  consultationMode: ConsultationMode,
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

/* ------------------------------------------------------------------------- *
 * Lab — orders and results
 * ------------------------------------------------------------------------- */

export const LabOrderStatus = z.enum(['ORDERED', 'RESULTED', 'REVIEWED', 'CANCELLED']);
export type LabOrderStatus = z.infer<typeof LabOrderStatus>;

export const LAB_ORDER_STATUS_LABEL: Record<LabOrderStatus, string> = {
  ORDERED: 'Awaiting result',
  /** Arrived, NOT read. The distinction is the point of the module. */
  RESULTED: 'Result in, not reviewed',
  REVIEWED: 'Reviewed',
  CANCELLED: 'Cancelled',
};

export const LabInterpretation = z.enum(['NORMAL', 'LOW', 'HIGH', 'CRITICAL', 'ABNORMAL']);
export type LabInterpretation = z.infer<typeof LabInterpretation>;

export const LabTestCatalogueItem = z.object({
  id: Uuid,
  code: z.string().nullable(),
  codeSystem: z.string().nullable(),
  name: z.string(),
  category: z.string().nullable(),
  unit: z.string().nullable(),
  referenceLow: z.number().nullable(),
  referenceHigh: z.number().nullable(),
  pricePaise: Paise.nullable(),
  /** Whether this clinic added it, rather than it coming from the shared set. */
  isOwn: z.boolean().default(false),
});
export type LabTestCatalogueItem = z.infer<typeof LabTestCatalogueItem>;

/**
 * Ordering a test.
 *
 * `catalogueItemId` is optional, and free text is a first-class path for the
 * same reason it is for diagnoses and drugs: a doctor ordering something the
 * catalogue does not list must be able to write it down, not pick the nearest
 * wrong test. The order keeps its own `testName` either way, because it is a
 * record of what was asked for and has to still say that after the catalogue
 * entry is renamed.
 */
export const OrderLabTest = z.object({
  patientId: Uuid,
  encounterId: Uuid.nullish(),
  catalogueItemId: Uuid.nullish(),
  testName: z.string().trim().min(2, 'Name the test'),
  clinicalNote: z.string().trim().max(500).nullish(),
  isUrgent: z.boolean().default(false),
});
export type OrderLabTest = z.infer<typeof OrderLabTest>;

/**
 * Entering a result.
 *
 * NO `interpretation` FIELD. It is derived server-side from the reference range,
 * like the vitals: a caller that could assert a result was normal would make the
 * field say only what it chose to claim, which is worse than absent on a record
 * somebody later relies on.
 *
 * Either a number or text, and the database enforces that one is present. A
 * result with neither is not a result.
 */
export const EnterLabResult = z.object({
  valueNumeric: z.number().nullish(),
  valueText: z.string().trim().max(2000).nullish(),
  /** Overrides the catalogue's unit only when the lab reported a different one. */
  unit: z.string().trim().max(40).nullish(),
  /**
   * The range the LAB quoted, where it differs from the catalogue's.
   *
   * Labs disagree about reference ranges, and the one printed on the report is
   * the one the result should be judged against. Omitted, the catalogue's is
   * used; either way the range is copied onto the result so a later correction
   * to the catalogue cannot reclassify it.
   */
  referenceLow: z.number().nullish(),
  referenceHigh: z.number().nullish(),
  specimenAt: IsoDateTime.nullish(),
  performedBy: z.string().trim().max(120).nullish(),
  labNote: z.string().trim().max(1000).nullish(),
  documentId: Uuid.nullish(),
  /**
   * Set when this corrects a result already entered.
   *
   * A lab that phones to correct a potassium does not change what was ordered,
   * and overwriting in place would destroy the record of what the doctor acted
   * on — so a correction supersedes the previous row and has to say why.
   */
  supersedesReason: z.string().trim().min(3, 'Say why it is being corrected').nullish(),
}).refine(
  (v) => v.valueNumeric != null || (v.valueText != null && v.valueText.length > 0),
  { message: 'Enter a value, or the text the lab reported', path: ['valueNumeric'] },
);
export type EnterLabResult = z.infer<typeof EnterLabResult>;

export const LabResult = z.object({
  id: Uuid,
  valueNumeric: z.number().nullable(),
  valueText: z.string().nullable(),
  unit: z.string().nullable(),
  referenceLow: z.number().nullable(),
  referenceHigh: z.number().nullable(),
  interpretation: LabInterpretation.nullable(),
  specimenAt: IsoDateTime.nullable(),
  resultedAt: IsoDateTime,
  performedBy: z.string().nullable(),
  labNote: z.string().nullable(),
  documentId: Uuid.nullable(),
  supersededAt: IsoDateTime.nullable(),
  supersededReason: z.string().nullable(),
  enteredBy: Uuid,
  enteredByName: z.string().nullable(),
});
export type LabResult = z.infer<typeof LabResult>;

export const LabOrder = z.object({
  id: Uuid,
  patientId: Uuid,
  patientName: z.string(),
  patientMrn: z.string(),
  encounterId: Uuid.nullable(),
  catalogueItemId: Uuid.nullable(),
  testName: z.string(),
  unit: z.string().nullable(),
  status: LabOrderStatus,
  clinicalNote: z.string().nullable(),
  isUrgent: z.boolean(),
  orderedAt: IsoDateTime,
  orderedBy: Uuid,
  orderedByName: z.string().nullable(),
  reviewedAt: IsoDateTime.nullable(),
  reviewedBy: Uuid.nullable(),
  reviewedByName: z.string().nullable(),
  cancelledReason: z.string().nullable(),
  /** The live result, if one is in. Superseded ones are not here. */
  result: LabResult.nullable(),
});
export type LabOrder = z.infer<typeof LabOrder>;

/**
 * The doctor's "results to review" card.
 *
 * `awaitingReview` is the number that matters: a result that arrived and nobody
 * opened is the failure this module exists to make visible. `overdue` counts
 * orders placed long enough ago that the result should have come back — an
 * order the patient never went for looks exactly like one the lab is slow with,
 * and both need chasing.
 */
export const LabReviewSummary = z.object({
  awaitingReview: z.number().int(),
  abnormalAwaitingReview: z.number().int(),
  criticalAwaitingReview: z.number().int(),
  awaitingResult: z.number().int(),
  /** Ordered more than 14 days ago with still no result. */
  overdue: z.number().int(),
});
export type LabReviewSummary = z.infer<typeof LabReviewSummary>;
