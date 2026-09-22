import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from './tenant-db.service';

interface ClinicStatus extends Record<string, unknown> {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
}

/**
 * Whether a clinic is still allowed to work, checked on every request.
 *
 * Trusting the token here would mean a clinic suspended for non-payment or
 * placed on a security hold kept working until its users' ten-minute tokens
 * happened to expire. A short cache makes the check cost roughly nothing while
 * keeping the suspension window down to seconds.
 */
@Injectable()
export class ClinicStatusCache {
  private readonly cache = new Map<string, { value: ClinicStatus; expiresAt: number }>();
  private static readonly TTL_MS = 30_000;

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async get(clinicId: string): Promise<ClinicStatus | null> {
    const cached = this.cache.get(clinicId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    /*
     * This runs before tenant context exists — it is what decides whether the
     * tenant may have a context at all — so it sets `app.clinic_id` itself,
     * inside the transaction, and reads the clinic row under its own policy.
     *
     * The id is safe to set here because it came from a signature-verified
     * access token, which is the only thing the caller could not have forged.
     * Reading the row unscoped would return nothing under forced RLS, and the
     * resulting "that clinic no longer exists" would be indistinguishable from
     * a genuinely deleted clinic.
     */
    const row = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      await tx.execute(sql`SELECT set_config('app.clinic_id', ${clinicId}, true)`);

      const result = await tx.execute(sql`
        SELECT id, name, slug, is_active AS "isActive"
        FROM clinic WHERE id = ${clinicId}::uuid
      `);
      return (result.rows[0] as ClinicStatus | undefined) ?? null;
    });
    if (row) {
      this.cache.set(clinicId, { value: row, expiresAt: Date.now() + ClinicStatusCache.TTL_MS });
    }
    return row;
  }

  /** Drops the cached entry, so a suspension takes effect on the next request. */
  invalidate(clinicId: string): void {
    this.cache.delete(clinicId);
  }
}
