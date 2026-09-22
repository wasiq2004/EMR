import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Pool } from 'pg';
import * as schema from '@emr/db/schema';
import { config } from '../config';
import { DRIZZLE, TenantDb } from '../common/tenancy/tenant-db.service';

/** The pool behind {@link DRIZZLE}, injectable so shutdown can drain it. */
export const PG_POOL = Symbol('PG_POOL');

/**
 * The database connection.
 *
 * One pool, opened as `emr_app` — a role created NOBYPASSRLS with no DDL
 * rights, so application code is structurally incapable of switching a tenant
 * policy off. Migrations connect as a different role entirely.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () =>
        new pg.Pool({
          connectionString: config.DATABASE_URL,
          // Small by design. Every request pins one connection for the length
          // of its transaction, so a large pool mostly buys idle sockets.
          max: 10,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 10_000,
        }),
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool) => drizzle(pool, { schema }),
    },
    TenantDb,
  ],
  exports: [DRIZZLE, TenantDb],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Drain the pool on shutdown.
   *
   * Without this, a rolling deploy tears the process down with transactions
   * still open, and Postgres only notices when the socket times out — which
   * holds the locks those transactions took for as long as it takes.
   */
  async onApplicationShutdown() {
    await this.pool.end();
  }
}
