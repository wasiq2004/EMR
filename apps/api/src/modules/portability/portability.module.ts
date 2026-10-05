import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { desc } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import { ValidateImport, type ImportColumnMapping } from '@emr/contracts';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { Audit, RequirePermission } from '../../common/http/decorators';
import { RequiresFeature } from '../../common/features/feature.guard';
import { parseBody, requireUuid } from '../../common/http/zod.pipe';
import { StorageService } from '../../common/storage/storage.service';
import { PatientImportService } from './patient-import.service';

/**
 * Import and export.
 *
 * Two rules govern both, and they come from the same observation: a
 * half-imported patient registry is worse than no import, because staff cannot
 * tell which records to trust.
 *
 *   - Nothing commits until the whole batch validates.
 *   - No row is dropped silently. Every rejection produces a row-level reason
 *     in a file the clinic can correct and re-upload, and that file keeps the
 *     original row so they edit their own data rather than ours.
 *
 * Export is self-service and complete: no ticket, no developer, no delay. A
 * clinic that knows it can leave is considerably more willing to arrive. Every
 * export writes an audit row, because a full clinical export is precisely the
 * action a departing employee would take.
 */
@Injectable()
export class PortabilityService {
  constructor(private readonly tenantDb: TenantDb) {}

  async exportJobs() {
    return this.tenantDb.runReadOnly((tx) =>
      tx.select().from(schema.exportJob).orderBy(desc(schema.exportJob.createdAt)).limit(50),
    );
  }

  /** Records the request. A background worker builds the bundle. */
  async requestExport() {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const [job] = await tx
        .insert(schema.exportJob)
        .values({
          clinicId: ctx.clinicId,
          exportType: 'FULL_CLINIC',
          status: 'PENDING',
          // The bundle self-destructs: patient data must not accumulate in
          // storage indefinitely.
          downloadExpiresAt: new Date(Date.now() + 7 * 86_400_000),
          requestedBy: ctx.userId,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();
      return job!;
    });
  }
}

@RequiresFeature('dataPortability')
@Controller()
class PortabilityController {
  constructor(
    private readonly portability: PortabilityService,
    private readonly patientImport: PatientImportService,
  ) {}

  @RequirePermission('import:read')
  @Get('imports')
  async imports() {
    return { items: await this.patientImport.jobs() };
  }

  @RequirePermission('import:read')
  @Get('imports/:id')
  importJob(@Param('id') id: string) {
    return this.patientImport.job(requireUuid(id, 'Import'));
  }

  /**
   * Step one: the file.
   *
   * CREATES NOTHING IN THE REGISTER. It stores the upload and reads back the
   * real column headings and the first three rows, which is what makes the next
   * screen a confirmation rather than the hardcoded list of seven invented
   * column names it used to show.
   */
  @RequirePermission('import:create')
  @Audit('IMPORT_UPLOADED', 'import')
  @Post('imports')
  async startImport(@Req() req: FastifyRequest) {
    if (!req.isMultipart()) {
      throw new UnprocessableEntityException({
        title: 'Send the file as a form',
        message: 'Attach the CSV as multipart/form-data rather than JSON.',
      });
    }

    const file = await req.file();
    if (!file) {
      throw new UnprocessableEntityException({
        title: 'No file attached',
        message: 'Choose the CSV holding your patient list.',
      });
    }

    const body = await file.toBuffer();
    if (file.file.truncated) {
      throw new UnprocessableEntityException({
        title: 'That file is too large',
        message: 'Split the list and import the parts one after another.',
      });
    }

    /*
     * CSV ONLY, said plainly. The old screen's file picker accepted .xlsx and
     * .xls, which it could afford to do because it never read the file. An
     * Excel workbook is a zip of XML with merged cells, multiple sheets and
     * formula results that are not the displayed values — parsing one is its
     * own piece of work, and pretending to accept it here would mean reading
     * the zip header as text and reporting every row as broken.
     */
    const name = (file.filename ?? '').toLowerCase();
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      throw new UnprocessableEntityException({
        title: 'Save it as CSV first',
        message:
          'Excel workbooks are not read directly. In Excel choose File, Save As, ' +
          'and pick CSV UTF-8 — then upload that file.',
      });
    }

    return this.patientImport.upload({
      filename: file.filename ?? 'patients.csv',
      body,
    });
  }

  /**
   * Step two: what the columns mean, and what the rows actually say.
   *
   * STILL WRITES NOTHING to the register. Every figure the clinic then sees —
   * rows read, ready, duplicates, problems — is counted from their own file by
   * the same function that `commit` uses to decide what to insert, so the
   * preview cannot describe something other than what happens.
   */
  @RequirePermission('import:create')
  @Audit('IMPORT_VALIDATED', 'import')
  @Post('imports/:id/validate')
  validateImport(@Param('id') id: string, @Body() body: unknown) {
    const input = parseBody(ValidateImport, body);
    return this.patientImport.validate(
      requireUuid(id, 'Import'),
      input.columnMapping as ImportColumnMapping,
    );
  }

  /**
   * Step three: the commit.
   *
   * `import:execute` rather than `import:create` — a narrower permission for the
   * one step that changes the register. Everything before this is reversible by
   * closing the tab.
   */
  @RequirePermission('import:execute')
  @Audit('IMPORT_COMMITTED', 'import')
  @Post('imports/:id/commit')
  commitImport(@Param('id') id: string) {
    return this.patientImport.commit(requireUuid(id, 'Import'));
  }

  /**
   * The problem rows, as a file to correct and re-upload.
   *
   * Carries the clinic's own columns beside the reason, so they fix their data
   * in their own spreadsheet rather than transcribing from a list of row
   * numbers.
   */
  @RequirePermission('import:read')
  @Audit('IMPORT_REPORT_DOWNLOADED', 'import')
  @Get('imports/:id/problems')
  async importProblems(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const file = await this.patientImport.problemReport(requireUuid(id, 'Import'));
    void res.header('Content-Type', 'text/csv; charset=utf-8');
    void res.header(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(file.filename)}"`,
    );
    return file.body;
  }

  @RequirePermission('export:read')
  @Get('exports')
  async exports() {
    return { items: await this.portability.exportJobs() };
  }

  @RequirePermission('export:create')
  @Audit('EXPORT_REQUESTED', 'export')
  @Post('exports')
  request() {
    return this.portability.requestExport();
  }
}

@Module({
  controllers: [PortabilityController],
  providers: [PortabilityService, PatientImportService, StorageService],
  exports: [PortabilityService],
})
export class PortabilityModule {}
