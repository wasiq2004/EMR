import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { PrescriptionLine } from '@emr/contracts';
import { Audit, RequirePermission } from '../../common/http/decorators';
import { parseBody, requireUuid } from '../../common/http/zod.pipe';
import { PrescribingService } from './prescribing.service';

@Controller()
export class PrescribingController {
  constructor(private readonly prescribing: PrescribingService) {}

  /** Runs while the doctor types, so it is exempt from nothing but must be fast. */
  @RequirePermission('prescription:read')
  @Get('drugs/search')
  async search(@Query('q') q?: string, @Query('limit') limit?: string) {
    const items = await this.prescribing.searchDrugs(q ?? '', limit ? Number(limit) : 12);
    return { items };
  }

  @RequirePermission('prescription:read')
  @Get('encounters/:id/prescriptions')
  lines(@Param('id') id: string) {
    return this.prescribing.linesFor(requireUuid(id, 'Consultation'));
  }

  @RequirePermission('prescription:create')
  @Audit('PRESCRIPTION_LINE_ADDED', 'prescription')
  @Post('encounters/:id/prescriptions')
  addLine(@Param('id') id: string, @Body() body: unknown) {
    return this.prescribing.addLine(
      requireUuid(id, 'Consultation'),
      parseBody(PrescriptionLine, body) as never,
    );
  }

  @RequirePermission('prescription:update')
  @Audit('PRESCRIPTION_LINE_REMOVED', 'prescription')
  @Delete('prescriptions/:id')
  @HttpCode(204)
  async removeLine(@Param('id') id: string) {
    await this.prescribing.removeLine(requireUuid(id, 'Prescription line'));
  }

  @RequirePermission('prescription:read')
  @Get('prescription-templates')
  async prescriptionTemplates() {
    return { items: await this.prescribing.prescriptionTemplates() };
  }

  @RequirePermission('encounter:read')
  @Get('encounter-templates')
  async encounterTemplates() {
    return { items: await this.prescribing.encounterTemplates() };
  }
}
