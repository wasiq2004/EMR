import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Pool } from 'pg';
import * as schema from '@emr/db/schema';
import { config } from '../config';
import { DRIZZLE, TenantDb } from '../common/tenancy/tenant-db.service';
import { DatabaseWatchdog } from './database.watchdog';

/** The pool behind {@link DRIZZLE}, injectable so shutdown can drain it. */
export const PG_POOL = Symbol('PG_POOL');

const logger = new Logger('Database');

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
      useFactory: () => {
        const pool = new pg.Pool({
          connectionString: config.DATABASE_URL,
          // Small by design. Every request pins one connection for the length
          // of its transaction, so a large pool mostly buys idle sockets.
          max: 10,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 10_000,

          /*
           * THE TIMEOUTS THAT STOP ONE BAD QUERY TAKING THE API DOWN FOR GOOD.
           *
           * Without these, a query that hangs — a lock it will never get, a
           * seq scan over a table that grew, a network stall mid-result —
           * pins its pooled connection FOREVER. Ten of those and `max: 10` is
           * gone. Every request afterwards waits the full
           * `connectionTimeoutMillis` for a slot that is never coming back,
           * then fails. The process never recovers on its own; it has to be
           * restarted, and nothing in the logs says why, because the failing
           * request is never the one that caused it.
           *
           * That is not hypothetical — it is the shape of the outage this was
           * added for: `SELECT 1` on the readiness probe timing out after
           * exactly 10 seconds, every 15 seconds, while sign-in did the same.
           *
           * Set as server-side session parameters via libpq's `options`, so
           * they apply to every connection this pool opens, including ones it
           * replaces later. Enforcing them in the client instead would abandon
           * the query without telling Postgres to stop running it.
           *
           *   statement_timeout                     — no single statement may
           *     run longer than 30s. Every legitimate query in this product is
           *     a clinic-sized read; nothing takes half a minute.
           *   idle_in_transaction_session_timeout   — a transaction left open
           *     and idle is released after 60s. This is the one that actually
           *     frees a leaked connection, and it also stops an abandoned
           *     transaction holding its locks indefinitely.
           *   lock_timeout                          — 10s waiting for a lock,
           *     then give up. Better one failed request than a queue of them
           *     all holding connections behind the same row.
           */
          options:
            '-c statement_timeout=30000' +
            ' -c idle_in_transaction_session_timeout=60000' +
            ' -c lock_timeout=10000',
        });

        /*
         * A pool error is not a request error.
         *
         * `pg` emits 'error' on an IDLE client whose connection drops — the
         * database restarted, a proxy cut it, the network blinked. With no
         * listener, Node treats an unhandled 'error' event on an EventEmitter
         * as fatal and kills the process. One blip in Postgres would take the
         * API down with it.
         *
         * The pool discards the dead client and opens a fresh one on the next
         * request, so this is genuinely just a log line — but it has to exist.
         */
        pool.on('error', (error) => {
          logger.error(`Idle database connection dropped: ${error.message}`);
        });

        return pool;
      },
    },
    {
      provide: DRIZZLE,
      inject: [PG_POOL],
      useFactory: (pool: Pool) => drizzle(pool, { schema }),
    },
    TenantDb,
    DatabaseWatchdog,
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
