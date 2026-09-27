/**
 * Governed analytics.
 *
 * TWO TABLES, and the smallness is the design. A cohort is a SAVED QUESTION, not
 * a saved answer: the filters are stored and re-evaluated against live data
 * every time, so a cohort defined in March still means the same thing in
 * September and the count legitimately differs. Materialising the member list
 * would create exactly the thing this role is built to prevent — a stored set of
 * identified patients sitting outside the clinical tables.
 *
 * WHAT IS NOT HERE, DELIBERATELY:
 *
 *   - No cohort_member table. See above. The projection that answers a cohort
 *     query selects age bands and codes; there is no column in it that names a
 *     person, so there is nothing worth storing.
 *   - No data_quality_metric table. Missingness and coding completeness are
 *     computed on read. A stored metric is stale the moment a doctor saves a
 *     note, and a data-quality figure that is quietly out of date is worse than
 *     no figure, because someone will act on it.
 *   - No separate analyst audit table. `audit_event` already records every
 *     request with actor, action and outcome, and a second log would be a second
 *     thing to keep consistent.
 *
 * The privacy guarantee lives in `packages/contracts/src/rbac.ts`, not here: the
 * RESEARCH_ANALYST role holds no `patient:read`, so no endpoint reachable with
 * that session returns a name, a mobile number, an MRN or a date of birth. This
 * file only has to avoid undoing that, which it does by storing definitions and
 * never results.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { auditColumns, clinicIdColumn, primaryKeyColumn, tenantPolicy } from './shared';
import { appUser, clinic } from './tenancy';

/**
 * A saved cohort definition.
 *
 * `filters` is JSONB rather than columns because the filter set is the part most
 * likely to grow — the blueprint's §7 list alone is age band, sex, date range,
 * diagnosis code, encounter type, facility and test-result range, and a clinic
 * doing its own audit will want one nobody anticipated. Columns would mean a
 * migration per question.
 *
 * It is validated on the way in against a Zod schema in `@emr/contracts`, so the
 * looseness is at rest rather than at the boundary: an unknown filter key is
 * rejected by the API, not silently ignored by the query builder. That matters
 * more than usual here, because a filter the evaluator does not understand would
 * WIDEN a cohort rather than narrow it, and a cohort that is quietly bigger than
 * its definition says is a governance failure rather than a bug.
 */
export const analystCohort = pgTable(
  'analyst_cohort',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    name: text('name').notNull(),
    /** Why this cohort exists. Required by the API, because "cohort 3" is not a purpose. */
    purpose: text('purpose').notNull(),

    filters: jsonb('filters').notNull().default(sql`'{}'::jsonb`),

    /**
     * Bumped on every change to `filters`.
     *
     * An export carries the version it ran against, so a figure quoted in a
     * report six months ago can be traced to the definition that produced it
     * rather than to whatever the cohort has since become.
     */
    definitionVersion: integer('definition_version').notNull().default(1),

    /**
     * Shared cohorts are visible to every analyst and owner at the clinic; the
     * default is private, because a half-built definition being read as finished
     * is how wrong numbers escape.
     */
    isShared: boolean('is_shared').notNull().default(false),

    /** Chart configuration for the explorer. Presentation only, never filtering. */
    chartConfig: jsonb('chart_config'),

    lastEvaluatedAt: timestamp('last_evaluated_at', { withTimezone: true }),
    /** Cached headline count, for the list screen. Recomputed on open. */
    lastEvaluatedSize: integer('last_evaluated_size'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),

    uniqueIndex('analyst_cohort_clinic_name_uq').on(t.clinicId, t.name),
    index('analyst_cohort_clinic_shared_idx').on(t.clinicId, t.isShared),
    tenantPolicy('analyst_cohort'),
  ],
).enableRLS();

/**
 * A de-identified export, and its provenance.
 *
 * The blueprint's §17.5 requirement is that an export carries the cohort
 * definition, the generation time and the source version. All three are columns
 * here rather than metadata in the file, so the record survives the file being
 * renamed, moved or emailed — which it will be.
 *
 * `definitionSnapshot` is a COPY of the filters as they were, not a reference to
 * the cohort. A cohort edited after an export must not retroactively change what
 * that export claims to have been.
 */
export const analystExport = pgTable(
  'analyst_export',
  {
    id: primaryKeyColumn(),
    clinicId: clinicIdColumn(),

    cohortId: uuid('cohort_id'),
    /** Denormalised: the cohort may be renamed or deleted; this must still read. */
    cohortName: text('cohort_name').notNull(),
    definitionSnapshot: jsonb('definition_snapshot').notNull(),
    definitionVersion: integer('definition_version').notNull(),

    /** 'COHORT_ROWS' | 'TREND_SERIES' | 'DATA_QUALITY'. */
    exportType: text('export_type').notNull(),
    /** 'PENDING' | 'READY' | 'FAILED' | 'EXPIRED'. */
    status: text('status').notNull().default('PENDING'),

    rowCount: integer('row_count'),
    /**
     * The columns actually written.
     *
     * Recorded so a reviewer can confirm no identifying column was in the file
     * without reading the file, which they may no longer be able to do.
     */
    columnsIncluded: jsonb('columns_included'),

    objectKey: text('object_key'),
    sizeBytes: integer('size_bytes'),

    requestedBy: uuid('requested_by'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    /**
     * Exports self-destruct.
     *
     * Even de-identified, a cohort extract accumulating in object storage
     * indefinitely is a liability with no owner. Same seven-day window as the
     * clinic's own export bundles.
     */
    downloadExpiresAt: timestamp('download_expires_at', { withTimezone: true }),

    failureReason: text('failure_reason'),

    ...auditColumns(),
  },
  (t) => [
    foreignKey({ columns: [t.clinicId], foreignColumns: [clinic.id] }).onDelete('restrict'),
    foreignKey({ columns: [t.cohortId], foreignColumns: [analystCohort.id] }).onDelete('set null'),
    foreignKey({ columns: [t.requestedBy], foreignColumns: [appUser.id] }).onDelete('set null'),

    index('analyst_export_clinic_requested_idx').on(t.clinicId, t.requestedAt.desc()),
    index('analyst_export_clinic_cohort_idx').on(t.clinicId, t.cohortId),
    tenantPolicy('analyst_export'),
  ],
).enableRLS();
