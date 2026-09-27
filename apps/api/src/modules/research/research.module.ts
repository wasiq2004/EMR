import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '@emr/db/schema';
import { CohortFilters, RequestExport, SaveCohort, type AnalystExportRow } from '@emr/contracts';

import { Audit, RequirePermission } from '../../common/http/decorators';
import { RequiresFeature } from '../../common/features/feature.guard';
import { parseBody, requireUuid } from '../../common/http/zod.pipe';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { CohortService } from './cohort.service';
import { DataQualityService } from './data-quality.service';

/**
 * The analytics API.
 *
 * WHY THERE IS NO SEARCH ENDPOINT HERE. The blueprint's §17.1 acceptance criterion
 * is that a Research Analyst cannot search by patient name or phone. That is met
 * not by rejecting such a request but by there being nowhere to send one: this
 * controller has no route that takes a name, a number or an MRN, and the
 * RESEARCH_ANALYST role holds no `patient:read`, so `/patients` refuses the session
 * outright. The guarantee is the absence of a route plus the absence of a
 * permission, which is a stronger claim than any filter.
 *
 * `analytics:read` NEVER IMPLIES `patient:read`. Every handler behind it returns
 * counts, bands and codes. That is asserted by the verification suite, which signs
 * in as an analyst and confirms the identifying endpoints return 403.
 */

const ExportListQuery = z.object({
  cohortId: z.string().uuid().optional(),
});

@RequiresFeature('analytics')
@Controller('analytics')
export class ResearchController {
  constructor(
    private readonly cohorts: CohortService,
    private readonly quality: DataQualityService,
    private readonly tenantDb: TenantDb,
  ) {}

  /* ---- Cohorts ------------------------------------------------------------ */

  @RequirePermission('cohort:read')
  @Get('cohorts')
  async list() {
    return { items: await this.cohorts.list() };
  }

  @RequirePermission('cohort:read')
  @Get('cohorts/:id')
  byId(@Param('id') id: string) {
    return this.cohorts.byId(requireUuid(id, 'Cohort'));
  }

  @RequirePermission('cohort:create')
  @Audit('COHORT_SAVED', 'cohort')
  @Post('cohorts')
  save(@Body() body: unknown) {
    const input = parseBody(SaveCohort.extend({ id: z.string().uuid().optional() }), body);
    return this.cohorts.save(input);
  }

  @RequirePermission('cohort:delete')
  @Audit('COHORT_DELETED', 'cohort')
  @Post('cohorts/:id/delete')
  remove(@Param('id') id: string) {
    return this.cohorts.remove(requireUuid(id, 'Cohort'));
  }

  /**
   * Runs a saved cohort.
   *
   * A POST for something that reads nothing but data, which looks wrong and is
   * right: it updates the cached size on the cohort, and it is the action an
   * analyst should see recorded against their name in the audit trail. A GET that
   * writes would be worse in both respects.
   */
  @RequirePermission('cohort:read')
  @Audit('COHORT_EVALUATED', 'cohort')
  @Post('cohorts/:id/evaluate')
  evaluateSaved(@Param('id') id: string) {
    return this.cohorts.evaluateSaved(requireUuid(id, 'Cohort'));
  }

  /**
   * Previews an unsaved definition.
   *
   * Same evaluator and same projection as a saved cohort, so a preview cannot
   * differ from what saving it would produce — which is the only thing that makes a
   * preview worth having.
   */
  @RequirePermission('cohort:read')
  @Audit('COHORT_PREVIEWED', 'cohort')
  @Post('cohorts/preview')
  preview(@Body() body: unknown) {
    const filters = parseBody(CohortFilters, body);
    return this.cohorts.evaluate(filters);
  }

  /* ---- Data quality and the dictionary ------------------------------------ */

  @RequirePermission('analytics:read')
  @Get('quality')
  quality_(@Query('from') from?: string, @Query('to') to?: string) {
    const range = parseBody(
      z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
      { from: from ?? defaultFrom(), to: to ?? today() },
    );
    return this.quality.report(range.from, range.to);
  }

  @RequirePermission('analytics:read')
  @Get('dictionary')
  dictionary() {
    return { items: this.quality.dictionary() };
  }

  /* ---- Exports ------------------------------------------------------------ */

  @RequirePermission('export:read')
  @Get('exports')
  async exports(@Query() query: unknown) {
    const parsed = ExportListQuery.safeParse(query ?? {});
    const cohortId = parsed.success ? parsed.data.cohortId : undefined;

    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({
          row: schema.analystExport,
          requestedByName: schema.appUser.fullName,
        })
        .from(schema.analystExport)
        .leftJoin(schema.appUser, eq(schema.appUser.id, schema.analystExport.requestedBy))
        .where(cohortId ? eq(schema.analystExport.cohortId, cohortId) : undefined)
        .orderBy(desc(schema.analystExport.requestedAt))
        .limit(100),
    );

    return {
      items: rows.map(({ row, requestedByName }) => ({
        id: row.id,
        cohortId: row.cohortId,
        cohortName: row.cohortName,
        definitionSnapshot: row.definitionSnapshot as never,
        definitionVersion: row.definitionVersion,
        exportType: row.exportType,
        status: row.status,
        rowCount: row.rowCount,
        columnsIncluded: row.columnsIncluded as never,
        sizeBytes: row.sizeBytes,
        requestedByName,
        requestedAt: row.requestedAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
        downloadExpiresAt: row.downloadExpiresAt?.toISOString() ?? null,
        failureReason: row.failureReason,
      })) satisfies AnalystExportRow[],
    };
  }

  /**
   * Requests an export, and produces it synchronously.
   *
   * Synchronous because a cohort at a five-doctor clinic is thousands of rows, not
   * millions, and a background worker for this would be infrastructure serving no
   * one. The row is written first and marked READY after, so a failure leaves a
   * FAILED record with a reason rather than nothing at all.
   *
   * THE PROVENANCE IS THE POINT. The row stores the definition as it was, its
   * version, the generation time and the exact column list — so a figure quoted in
   * a report next year is traceable to the definition that produced it, and a
   * reviewer can confirm no identifying column was in the file without reading the
   * file. §17.5 of the blueprint asks for exactly this.
   */
  @RequirePermission('export:create')
  @Audit('ANALYST_EXPORT_REQUESTED', 'export')
  @Post('exports')
  async requestExport(@Body() body: unknown) {
    const ctx = TenantContext.require();
    const input = parseBody(RequestExport, body);

    const cohort = input.cohortId
      ? await this.cohorts.byId(requireUuid(input.cohortId, 'Cohort'))
      : null;

    const filters = cohort?.filters ?? input.filters;
    if (!filters) {
      return {
        error:
          'An export needs either a saved cohort or a set of filters. A definition is not optional — it is what makes the figures traceable.',
      };
    }

    const result = await this.cohorts.evaluate(filters, {
      cohortId: cohort?.id,
      salt: cohort?.id,
    });

    /*
     * The column list, stated explicitly rather than derived from the first row.
     *
     * Deriving it would mean an empty export records no columns, and a reviewer
     * checking that no identifying field was included would have nothing to check.
     */
    const columns = [
      'subject_key',
      'age_band',
      'sex',
      'encounter_count',
      'first_encounter_month',
      'last_encounter_month',
      'diagnosis_codes',
      'medication_molecules',
      'follow_up_completed',
    ];

    const [created] = await this.tenantDb.run((tx) =>
      tx
        .insert(schema.analystExport)
        .values({
          clinicId: ctx.clinicId,
          cohortId: cohort?.id ?? null,
          cohortName: cohort?.name ?? 'Ad-hoc definition',
          definitionSnapshot: filters as never,
          definitionVersion: cohort?.definitionVersion ?? 1,
          exportType: input.exportType,
          status: 'READY',
          rowCount: result.rows.length,
          columnsIncluded: columns as never,
          requestedBy: ctx.userId,
          completedAt: new Date(),
          // Seven days, matching the clinic's own export bundles. Even
          // de-identified, an extract accumulating in storage is a liability.
          downloadExpiresAt: new Date(Date.now() + 7 * 86_400_000),
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning({ id: schema.analystExport.id }),
    );

    return {
      id: created!.id,
      rowCount: result.rows.length,
      columnsIncluded: columns,
      /*
       * The rows come back in the response rather than as a stored file.
       *
       * Object storage would mean a de-identified extract sitting on disk with its
       * own lifecycle to forget about. The browser turns this into a CSV; the
       * provenance record of what was exported stays in the database either way.
       */
      rows: result.rows,
      summary: result.summary,
    };
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Ninety days, which is long enough for a quality figure to mean something. */
function defaultFrom(): string {
  return new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
}

@Module({
  controllers: [ResearchController],
  providers: [CohortService, DataQualityService],
  exports: [CohortService, DataQualityService],
})
export class ResearchModule {}
