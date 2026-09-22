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

    const result = await this.db.execute<{ number: string | null }>(sql`
      SELECT medical_registration_number AS "number"
      FROM app_user
      WHERE id = ${userId}::uuid AND clinic_id = ${clinicId}::uuid AND is_active = true
    `);

    const value = result.rows[0]?.number ?? null;
    this.cache.set(key, { value, expiresAt: Date.now() + PractitionerCredentialCache.TTL_MS });
    return value;
  }

  invalidate(clinicId: string, userId: string): void {
    this.cache.delete(`${clinicId}:${userId}`);
  }
}
