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
           * seq scan over a table that grew, a network stall mid-result — pins
           * its pooled connection FOREVER. Ten of those and `max: 10` is gone.
           * Every request afterwards waits the full `connectionTimeoutMillis`
           * for a slot that is never coming back, then fails. The process never
           * recovers on its own, and nothing in the logs says why, because the
           * request that fails is never the one that caused it.
           *
           * That is not hypothetical — it is the shape of the outage this was
           * added for: `SELECT 1` on the readiness probe timing out after
           * exactly 10 seconds, every 15 seconds, while sign-in did the same.
           *
           * THESE ARE node-postgres CONFIG KEYS, not a hand-built libpq
           * `options` string. The driver issues each as a `SET` on connect, so
           * a typo is a typed error here rather than a startup packet Postgres
           * rejects — which would make every connection fail and look exactly
           * like the outage this is meant to prevent.
           *
           *   statement_timeout                   — no single statement runs
           *     longer than 30s. Every legitimate query here is a clinic-sized
           *     read; nothing takes half a minute.
           *   idle_in_transaction_session_timeout — a transaction left open and
           *     idle is released after 60s. This is the one that actually frees
           *     a leaked connection, and it stops an abandoned transaction
           *     holding its locks indefinitely.
           *   lock_timeout                        — 10s waiting for a lock,
           *     then give up. One failed request beats a queue of them all
           *     holding connections behind the same row.
           */
          statement_timeout: 30_000,
          idle_in_transaction_session_timeout: 60_000,
          lock_timeout: 10_000,
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
  /*
   * PG_POOL IS EXPORTED, and leaving it out was a real outage.
   *
   * `@Global()` publishes a module's EXPORTS everywhere without an import — it
   * does not make its private providers injectable. So `@Inject(PG_POOL)` in
   * the health controller could not be resolved, Nest failed to build the
   * injector, and the API exited during bootstrap. The container never became
   * healthy, `web` depends on `api: service_healthy`, and the whole deploy
   * aborted with "dependency failed to start".
   *
   * It fails at startup rather than at the first request, which is the good
   * version of this mistake — but only the deploy log says so, and a DI error
   * reads nothing like the health-check failure it surfaces as.
   */
  exports: [DRIZZLE, TenantDb, PG_POOL],
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
