import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import type { DataQualityMetric, DataQualityReport, DictionaryEntry } from '@emr/contracts';

import { TenantDb } from '../../common/tenancy/tenant-db.service';

/**
 * Data quality, and the dictionary that makes it readable.
 *
 * This is the blueprint's gap #4 — the thing it says mainstream clinic products
 * omit and NUVA can differentiate on. The argument is simple and correct: a cohort
 * built on 40% missing diagnosis codes is not a finding, and nobody can tell
 * whether that is the case without a screen like this one.
 *
 * EVERY METRIC IS ABOUT THE RECORD, NOT THE PATIENT. Completeness, coding rates,
 * unfinalised counts. Nothing here returns a person, and nothing here needs to —
 * which is why an analyst holding no `patient:read` can be given all of it.
 *
 * COMPUTED ON READ, NEVER CACHED. A stored data-quality figure is stale the moment
 * a doctor saves a note, and a stale quality figure is worse than none because
 * somebody will act on it. These queries are counts over indexed columns; the cost
 * is not the problem the cache would solve.
 */
@Injectable()
export class DataQualityService {
  constructor(private readonly tenantDb: TenantDb) {}

  async report(from: string, to: string): Promise<DataQualityReport> {
    return this.tenantDb.runReadOnly(async (tx) => {
      const inRange = and(
        sql`${schema.encounter.startedAt} >= ${from}::date`,
        sql`${schema.encounter.startedAt} < (${to}::date + interval '1 day')`,
      );

      /* ---- Encounter-level completeness ---------------------------------- */

      const [encounters] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          finalised: sql<number>`count(*) FILTER (WHERE ${schema.encounter.isFinalized})::int`,
          withComplaint: sql<number>`count(*) FILTER (WHERE coalesce(trim(${schema.encounter.chiefComplaint}), '') <> '')::int`,
          withAssessment: sql<number>`count(*) FILTER (WHERE coalesce(trim(${schema.encounter.assessmentNotes}), '') <> '')::int`,
          withPlan: sql<number>`count(*) FILTER (WHERE coalesce(trim(${schema.encounter.planNotes}), '') <> '')::int`,
          withFollowUp: sql<number>`count(*) FILTER (WHERE ${schema.encounter.followUpAfterDays} IS NOT NULL)::int`,
        })
        .from(schema.encounter)
        .where(inRange);

      /*
       * Coded versus free-text diagnoses.
       *
       * The single most important number on this screen. A clinic whose conditions
       * are 90% free text cannot be analysed by diagnosis at all, and every cohort
       * filtered on a code will silently under-count — which looks like a finding
       * rather than a data problem.
       */
      const [conditions] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          coded: sql<number>`count(*) FILTER (WHERE coalesce(trim(${schema.condition.code}), '') <> '')::int`,
          withSystem: sql<number>`count(*) FILTER (WHERE coalesce(trim(${schema.condition.codeSystem}), '') <> '')::int`,
        })
        .from(schema.condition)
        .innerJoin(schema.encounter, eq(schema.encounter.id, schema.condition.encounterId))
        .where(inRange);

      const [observations] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          withUnit: sql<number>`count(*) FILTER (WHERE coalesce(trim(${schema.observation.valueUnit}), '') <> '')::int`,
          withValue: sql<number>`count(*) FILTER (WHERE ${schema.observation.valueNumeric} IS NOT NULL OR coalesce(trim(${schema.observation.valueText}), '') <> '')::int`,
          coded: sql<number>`count(*) FILTER (WHERE coalesce(trim(${schema.observation.code}), '') <> '')::int`,
        })
        .from(schema.observation)
        .innerJoin(schema.encounter, eq(schema.encounter.id, schema.observation.encounterId))
        .where(inRange);

      const [medications] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          catalogued: sql<number>`count(*) FILTER (WHERE ${schema.medicationRequest.catalogueItemId} IS NOT NULL)::int`,
          withMolecule: sql<number>`count(*) FILTER (WHERE coalesce(trim(${schema.medicationRequest.moleculeName}), '') <> '')::int`,
          withDuration: sql<number>`count(*) FILTER (WHERE ${schema.medicationRequest.durationDays} IS NOT NULL)::int`,
        })
        .from(schema.medicationRequest)
        .innerJoin(
          schema.encounter,
          eq(schema.encounter.id, schema.medicationRequest.encounterId),
        )
        .where(inRange);

      /*
       * Demographic completeness, over the whole registry rather than the window.
       *
       * A patient registered three years ago with no date of birth still weakens
       * every age-banded cohort today, so restricting this to the window would hide
       * the problem behind recent good practice.
       */
      const [patients] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          withDob: sql<number>`count(*) FILTER (WHERE ${schema.patient.dateOfBirth} IS NOT NULL)::int`,
          withAnyAge: sql<number>`count(*) FILTER (WHERE ${schema.patient.dateOfBirth} IS NOT NULL OR ${schema.patient.ageYears} IS NOT NULL)::int`,
          withGender: sql<number>`count(*) FILTER (WHERE ${schema.patient.gender} <> 'UNKNOWN')::int`,
          withMobile: sql<number>`count(*) FILTER (WHERE coalesce(trim(${schema.patient.mobileE164}), '') <> '')::int`,
        })
        .from(schema.patient)
        .where(eq(schema.patient.isActive, true));

      /* Duplicates still waiting to be resolved, which inflate every patient count. */
      const [merges] = await tx
        .select({ merged: sql<number>`count(*)::int` })
        .from(schema.patient)
        .where(sql`${schema.patient.mergedIntoPatientId} IS NOT NULL`);

      const metrics: DataQualityMetric[] = [
        metric({
          key: 'encounters-finalised',
          label: 'Consultations signed',
          definition:
            'Consultations in the period marked finalised. An unsigned consultation is excluded from every cohort, so a low figure here means analysis is running on less data than the clinic thinks.',
          numerator: encounters?.finalised ?? 0,
          denominator: encounters?.total ?? 0,
          higherIsBetter: true,
        }),
        metric({
          key: 'diagnoses-coded',
          label: 'Diagnoses carrying a code',
          definition:
            'Conditions recorded with a code rather than free text only. Cohorts filter on codes, so uncoded diagnoses are invisible to every analysis.',
          numerator: conditions?.coded ?? 0,
          denominator: conditions?.total ?? 0,
          higherIsBetter: true,
        }),
        metric({
          key: 'coding-system-named',
          label: 'Codes with a named system',
          definition:
            'Coded conditions that also record which system the code belongs to (ICD-10, SNOMED CT). A code without its system cannot be safely compared with anyone else’s data.',
          numerator: conditions?.withSystem ?? 0,
          denominator: conditions?.coded ?? 0,
          higherIsBetter: true,
        }),
        metric({
          key: 'observations-with-unit',
          label: 'Measurements with a unit',
          definition:
            'Numeric observations recording the unit of measure. A blood pressure of 120 with no unit is not a measurement, and a range filter over mixed units is meaningless.',
          numerator: observations?.withUnit ?? 0,
          denominator: observations?.total ?? 0,
          higherIsBetter: true,
        }),
        metric({
          key: 'observations-with-value',
          label: 'Measurements with a value',
          definition:
            'Observations carrying either a number or text. An observation with neither is a row that records that something was looked at and not what was found.',
          numerator: observations?.withValue ?? 0,
          denominator: observations?.total ?? 0,
          higherIsBetter: true,
        }),
        metric({
          key: 'prescriptions-catalogued',
          label: 'Prescriptions linked to the catalogue',
          definition:
            'Medication orders linked to a catalogue entry rather than typed as free text. Unlinked orders cannot be grouped by molecule, so treatment-pattern analysis under-counts them.',
          numerator: medications?.catalogued ?? 0,
          denominator: medications?.total ?? 0,
          higherIsBetter: true,
        }),
        metric({
          key: 'prescriptions-with-duration',
          label: 'Prescriptions with a duration',
          definition:
            'Medication orders stating how many days to take it for. Without it, adherence and quantity cannot be derived at all.',
          numerator: medications?.withDuration ?? 0,
          denominator: medications?.total ?? 0,
          higherIsBetter: true,
        }),
        metric({
          key: 'patients-with-age',
          label: 'Patients with an age or date of birth',
          definition:
            'Active patients from whom an age can be derived. Patients without one fall into the UNKNOWN band and weaken every age-stratified result.',
          numerator: patients?.withAnyAge ?? 0,
          denominator: patients?.total ?? 0,
          higherIsBetter: true,
        }),
        metric({
          key: 'patients-with-exact-dob',
          label: 'Patients with an exact date of birth',
          definition:
            'Active patients with a real date of birth rather than an estimated age. Estimated ages drift by up to a year and blur band boundaries.',
          numerator: patients?.withDob ?? 0,
          denominator: patients?.total ?? 0,
          higherIsBetter: true,
        }),
        metric({
          key: 'patients-with-sex',
          label: 'Patients with sex recorded',
          definition:
            'Active patients whose administrative sex is not UNKNOWN. Required for any sex-stratified analysis.',
          numerator: patients?.withGender ?? 0,
          denominator: patients?.total ?? 0,
          higherIsBetter: true,
        }),
        metric({
          key: 'duplicates-merged',
          label: 'Records merged as duplicates',
          definition:
            'Patient records merged into another. A count rather than a rate: it is context for the registry size, not a failure. A rising figure with no registration growth suggests a registration process creating duplicates.',
          numerator: merges?.merged ?? 0,
          denominator: patients?.total ?? 0,
          higherIsBetter: false,
        }),
      ];

      return {
        generatedAt: new Date().toISOString(),
        rangeFrom: from,
        rangeTo: to,
        metrics,
        fieldCompleteness: [
          field('Patient', 'date_of_birth', patients?.withDob ?? 0, patients?.total ?? 0),
          field('Patient', 'gender', patients?.withGender ?? 0, patients?.total ?? 0),
          field('Patient', 'mobile', patients?.withMobile ?? 0, patients?.total ?? 0),
          field(
            'Encounter',
            'chief_complaint',
            encounters?.withComplaint ?? 0,
            encounters?.total ?? 0,
          ),
          field(
            'Encounter',
            'assessment_notes',
            encounters?.withAssessment ?? 0,
            encounters?.total ?? 0,
          ),
          field('Encounter', 'plan_notes', encounters?.withPlan ?? 0, encounters?.total ?? 0),
          field(
            'Encounter',
            'follow_up_after_days',
            encounters?.withFollowUp ?? 0,
            encounters?.total ?? 0,
          ),
          field('Condition', 'code', conditions?.coded ?? 0, conditions?.total ?? 0),
          field('Condition', 'code_system', conditions?.withSystem ?? 0, conditions?.total ?? 0),
          field('Observation', 'code', observations?.coded ?? 0, observations?.total ?? 0),
          field('Observation', 'value_unit', observations?.withUnit ?? 0, observations?.total ?? 0),
          field(
            'MedicationRequest',
            'catalogue_item_id',
            medications?.catalogued ?? 0,
            medications?.total ?? 0,
          ),
          field(
            'MedicationRequest',
            'molecule_name',
            medications?.withMolecule ?? 0,
            medications?.total ?? 0,
          ),
          field(
            'MedicationRequest',
            'duration_days',
            medications?.withDuration ?? 0,
            medications?.total ?? 0,
          ),
        ],
      };
    });
  }

  /**
   * The data dictionary.
   *
   * Served from the API rather than kept in a document, because a dictionary that
   * lives elsewhere describes last year's schema. It is also the cheapest possible
   * defence against a specific misreading: `age_years` is an ESTIMATE captured at
   * registration, not a derived figure, and an analyst who assumes otherwise will
   * quietly produce wrong age bands.
   *
   * `availableToAnalyst` is stated rather than implied. Being told plainly that
   * `full_name` exists and is not reachable is more useful than a list with a hole
   * in it, which invites someone to go looking for the endpoint.
   */
  dictionary(): DictionaryEntry[] {
    return [
      {
        entity: 'Patient',
        field: 'age_band',
        type: 'enum',
        definition:
          'Age grouped into fixed bands. Derived from date_of_birth where present, otherwise from the estimated age_years captured at registration.',
        codingSystem: null,
        unit: 'years',
        nullable: false,
        absenceMeaning: 'UNKNOWN means no age could be derived at all.',
        availableToAnalyst: true,
      },
      {
        entity: 'Patient',
        field: 'age_years',
        type: 'integer',
        definition:
          'An ESTIMATED age recorded at registration, used when no date of birth is known. It is not recomputed as the patient ages, so it is only reliable relative to the registration date.',
        codingSystem: null,
        unit: 'years',
        nullable: true,
        absenceMeaning: 'A date of birth was captured instead, or neither was.',
        availableToAnalyst: false,
      },
      {
        entity: 'Patient',
        field: 'sex',
        type: 'enum',
        definition:
          'Administrative sex per FHIR administrative-gender. Not gender identity, and not clinical sex.',
        codingSystem: 'FHIR administrative-gender',
        unit: null,
        nullable: false,
        absenceMeaning: 'UNKNOWN is common in walk-in registration and is recorded, not guessed.',
        availableToAnalyst: true,
      },
      {
        entity: 'Patient',
        field: 'full_name / mobile / mrn / date_of_birth',
        type: 'text',
        definition:
          'Identifying fields. They exist on the record and are NOT reachable from this panel: the analyst role holds no patient-read permission, so no endpoint returns them.',
        codingSystem: null,
        unit: null,
        nullable: false,
        absenceMeaning: null,
        availableToAnalyst: false,
      },
      {
        entity: 'Encounter',
        field: 'started_at',
        type: 'timestamptz',
        definition:
          'When the consultation began. Cohorts filter on this. Exposed to analysts at MONTH precision only — a date combined with an age band is close to an identity at a clinic this size.',
        codingSystem: null,
        unit: null,
        nullable: false,
        absenceMeaning: null,
        availableToAnalyst: true,
      },
      {
        entity: 'Encounter',
        field: 'is_finalized',
        type: 'boolean',
        definition:
          'Whether the clinician has signed the consultation. Cohorts include finalised encounters only, so an unsigned consultation is invisible to analysis.',
        codingSystem: null,
        unit: null,
        nullable: false,
        absenceMeaning: null,
        availableToAnalyst: true,
      },
      {
        entity: 'Encounter',
        field: 'consultation_mode',
        type: 'enum',
        definition: 'IN_PERSON or TELECONSULTATION. Affects which prescribing rules applied.',
        codingSystem: null,
        unit: null,
        nullable: false,
        absenceMeaning: null,
        availableToAnalyst: true,
      },
      {
        entity: 'Encounter',
        field: 'follow_up_after_days',
        type: 'integer',
        definition:
          'The interval the clinician asked the patient to return within, in days. Follow-up completion is derived by checking for a later visit on or after started_at plus this interval.',
        codingSystem: null,
        unit: 'days',
        nullable: true,
        absenceMeaning:
          'No follow-up was requested. This is NOT the same as a follow-up that was requested and missed, and the two are counted separately.',
        availableToAnalyst: true,
      },
      {
        entity: 'Condition',
        field: 'code',
        type: 'text',
        definition:
          'The diagnosis code. Cohorts filter on this and not on display text, so an uncoded condition cannot be selected for.',
        codingSystem: 'ICD-10 or as recorded in code_system',
        unit: null,
        nullable: true,
        absenceMeaning:
          'The diagnosis was recorded as free text only. Check the coding-completeness metric before drawing conclusions from any diagnosis filter.',
        availableToAnalyst: true,
      },
      {
        entity: 'Observation',
        field: 'value_numeric',
        type: 'numeric',
        definition:
          'The measured value. Always read with value_unit: the same code may be recorded in different units by different staff.',
        codingSystem: null,
        unit: 'see value_unit',
        nullable: true,
        absenceMeaning: 'The result was textual, or was not recorded.',
        availableToAnalyst: true,
      },
      {
        entity: 'MedicationRequest',
        field: 'molecule_name',
        type: 'text',
        definition:
          'The generic name. Treatment-pattern analysis groups on this, never on brand — a cohort by brand is a commercial question rather than a clinical one.',
        codingSystem: null,
        unit: null,
        nullable: true,
        absenceMeaning:
          'The prescription was typed freehand without a catalogue link. Such orders are missing from every molecule-based count.',
        availableToAnalyst: true,
      },
      {
        entity: 'Cohort',
        field: 'subject_key',
        type: 'text',
        definition:
          'A pseudonym for a patient, salted with the cohort id. Stable within one cohort and deliberately NOT stable across cohorts, so two extracts cannot be joined on it to narrow someone down.',
        codingSystem: null,
        unit: null,
        nullable: false,
        absenceMeaning: null,
        availableToAnalyst: true,
      },
    ];
  }
}

/**
 * A metric with its verdict.
 *
 * The thresholds are 90% and 70%, and they are conventions rather than findings —
 * stated here so the screen can be read without arithmetic, and named in the API
 * so nobody has to reverse-engineer them from a colour.
 */
function metric(input: {
  key: string;
  label: string;
  definition: string;
  numerator: number;
  denominator: number;
  higherIsBetter: boolean;
}): DataQualityMetric {
  const percent =
    input.denominator > 0 ? Math.round((input.numerator / input.denominator) * 100) : null;

  const verdict: DataQualityMetric['verdict'] =
    percent === null
      ? 'unknown'
      : input.higherIsBetter
        ? percent >= 90
          ? 'good'
          : percent >= 70
            ? 'watch'
            : 'poor'
        : percent <= 2
          ? 'good'
          : percent <= 5
            ? 'watch'
            : 'poor';

  return { ...input, percent, verdict };
}

function field(entity: string, name: string, present: number, total: number) {
  return {
    entity,
    field: name,
    present,
    total,
    percent: total > 0 ? Math.round((present / total) * 100) : 0,
  };
}
