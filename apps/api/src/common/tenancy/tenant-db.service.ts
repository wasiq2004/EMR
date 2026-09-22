/**
 * ============================= SECURITY CORE =================================
 * The ONLY sanctioned path from application code to the database.
 *
 * Every query must run inside `TenantDb.run()`. That method:
 *   1. requires a tenant context (throws if absent)
 *   2. opens a transaction, which PINS ONE POOLED CONNECTION for its duration
 *   3. sets app.clinic_id and app.user_id as TRANSACTION-LOCAL settings
 *   4. runs the caller's work against that pinned connection
 *
 * Step 2 is the subtle one. `set_config(..., true)` is transaction-scoped, so
 * the value is discarded at COMMIT/ROLLBACK and cannot leak onto the next
 * request that borrows the same pooled connection. Issuing the setting outside
 * a transaction — or letting the connection return to the pool mid-request —
 * is the classic way multi-tenant RLS is silently defeated.
 *
 * Direct use of the underlying Drizzle client is forbidden and blocked by an
 * ESLint `no-restricted-imports` rule.
 * =============================================================================
 */

import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as schema from '@emr/db/schema';
import { TenantContext } from './tenant-context';

export type Db = NodePgDatabase<typeof schema>;
export type TenantTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export const DRIZZLE = Symbol('DRIZZLE');

@Injectable()
export class TenantDb {
  private readonly logger = new Logger(TenantDb.name);

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Runs `work` inside a tenant-scoped transaction.
   *
   * @example
   *   const rows = await this.tenantDb.run((tx) =>
   *     tx.select().from(schema.patient).where(eq(schema.patient.id, id)),
   *   );
   *   // No clinic_id predicate is written here — RLS applies it. Omitting it
   *   // from application code is safe BECAUSE the database enforces it.
   */
  async run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    const ctx = TenantContext.require();

    return this.db.transaction(async (tx) => {
      // Transaction-local. Discarded at COMMIT/ROLLBACK; cannot outlive the
      // transaction or leak onto another request via the connection pool.
      await tx.execute(
        sql`SELECT set_config('app.clinic_id', ${ctx.clinicId}, true)`,
      );
      await tx.execute(sql`SELECT set_config('app.user_id', ${ctx.userId}, true)`);

      return work(tx);
    });
  }

  /**
   * Read-only variant. Declaring the transaction READ ONLY means an accidental
   * write in a GET handler is rejected by Postgres rather than committed.
   */
  async runReadOnly<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    const ctx = TenantContext.require();

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      await tx.execute(
        sql`SELECT set_config('app.clinic_id', ${ctx.clinicId}, true)`,
      );
      await tx.execute(sql`SELECT set_config('app.user_id', ${ctx.userId}, true)`);

      return work(tx);
    });
  }

  /**
   * Defence in depth for background workers.
   *
   * RLS already makes a cross-tenant read impossible, so reaching this
   * exception means something is deeply wrong — a corrupted job payload, a
   * replayed message, or a policy that has been tampered with. It is therefore
   * logged at MAJOR_FAILURE severity and should page, not merely warn.
   */
  assertRowTenant(row: { clinicId: string } | undefined, resource: string): void {
    const ctx = TenantContext.require();

    if (!row) return;

    if (row.clinicId !== ctx.clinicId) {
      this.logger.error(
        `TENANT ASSERTION VIOLATED on ${resource}: context=${ctx.clinicId} ` +
          `row=${row.clinicId} request=${ctx.requestId}`,
      );
      throw new ForbiddenException('Resource does not belong to the current clinic.');
    }
  }

  /**
   * A transaction for a tenant that is known but is not yet in context.
   *
   * Sign-in, refresh and share-link redemption all reach a point where the
   * clinic HAS been established — by a verified password, a stored token hash,
   * an unguessable link — but no context exists yet because establishing it was
   * the job. This runs their remaining work fully scoped, under exactly the same
   * RLS as everything else.
   *
   * `clinicId` must come from one of the resolvers in
   * `0002_pre_tenant_resolvers.sql` or from a verified credential. It must never
   * come from the request body, a path parameter or a header.
   */
  async runAs<T>(
    clinicId: string,
    userId: string | null,
    work: (tx: TenantTx) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.clinic_id', ${clinicId}, true)`);
      await tx.execute(sql`SELECT set_config('app.user_id', ${userId ?? ''}, true)`);

      return work(tx);
    });
  }

  /**
   * Calls one of the three pre-tenant resolvers.
   *
   * These are SECURITY DEFINER functions, enumerated and justified in
   * `0002_pre_tenant_resolvers.sql`. Each answers one question and returns
   * identifiers only. This method exists so that every tenant-boundary crossing
   * in the application is one grep away, and so that its narrowness is a
   * property of the database rather than a promise made in a comment.
   *
   * It deliberately offers no way to run arbitrary SQL.
   */
  async resolveAcrossTenants<T extends Record<string, unknown>>(
    reason: string,
    query: SQL,
  ): Promise<T[]> {
    this.logger.log(`Pre-tenant resolution: ${reason}`);
    const result = await this.db.execute(query);
    return result.rows as T[];
  }
}
