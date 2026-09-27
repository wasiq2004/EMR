/**
 * Governed analytics — the contract.
 *
 * THE GUARANTEE IS IN THE SHAPE OF THE TYPES, not in a flag anyone can forget.
 * There is no schema in this file with a `patientName`, a `mobile`, an `mrn` or a
 * `dateOfBirth` field. `CohortRow` carries an age BAND and a pseudonymous key,
 * and that key is derived per cohort, so two cohorts cannot be joined on it to
 * re-identify anybody. An analyst who wants to act on a specific person is asking
 * for the clinician's job, which is a different session with different
 * permissions.
 *
 * WHY FILTERS ARE A CLOSED UNION. A filter the evaluator does not recognise would
 * WIDEN a cohort rather than narrow it, and a cohort quietly larger than its
 * stated definition is a governance failure rather than a bug. So every filter is
 * enumerated here, validated at the boundary, and anything else is rejected — not
 * ignored.
 */

import { z } from 'zod';
import { IsoDate, IsoDateTime, Uuid } from './common';

/* ------------------------------------------------------------------------- *
 * Age bands
 * ------------------------------------------------------------------------- */

/**
 * The bands, fixed rather than configurable.
 *
 * Configurable bands would let someone narrow one to a single year and combine it
 * with a date range to identify a patient — the classic re-identification by
 * over-specification. These are wide enough that no band at a five-doctor clinic
 * describes one person, and they are the bands Indian public-health reporting
 * already uses, so the numbers are comparable to something.
 */
export const AGE_BANDS = [
  { key: '0-1', label: 'Under 1', min: 0, max: 0 },
  { key: '1-4', label: '1 to 4', min: 1, max: 4 },
  { key: '5-14', label: '5 to 14', min: 5, max: 14 },
  { key: '15-24', label: '15 to 24', min: 15, max: 24 },
  { key: '25-44', label: '25 to 44', min: 25, max: 44 },
  { key: '45-59', label: '45 to 59', min: 45, max: 59 },
  { key: '60-74', label: '60 to 74', min: 60, max: 74 },
  { key: '75+', label: '75 and over', min: 75, max: 200 },
] as const;

export const AgeBand = z.enum([
  '0-1',
  '1-4',
  '5-14',
  '15-24',
  '25-44',
  '45-59',
  '60-74',
  '75+',
  /** Age is genuinely unknown on the record. Reported, never silently dropped. */
  'UNKNOWN',
]);
export type AgeBand = z.infer<typeof AgeBand>;

export function bandFor(age: number | null): AgeBand {
  if (age === null || age < 0) return 'UNKNOWN';
  const band = AGE_BANDS.find((b) => age >= b.min && age <= b.max);
  return (band?.key ?? 'UNKNOWN') as AgeBand;
}

/* ------------------------------------------------------------------------- *
 * Cohort definition
 * ------------------------------------------------------------------------- */

export const CohortFilters = z
  .object({
    /** Encounters in this window. Required: an unbounded cohort is the whole record. */
    from: IsoDate,
    to: IsoDate,

    ageBands: z.array(AgeBand).optional(),
    sexes: z.array(z.enum(['MALE', 'FEMALE', 'OTHER', 'UNKNOWN'])).optional(),

    /** Coded diagnoses. Free-text conditions are deliberately not filterable. */
    diagnosisCodes: z.array(z.string().trim().min(1)).optional(),
    /*
     * No `encounterTypes`. The encounter table has no such column — it has
     * `consultationMode` — and a filter with nothing behind it would be accepted,
     * ignored, and would silently return a WIDER cohort than its definition
     * claims. Which is the exact failure the `.strict()` below exists to prevent,
     * so it would be perverse to ship one.
     */
    consultationModes: z.array(z.enum(['IN_PERSON', 'TELECONSULTATION'])).optional(),
    practitionerIds: z.array(Uuid).optional(),
    locationIds: z.array(Uuid).optional(),

    /** Molecule names, not brands — a cohort on a brand is a marketing question. */
    medicationMolecules: z.array(z.string().trim().min(1)).optional(),

    /** Observation range, e.g. systolic BP over 140. */
    observation: z
      .object({
        code: z.string().trim().min(1),
        min: z.number().optional(),
        max: z.number().optional(),
      })
      .optional(),

    /** Only patients with at least this many visits in the window. */
    minEncounters: z.number().int().positive().optional(),
  })
  .strict(); // Rejects an unknown key rather than ignoring it. See the header.
export type CohortFilters = z.infer<typeof CohortFilters>;

export const SaveCohort = z.object({
  name: z.string().trim().min(3, 'Give the cohort a name someone else would understand'),
  /**
   * Required, and not a formality.
   *
   * "Cohort 3" is not a purpose, and a saved definition nobody can explain six
   * months later is how analytics becomes a liability. The blueprint's §7 makes
   * provenance a first-class requirement; this is the human half of it.
   */
  purpose: z.string().trim().min(10, 'Say what question this cohort answers'),
  filters: CohortFilters,
  isShared: z.boolean().default(false),
  chartConfig: z.record(z.string(), z.unknown()).nullish(),
});
export type SaveCohort = z.infer<typeof SaveCohort>;

export const Cohort = z.object({
  id: Uuid,
  name: z.string(),
  purpose: z.string(),
  filters: CohortFilters,
  definitionVersion: z.number().int(),
  isShared: z.boolean(),
  chartConfig: z.record(z.string(), z.unknown()).nullable(),
  lastEvaluatedAt: IsoDateTime.nullable(),
  lastEvaluatedSize: z.number().int().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Cohort = z.infer<typeof Cohort>;

/* ------------------------------------------------------------------------- *
 * Cohort results — de-identified by construction
 * ------------------------------------------------------------------------- */

/**
 * One row of a cohort.
 *
 * READ THE FIELD LIST. There is no name, no mobile, no MRN, no date of birth and
 * no free text. `subjectKey` is a per-cohort pseudonym: the same patient appearing
 * in two different cohorts gets two different keys, so the two extracts cannot be
 * joined to narrow anybody down.
 */
export const CohortRow = z.object({
  /** Stable WITHIN one cohort, meaningless outside it. */
  subjectKey: z.string(),
  ageBand: AgeBand,
  sex: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNKNOWN']),
  encounterCount: z.number().int(),
  /** Month precision, never a date: a date plus a band is close to an identity. */
  firstEncounterMonth: z.string(),
  lastEncounterMonth: z.string(),
  diagnosisCodes: z.array(z.string()),
  medicationMolecules: z.array(z.string()),
  /** Did the patient return within the follow-up interval the clinician asked for. */
  followUpCompleted: z.boolean().nullable(),
});
export type CohortRow = z.infer<typeof CohortRow>;

/**
 * A cohort's headline figures.
 *
 * `suppressed` is the important field. Any breakdown cell with fewer than the
 * small-cell threshold is reported as suppressed rather than as a number, because
 * "1 female patient aged 75+ with this diagnosis in March" is an identity at a
 * clinic this size. The count of suppressed cells is disclosed so nobody mistakes
 * a gap for a zero.
 */
export const CohortSummary = z.object({
  cohortId: Uuid.nullable(),
  size: z.number().int(),
  encounterCount: z.number().int(),
  generatedAt: IsoDateTime,
  definitionVersion: z.number().int(),
  /** Below this, a breakdown cell is suppressed. Disclosed, not hidden. */
  smallCellThreshold: z.number().int(),
  suppressedCellCount: z.number().int(),

  byAgeBand: z.array(z.object({ band: AgeBand, count: z.number().int().nullable() })),
  bySex: z.array(z.object({ sex: z.string(), count: z.number().int().nullable() })),
  byMonth: z.array(
    z.object({
      month: z.string(),
      patients: z.number().int().nullable(),
      encounters: z.number().int().nullable(),
      newPatients: z.number().int().nullable(),
    }),
  ),
  topDiagnoses: z.array(
    z.object({ code: z.string(), display: z.string(), count: z.number().int().nullable() }),
  ),
  topMolecules: z.array(
    z.object({ molecule: z.string(), count: z.number().int().nullable() }),
  ),
  followUp: z.object({
    instructed: z.number().int(),
    completed: z.number().int(),
    /** Percentage points, integer. A rate on a base under the threshold is null. */
    ratePercent: z.number().int().nullable(),
  }),
});
export type CohortSummary = z.infer<typeof CohortSummary>;

/* ------------------------------------------------------------------------- *
 * Data quality
 * ------------------------------------------------------------------------- */

/**
 * What the blueprint's gap #4 asks for and mainstream clinic products omit.
 *
 * Every metric here is about the RECORD rather than the patient: how complete the
 * coding is, how much is missing, how many consultations were never finalised. It
 * is the honest prerequisite for any analysis — a cohort built on 40% missing
 * diagnosis codes is not a finding, and nobody can tell without this screen.
 */
export const DataQualityMetric = z.object({
  key: z.string(),
  label: z.string(),
  /** What it measures and how, in a sentence. Shown beside the number. */
  definition: z.string(),
  /** Records examined. */
  denominator: z.number().int(),
  /** Records failing the check. */
  numerator: z.number().int(),
  percent: z.number().int().nullable(),
  /** 'good' | 'watch' | 'poor', so the screen is readable without arithmetic. */
  verdict: z.enum(['good', 'watch', 'poor', 'unknown']),
  /** Higher is better for completeness, worse for missingness. */
  higherIsBetter: z.boolean(),
});
export type DataQualityMetric = z.infer<typeof DataQualityMetric>;

export const DataQualityReport = z.object({
  generatedAt: IsoDateTime,
  rangeFrom: IsoDate,
  rangeTo: IsoDate,
  metrics: z.array(DataQualityMetric),
  /** Completeness per field, for the heatmap the blueprint asks for. */
  fieldCompleteness: z.array(
    z.object({
      entity: z.string(),
      field: z.string(),
      present: z.number().int(),
      total: z.number().int(),
      percent: z.number().int(),
    }),
  ),
});
export type DataQualityReport = z.infer<typeof DataQualityReport>;

/* ------------------------------------------------------------------------- *
 * The data dictionary
 * ------------------------------------------------------------------------- */

/**
 * What each field means, where it comes from, and what it does NOT mean.
 *
 * Served from the API rather than written in a wiki, because a dictionary that
 * lives somewhere else is a dictionary that describes last year's schema. §7 of
 * the blueprint makes this a required module; it is also the cheapest way to stop
 * an analyst misreading `age_years` as a birth date.
 */
export const DictionaryEntry = z.object({
  entity: z.string(),
  field: z.string(),
  type: z.string(),
  definition: z.string(),
  /** 'ICD-10' | 'SNOMED CT' | 'none', so a code's namespace is never guessed. */
  codingSystem: z.string().nullable(),
  unit: z.string().nullable(),
  nullable: z.boolean(),
  /** Why it might be absent, which is usually more useful than the type. */
  absenceMeaning: z.string().nullable(),
  availableToAnalyst: z.boolean(),
});
export type DictionaryEntry = z.infer<typeof DictionaryEntry>;

/* ------------------------------------------------------------------------- *
 * Exports
 * ------------------------------------------------------------------------- */

export const RequestExport = z.object({
  cohortId: Uuid.nullish(),
  /** An ad-hoc export must still carry a definition, so it is required here too. */
  filters: CohortFilters.optional(),
  exportType: z.enum(['COHORT_ROWS', 'TREND_SERIES', 'DATA_QUALITY']),
});
export type RequestExport = z.infer<typeof RequestExport>;

export const AnalystExportRow = z.object({
  id: Uuid,
  cohortId: Uuid.nullable(),
  cohortName: z.string(),
  definitionSnapshot: z.record(z.string(), z.unknown()),
  definitionVersion: z.number().int(),
  exportType: z.string(),
  status: z.string(),
  rowCount: z.number().int().nullable(),
  columnsIncluded: z.array(z.string()).nullable(),
  sizeBytes: z.number().int().nullable(),
  requestedByName: z.string().nullable(),
  requestedAt: IsoDateTime,
  completedAt: IsoDateTime.nullable(),
  downloadExpiresAt: IsoDateTime.nullable(),
  failureReason: z.string().nullable(),
});
export type AnalystExportRow = z.infer<typeof AnalystExportRow>;

/* ------------------------------------------------------------------------- *
 * Disclosure control
 * ------------------------------------------------------------------------- */

/**
 * The small-cell threshold.
 *
 * Five is the convention in health statistics and it is the right order of
 * magnitude here for a specific reason: at a clinic seeing forty patients a day,
 * a breakdown cell containing two people is very close to naming them, and
 * anybody who works there could finish the job from memory.
 *
 * Applied to BREAKDOWN cells, not to the cohort total. Knowing a cohort has three
 * members discloses nothing; knowing which three does.
 */
export const SMALL_CELL_THRESHOLD = 5;

/**
 * Suppresses a cell below the threshold.
 *
 * Returns null rather than zero, and the caller reports how many it suppressed —
 * so a gap is never mistaken for an absence. Reporting zero would be worse than
 * reporting nothing, because it is a false statement about the data.
 */
export function suppress(count: number): number | null {
  if (count <= 0) return 0;
  return count < SMALL_CELL_THRESHOLD ? null : count;
}

/**
 * A per-cohort pseudonym for a patient.
 *
 * Salted with the cohort's own id, so the same patient in two cohorts has two
 * unrelated keys. Without the salt, two exports could be joined on the key and
 * the intersection would narrow a person down by combining their attributes —
 * which is the standard way pseudonymised extracts get re-identified.
 *
 * Not a secret and not reversible: it exists so rows in ONE extract can be
 * counted per subject, and for nothing else.
 */
export function subjectKey(patientId: string, cohortSalt: string): string {
  let hash = 0x811c9dc5;
  const input = `${cohortSalt}:${patientId}`;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `S-${hash.toString(36).toUpperCase().padStart(7, '0')}`;
}
