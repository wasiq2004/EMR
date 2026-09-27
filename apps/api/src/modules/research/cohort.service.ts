import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import {
  SMALL_CELL_THRESHOLD,
  bandFor,
  subjectKey,
  suppress,
  type Cohort,
  type CohortFilters,
  type CohortRow,
  type CohortSummary,
  type SaveCohort,
} from '@emr/contracts';

import { TenantDb, type TenantTx } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';

/**
 * Cohorts.
 *
 * A COHORT IS A SAVED QUESTION, NOT A SAVED ANSWER. The filters are stored and
 * re-evaluated against live data on every read, so a cohort defined in March still
 * means the same thing in September and its count legitimately differs.
 * Materialising the member list would create the one thing this role exists to
 * prevent: a stored set of identified patients sitting outside the clinical
 * tables, with its own lifecycle and its own way of being forgotten about.
 *
 * DE-IDENTIFICATION IS THE PROJECTION, NOT A SETTING. Every method here selects
 * age, sex, codes and counts. None of them selects a name, a mobile number, an
 * MRN or a date of birth, and the RESEARCH_ANALYST role holds no `patient:read`
 * permission, so there is no other endpoint that would. There is no flag to turn
 * off, because there is no privileged path to turn on.
 *
 * SMALL CELLS ARE SUPPRESSED, AND THE SUPPRESSION IS DISCLOSED. A breakdown cell
 * with fewer than five subjects comes back null with a count of how many were
 * suppressed. Returning zero instead would be a false statement about the data,
 * and returning the number would name people — at a clinic this size, "one woman
 * aged 75+ with this diagnosis last March" is an identity.
 */
@Injectable()
export class CohortService {
  constructor(private readonly tenantDb: TenantDb) {}

  /* ---- Saved definitions -------------------------------------------------- */

  async list(): Promise<Cohort[]> {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select()
        .from(schema.analystCohort)
        .orderBy(desc(schema.analystCohort.updatedAt))
        .limit(200),
    );
    return rows.map(serialise);
  }

  async byId(id: string): Promise<Cohort> {
    const [row] = await this.tenantDb.runReadOnly((tx) =>
      tx.select().from(schema.analystCohort).where(eq(schema.analystCohort.id, id)).limit(1),
    );
    if (!row) throw new NotFoundException('That cohort could not be found.');
    return serialise(row);
  }

  async save(input: SaveCohort & { id?: string }): Promise<Cohort> {
    const ctx = TenantContext.require();

    if (input.filters.from > input.filters.to) {
      throw new ConflictException('The start of the range is after the end of it.');
    }

    const row = await this.tenantDb.run(async (tx) => {
      if (input.id) {
        const [current] = await tx
          .select()
          .from(schema.analystCohort)
          .where(eq(schema.analystCohort.id, input.id))
          .limit(1);
        if (!current) throw new NotFoundException('That cohort could not be found.');

        /*
         * The version bumps only when the FILTERS change.
         *
         * Renaming a cohort or sharing it does not alter what it means, and
         * bumping the version for it would make an export's provenance stamp
         * useless — every figure would appear to come from a different definition
         * than the one that produced it.
         */
        const filtersChanged =
          JSON.stringify(current.filters) !== JSON.stringify(input.filters);

        const [updated] = await tx
          .update(schema.analystCohort)
          .set({
            name: input.name.trim(),
            purpose: input.purpose.trim(),
            filters: input.filters as never,
            definitionVersion: filtersChanged
              ? current.definitionVersion + 1
              : current.definitionVersion,
            isShared: input.isShared,
            chartConfig: (input.chartConfig ?? null) as never,
            updatedBy: ctx.userId,
          })
          .where(eq(schema.analystCohort.id, input.id))
          .returning();
        return updated!;
      }

      const [created] = await tx
        .insert(schema.analystCohort)
        .values({
          clinicId: ctx.clinicId,
          name: input.name.trim(),
          purpose: input.purpose.trim(),
          filters: input.filters as never,
          definitionVersion: 1,
          isShared: input.isShared,
          chartConfig: (input.chartConfig ?? null) as never,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning()
        .catch((error: Error) => {
          if (/analyst_cohort_clinic_name_uq/.test(error.message)) {
            throw new ConflictException(
              `A cohort called "${input.name.trim()}" already exists. Open it rather than creating a second.`,
            );
          }
          throw error;
        });
      return created!;
    });

    return serialise(row);
  }

  async remove(id: string) {
    return this.tenantDb.run(async (tx) => {
      const deleted = await tx
        .delete(schema.analystCohort)
        .where(eq(schema.analystCohort.id, id))
        .returning({ id: schema.analystCohort.id });

      if (deleted.length === 0) {
        throw new NotFoundException('That cohort could not be found.');
      }
      /*
       * Exports keep working. `analyst_export.cohort_id` is ON DELETE SET NULL
       * and the export carries a copy of the name and the filters, so a figure
       * quoted in a report stays traceable after the cohort it came from is gone.
       */
      return { deleted: true };
    });
  }

  /* ---- Evaluation --------------------------------------------------------- */

  /**
   * Runs a cohort and returns its de-identified rows.
   *
   * ONE QUERY SHAPE for both the saved and the ad-hoc case, so a saved cohort
   * cannot behave differently from the preview that produced it — which would make
   * the preview worthless.
   */
  async evaluate(
    filters: CohortFilters,
    options: { cohortId?: string; salt?: string } = {},
  ): Promise<{ rows: CohortRow[]; summary: CohortSummary }> {
    /*
     * The salt.
     *
     * A saved cohort salts with its own id, so its keys are stable across runs and
     * an analyst can follow a subject between two evaluations of the SAME question.
     * An ad-hoc preview salts with the filters, so it is stable within one preview
     * and unrelated to any saved cohort's keys.
     */
    const salt =
      options.salt ?? options.cohortId ?? JSON.stringify(filters);

    const raw = await this.tenantDb.runReadOnly(async (tx) => {
      const encounterIds = await this.matchingEncounters(tx, filters);
      if (encounterIds.length === 0) return { subjects: [], encounters: [] };

      /*
       * The de-identified projection.
       *
       * READ THE SELECT LIST. `age_years`, `date_of_birth` (used only to derive an
       * age, then discarded), gender, and nothing else about the person. No
       * `full_name`, no `mobile`, no `mrn`.
       */
      const encounters = await tx
        .select({
          encounterId: schema.encounter.id,
          patientId: schema.encounter.patientId,
          startedAt: schema.encounter.startedAt,
          ageYears: schema.patient.ageYears,
          dateOfBirth: schema.patient.dateOfBirth,
          gender: schema.patient.gender,
          // Days, not a date: the schema stores the interval the clinician asked
          // for, which is how a doctor actually writes it ("review in 2 weeks").
          followUpAfterDays: schema.encounter.followUpAfterDays,
        })
        .from(schema.encounter)
        .innerJoin(schema.patient, eq(schema.patient.id, schema.encounter.patientId))
        .where(inArray(schema.encounter.id, encounterIds));

      const patientIds = [...new Set(encounters.map((e) => e.patientId))];

      const diagnoses = await tx
        .select({
          patientId: schema.condition.patientId,
          code: schema.condition.code,
          display: schema.condition.displayText,
        })
        .from(schema.condition)
        .where(
          and(
            inArray(schema.condition.patientId, patientIds),
            sql`${schema.condition.code} IS NOT NULL`,
          ),
        );

      const medications = await tx
        .select({
          patientId: schema.medicationRequest.patientId,
          molecule: schema.medicationRequest.moleculeName,
        })
        .from(schema.medicationRequest)
        .where(
          and(
            inArray(schema.medicationRequest.encounterId, encounterIds),
            sql`${schema.medicationRequest.moleculeName} IS NOT NULL`,
          ),
        );

      /* Did the patient come back after a follow-up was asked for? */
      const returns = await tx
        .select({
          patientId: schema.encounter.patientId,
          startedAt: schema.encounter.startedAt,
        })
        .from(schema.encounter)
        .where(inArray(schema.encounter.patientId, patientIds));

      return { subjects: encounters, encounters, diagnoses, medications, returns };
    });

    if (raw.subjects.length === 0) {
      return {
        rows: [],
        summary: emptySummary(options.cohortId ?? null),
      };
    }

    /* ---- Fold encounters into subjects ---------------------------------- */

    interface Subject {
      patientId: string;
      ageBand: ReturnType<typeof bandFor>;
      sex: 'MALE' | 'FEMALE' | 'OTHER' | 'UNKNOWN';
      encounters: Date[];
      /** The date a return visit was expected by, derived from the interval. */
      followUpDueBy: Date | null;
      diagnosisCodes: Set<string>;
      molecules: Set<string>;
    }

    const subjects = new Map<string, Subject>();

    for (const row of raw.subjects) {
      const existing = subjects.get(row.patientId);
      const age = ageFrom(row.ageYears, row.dateOfBirth);

      if (existing) {
        existing.encounters.push(row.startedAt);
        const due = dueDate(row.startedAt, row.followUpAfterDays);
        if (due && !existing.followUpDueBy) existing.followUpDueBy = due;
        continue;
      }

      subjects.set(row.patientId, {
        patientId: row.patientId,
        ageBand: bandFor(age),
        sex: (row.gender ?? 'UNKNOWN') as Subject['sex'],
        encounters: [row.startedAt],
        followUpDueBy: dueDate(row.startedAt, row.followUpAfterDays),
        diagnosisCodes: new Set(),
        molecules: new Set(),
      });
    }

    const diagnosisDisplay = new Map<string, string>();
    for (const row of raw.diagnoses ?? []) {
      if (!row.code) continue;
      subjects.get(row.patientId)?.diagnosisCodes.add(row.code);
      if (row.display) diagnosisDisplay.set(row.code, row.display);
    }
    for (const row of raw.medications ?? []) {
      if (!row.molecule) continue;
      subjects.get(row.patientId)?.molecules.add(row.molecule.toLowerCase());
    }

    /* Follow-up completion: any visit on or after the date that was asked for. */
    const visitsBy = new Map<string, Date[]>();
    for (const row of raw.returns ?? []) {
      const list = visitsBy.get(row.patientId) ?? [];
      list.push(row.startedAt);
      visitsBy.set(row.patientId, list);
    }

    /*
     * The post-projection filters.
     *
     * Age band and minimum-encounter count are applied HERE rather than in SQL,
     * and deliberately so: the band depends on `age_years` OR an age derived from
     * `date_of_birth`, and that precedence already exists once in `bandFor`. A
     * second implementation in SQL is a second chance to disagree, and the
     * disagreement would surface as a cohort whose size does not match its own age
     * breakdown — which is worse than a slower query.
     *
     * Both are genuinely applied. A filter that parsed and then did nothing would
     * return a wider cohort than its definition claims, which is the failure the
     * strict filter schema exists to prevent.
     */
    let selected = [...subjects.values()];

    if (filters.ageBands?.length) {
      const wanted = new Set(filters.ageBands);
      selected = selected.filter((s) => wanted.has(s.ageBand));
    }

    if (filters.minEncounters) {
      selected = selected.filter((s) => s.encounters.length >= filters.minEncounters!);
    }

    const minEncountersFiltered = selected;

    const rows: CohortRow[] = minEncountersFiltered.map((subject) => {
      const sorted = [...subject.encounters].sort((a, b) => a.getTime() - b.getTime());
      /*
       * Completed means a visit ON OR AFTER the date the clinician asked for, not
       * merely any later visit. A patient told to come back in two weeks who turns
       * up the next day with something unrelated has not completed the follow-up,
       * and counting it would flatter the rate.
       */
      const followUpCompleted = subject.followUpDueBy
        ? (visitsBy.get(subject.patientId) ?? []).some(
            (visit) => visit >= subject.followUpDueBy!,
          )
        : null;

      return {
        subjectKey: subjectKey(subject.patientId, salt),
        ageBand: subject.ageBand,
        sex: subject.sex,
        encounterCount: sorted.length,
        firstEncounterMonth: monthOf(sorted[0]!),
        lastEncounterMonth: monthOf(sorted[sorted.length - 1]!),
        diagnosisCodes: [...subject.diagnosisCodes].sort(),
        medicationMolecules: [...subject.molecules].sort(),
        followUpCompleted,
      };
    });

    return {
      rows,
      summary: this.summarise(rows, diagnosisDisplay, options.cohortId ?? null),
    };
  }

  /** Evaluates a saved cohort and caches its headline size for the list screen. */
  async evaluateSaved(id: string) {
    const cohort = await this.byId(id);
    const result = await this.evaluate(cohort.filters, {
      cohortId: id,
      salt: id,
    });

    await this.tenantDb.run((tx) =>
      tx
        .update(schema.analystCohort)
        .set({ lastEvaluatedAt: new Date(), lastEvaluatedSize: result.rows.length })
        .where(eq(schema.analystCohort.id, id)),
    );

    return {
      ...result,
      summary: { ...result.summary, definitionVersion: cohort.definitionVersion },
    };
  }

  /* ---- Internals ---------------------------------------------------------- */

  /**
   * Which encounters match the filters.
   *
   * Resolved to a list of ids first, then projected, so the filter logic lives in
   * one place and the projection cannot accidentally widen it. Capped: an
   * unbounded cohort over a long-running clinic is a query nobody meant to run.
   */
  private async matchingEncounters(tx: TenantTx, filters: CohortFilters): Promise<string[]> {
    const conditions = [
      sql`${schema.encounter.startedAt} >= ${filters.from}::date`,
      sql`${schema.encounter.startedAt} < (${filters.to}::date + interval '1 day')`,
      /*
       * FINALISED ENCOUNTERS ONLY.
       *
       * A draft is a consultation in progress. Including them would make every
       * count move as doctors typed, and would report as findings things no
       * clinician has yet committed to.
       */
      eq(schema.encounter.isFinalized, true),
    ];

    if (filters.consultationModes?.length) {
      conditions.push(
        inArray(schema.encounter.consultationMode, filters.consultationModes as never),
      );
    }
    if (filters.practitionerIds?.length) {
      conditions.push(inArray(schema.encounter.practitionerId, filters.practitionerIds));
    }
    if (filters.locationIds?.length) {
      conditions.push(inArray(schema.encounter.locationId, filters.locationIds));
    }

    /* Demographic filters apply to the patient behind the encounter. */
    if (filters.sexes?.length) {
      conditions.push(inArray(schema.patient.gender, filters.sexes as never));
    }

    if (filters.diagnosisCodes?.length) {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${schema.condition}
          WHERE ${schema.condition.patientId} = ${schema.encounter.patientId}
            AND ${schema.condition.code} IN ${sql`(${sql.join(
              filters.diagnosisCodes.map((c) => sql`${c}`),
              sql`, `,
            )})`}
        )`,
      );
    }

    if (filters.medicationMolecules?.length) {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${schema.medicationRequest}
          WHERE ${schema.medicationRequest.encounterId} = ${schema.encounter.id}
            AND lower(${schema.medicationRequest.moleculeName}) IN ${sql`(${sql.join(
              filters.medicationMolecules.map((m) => sql`${m.toLowerCase()}`),
              sql`, `,
            )})`}
        )`,
      );
    }

    if (filters.observation) {
      const { code, min, max } = filters.observation;
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${schema.observation} o
          WHERE o.encounter_id = ${schema.encounter.id}
            AND o.code = ${code}
            ${min !== undefined ? sql`AND o.value_numeric >= ${min}` : sql``}
            ${max !== undefined ? sql`AND o.value_numeric <= ${max}` : sql``}
        )`,
      );
    }

    const rows = await tx
      .select({ id: schema.encounter.id })
      .from(schema.encounter)
      .innerJoin(schema.patient, eq(schema.patient.id, schema.encounter.patientId))
      .where(and(...conditions))
      .orderBy(asc(schema.encounter.startedAt))
      .limit(20_000);

    // Age bands are applied after projection — see the note in `evaluate`.
    return rows.map((r) => r.id);
  }

  /** Breakdowns, with every cell below the threshold suppressed. */
  private summarise(
    rows: CohortRow[],
    diagnosisDisplay: Map<string, string>,
    cohortId: string | null,
  ): CohortSummary {
    let suppressed = 0;
    const cell = (count: number): number | null => {
      const value = suppress(count);
      if (value === null) suppressed += 1;
      return value;
    };

    const byBand = new Map<string, number>();
    const bySex = new Map<string, number>();
    const byMonth = new Map<string, { patients: number; encounters: number; newPatients: number }>();
    const byDiagnosis = new Map<string, number>();
    const byMolecule = new Map<string, number>();

    let followUpInstructed = 0;
    let followUpCompleted = 0;
    let encounterTotal = 0;

    for (const row of rows) {
      byBand.set(row.ageBand, (byBand.get(row.ageBand) ?? 0) + 1);
      bySex.set(row.sex, (bySex.get(row.sex) ?? 0) + 1);
      encounterTotal += row.encounterCount;

      const first = byMonth.get(row.firstEncounterMonth) ?? {
        patients: 0,
        encounters: 0,
        newPatients: 0,
      };
      first.newPatients += 1;
      byMonth.set(row.firstEncounterMonth, first);

      const last = byMonth.get(row.lastEncounterMonth) ?? {
        patients: 0,
        encounters: 0,
        newPatients: 0,
      };
      last.patients += 1;
      last.encounters += row.encounterCount;
      byMonth.set(row.lastEncounterMonth, last);

      for (const code of row.diagnosisCodes) {
        byDiagnosis.set(code, (byDiagnosis.get(code) ?? 0) + 1);
      }
      for (const molecule of row.medicationMolecules) {
        byMolecule.set(molecule, (byMolecule.get(molecule) ?? 0) + 1);
      }

      if (row.followUpCompleted !== null) {
        followUpInstructed += 1;
        if (row.followUpCompleted) followUpCompleted += 1;
      }
    }

    const summary = {
      cohortId,
      /* The TOTAL is not suppressed: knowing a cohort has three members discloses
       * nothing. Knowing which three does, and that is what the cells protect. */
      size: rows.length,
      encounterCount: encounterTotal,
      generatedAt: new Date().toISOString(),
      definitionVersion: 1,
      smallCellThreshold: SMALL_CELL_THRESHOLD,
      byAgeBand: [...byBand.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([band, count]) => ({ band: band as never, count: cell(count) })),
      bySex: [...bySex.entries()].map(([sex, count]) => ({ sex, count: cell(count) })),
      byMonth: [...byMonth.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, v]) => ({
          month,
          patients: cell(v.patients),
          encounters: cell(v.encounters),
          newPatients: cell(v.newPatients),
        })),
      topDiagnoses: [...byDiagnosis.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([code, count]) => ({
          code,
          display: diagnosisDisplay.get(code) ?? code,
          count: cell(count),
        })),
      topMolecules: [...byMolecule.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([molecule, count]) => ({ molecule, count: cell(count) })),
      followUp: {
        instructed: followUpInstructed,
        completed: followUpCompleted,
        /*
         * A rate on a tiny base is suppressed too.
         *
         * "100% follow-up" on a base of two is both meaningless and disclosive —
         * it says something definite about two identifiable people.
         */
        ratePercent:
          followUpInstructed >= SMALL_CELL_THRESHOLD
            ? Math.round((followUpCompleted / followUpInstructed) * 100)
            : null,
      },
    };

    /*
     * Counted after every cell has been built, then attached.
     *
     * It has to be this way round: `cell()` increments the counter as it goes, so
     * reading the total in the middle of the object literal would report however
     * many cells happened to be evaluated first. Property order in an object
     * literal is not an evaluation guarantee anyone should rely on.
     */
    return { ...summary, suppressedCellCount: suppressed } satisfies CohortSummary;
  }
}

function serialise(row: typeof schema.analystCohort.$inferSelect): Cohort {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    filters: row.filters as never,
    definitionVersion: row.definitionVersion,
    isShared: row.isShared,
    chartConfig: (row.chartConfig ?? null) as never,
    lastEvaluatedAt: row.lastEvaluatedAt?.toISOString() ?? null,
    lastEvaluatedSize: row.lastEvaluatedSize,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function emptySummary(cohortId: string | null): CohortSummary {
  return {
    cohortId,
    size: 0,
    encounterCount: 0,
    generatedAt: new Date().toISOString(),
    definitionVersion: 1,
    smallCellThreshold: SMALL_CELL_THRESHOLD,
    suppressedCellCount: 0,
    byAgeBand: [],
    bySex: [],
    byMonth: [],
    topDiagnoses: [],
    topMolecules: [],
    followUp: { instructed: 0, completed: 0, ratePercent: null },
  };
}

/** 'YYYY-MM'. Month precision, because a date plus a band is close to an identity. */
function monthOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function ageFrom(ageYears: number | null, dateOfBirth: string | null): number | null {
  if (dateOfBirth) {
    const dob = new Date(`${dateOfBirth}T00:00:00Z`);
    const now = new Date();
    let age = now.getUTCFullYear() - dob.getUTCFullYear();
    const month = now.getUTCMonth() - dob.getUTCMonth();
    if (month < 0 || (month === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
    return age;
  }
  return ageYears;
}

/**
 * When a return visit was expected by.
 *
 * The schema stores an interval in days because that is how a clinician writes it
 * — "review in two weeks" — so the date has to be derived from the visit it was
 * said at. Null means no follow-up was asked for, which is different from one that
 * was asked for and missed, and the two must not collapse into each other.
 */
function dueDate(startedAt: Date, followUpAfterDays: number | null): Date | null {
  if (!followUpAfterDays || followUpAfterDays <= 0) return null;
  return new Date(startedAt.getTime() + followUpAfterDays * 86_400_000);
}
