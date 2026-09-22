import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../tenancy/tenant-db.service';

/**
 * The practitioner's medical registration number.
 *
 * Holding the DOCTOR role is necessary but not sufficient to sign: the number
 * is a legally required element of a valid Indian e-prescription and would
 * otherwise print blank on the document. The guard checks it separately for
 * exactly that reason.
 *
 * Cached briefly because it is read on the signing path and changes rarely.
 */
@Injectable()
export class PractitionerCredentialCache {
  private readonly cache = new Map<string, { value: string | null; expiresAt: number }>();
  private static readonly TTL_MS = 60_000;

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async getRegistrationNumber(clinicId: string, userId: string): Promise<string | null> {
    const key = `${clinicId}:${userId}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    /*
     * Scoped, in its own transaction. app_user is under forced RLS, so an
     * unscoped read returns no row — and a missing row here does not look like
     * a database problem, it looks like a doctor who has no registration number
     * and therefore may not sign anything. Every doctor in the clinic is
     * silently stripped of the right to finalise a consultation.
     *
     * Both ids come from the verified access token.
     */
    const value = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      await tx.execute(sql`SELECT set_config('app.clinic_id', ${clinicId}, true)`);

      const result = await tx.execute(sql`
        SELECT medical_registration_number AS "number"
        FROM app_user
        WHERE id = ${userId}::uuid AND clinic_id = ${clinicId}::uuid AND is_active = true
      `);
      return (result.rows[0] as { number: string | null } | undefined)?.number ?? null;
    });
    this.cache.set(key, { value, expiresAt: Date.now() + PractitionerCredentialCache.TTL_MS });
    return value;
  }

  invalidate(clinicId: string, userId: string): void {
    this.cache.delete(`${clinicId}:${userId}`);
  }
}
