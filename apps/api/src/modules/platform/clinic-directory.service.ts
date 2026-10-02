import { Injectable } from '@nestjs/common';
import { and, eq, ne } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import { SYSTEM_CLINIC_ID } from '@emr/db/schema';

import { PlatformDbService } from './platform-db.service';

/**
 * Which clinics exist. Nothing else.
 *
 * WHY THIS IS ITS OWN PROVIDER. Background work that runs for every tenant —
 * the usage aggregator, the reminder runner — has to start from a list of
 * clinics, and `emr_app` cannot produce one: under RLS it sees only the clinic
 * in context, which is the point. The only connection that can is
 * `PlatformDbService`, which is BYPASSRLS.
 *
 * Handing that connection to every module that needs a clinic list would spread
 * a BYPASSRLS handle across the codebase, so this sits in front of it and
 * answers one question with one column. A caller that wants to read a patient
 * has to go through `TenantDb` like everything else.
 *
 * THE BOUNDARY IS STILL THE GRANT LIST, not this class. `emr_platform` holds
 * privileges on seven platform tables and nothing clinical — asserted on every
 * deploy by migration `0005` and re-asserted since. If somebody did reach the
 * raw handle and select from `patient`, they would get a permission error
 * rather than rows. This class makes the narrow thing convenient; the database
 * makes the wide thing impossible.
 */
@Injectable()
export class ClinicDirectoryService {
  constructor(private readonly platformDb: PlatformDbService) {}

  /**
   * Every active clinic, for work that runs across all of them.
   *
   * EXCLUDES THE SYSTEM TENANT, which owns the shared drug and diagnosis
   * catalogues and is not a clinic. It is already `is_active = false`, so the
   * filter below is redundant today — and stated anyway, because the day
   * somebody flips that flag to make a catalogue editable is not the day to
   * discover that every background job started iterating it.
   *
   * Returns ids only. A caller needing a clinic's name or settings reads them
   * inside `runAs`, under RLS, like any other row.
   */
  async activeClinicIds(): Promise<string[]> {
    const rows = await this.platformDb.db
      .select({ id: schema.clinic.id })
      .from(schema.clinic)
      .where(and(eq(schema.clinic.isActive, true), ne(schema.clinic.id, SYSTEM_CLINIC_ID)));

    return rows.map((row) => row.id);
  }
}
