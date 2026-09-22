import { Body, Controller, Get, Headers, Param, Patch, Post, Query } from '@nestjs/common';
import { MergePatients, RegisterPatient, UpdatePatient } from '@emr/contracts';
import { Audit, RequirePermission } from '../../common/http/decorators';
import { parseBody, requireUuid } from '../../common/http/zod.pipe';
import { PatientsService } from './patients.service';

/**
 * The patient registry.
 *
 * Note what is NOT here: there is no `/clinics/:clinicId/patients`. The tenant
 * comes from the verified token and from nowhere else, so that shape — which
 * invites an insecure direct object reference — does not exist.
 */
@Controller('patients')
export class PatientsController {
  constructor(private readonly patients: PatientsService) {}

  @RequirePermission('patient:read')
  @Get()
  async list(@Query('q') q?: string, @Query('limit') limit?: string) {
    const items = await this.patients.list(q ?? '', limit ? Number(limit) : 50);
    return { items, nextCursor: null, total: items.length };
  }

  /** Front desk's primary lookup. Must satisfy the sub-60-second registration. */
  @RequirePermission('patient:read')
  @Get('search')
  async search(@Query('q') q?: string, @Query('limit') limit?: string) {
    const items = await this.patients.list(q ?? '', limit ? Number(limit) : 25);
    return { items, nextCursor: null, total: items.length };
  }

  @RequirePermission('patient:read')
  @Get('duplicates')
  duplicates(@Query('mobile') mobile?: string, @Query('name') name?: string) {
    return this.patients.duplicateCheck(mobile ?? '', name ?? '');
  }

  @RequirePermission('patient:create')
  @Audit('PATIENT_CREATED', 'patient')
  @Post()
  register(@Body() body: unknown) {
    return this.patients.register(parseBody(RegisterPatient, body) as never);
  }

  @RequirePermission('patient:merge')
  @Audit('PATIENTS_MERGED', 'patient')
  @Post('merge')
  merge(@Body() body: unknown) {
    return this.patients.merge(parseBody(MergePatients, body));
  }

  @RequirePermission('patient:read')
  @Get(':id')
  byId(@Param('id') id: string) {
    return this.patients.byId(requireUuid(id, 'Patient'));
  }

  @RequirePermission('patient:read')
  @Get(':id/snapshot')
  snapshot(@Param('id') id: string) {
    return this.patients.snapshot(requireUuid(id, 'Patient'));
  }

  @RequirePermission('patient:update')
  @Audit('PATIENT_UPDATED', 'patient')
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
  ) {
    const input = parseBody(UpdatePatient, body);
    // The version travels either in If-Match or in the body; either is fine, and
    // neither being present means the caller accepts last-write-wins.
    const version = ifMatch ? Number(ifMatch) : input.version;
    return this.patients.update(requireUuid(id, 'Patient'), input as never, version);
  }
}
