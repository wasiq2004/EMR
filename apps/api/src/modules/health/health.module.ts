import {
  Controller,
  Get,
  Inject,
  Logger,
  Module,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../common/tenancy/tenant-db.service';
import { PG_POOL } from '../../database/database.module';
import type { Pool } from 'pg';
import { Public, SkipAudit } from '../../common/http/decorators';

/**
 * Health checks.
 *
 * `/healthz` answers as soon as the process is up, which is what a container
 * restart policy wants. `/readyz` additionally proves the database answers,
 * which is what a load balancer should gate traffic on — an API that cannot
 * reach Postgres can serve nothing useful.
 */
@Controller()
class HealthController {
  private readonly logger = new Logger('Health');

  /** Logged at most once a minute. See `ready()`. */
  private lastReported = 0;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  @Public()
  @SkipAudit()
  @Get('healthz')
  live() {
    return { status: 'ok' };
  }

  /**
   * Is the database reachable?
   *
   * WHAT THIS USED TO DO, and why it was worse than useless: it ran
   * `SELECT 1` with no try/catch, so a database it could not reach produced an
   * UNHANDLED EXCEPTION. The global filter logged a stack trace headed
   * "Unhandled error on GET /v1/readyz", every fifteen seconds, and answered
   * 500.
   *
   * Three things were wrong with that. A readiness probe exists precisely to
   * report this condition, so throwing is the one thing it must not do. 500
   * says "this endpoint is broken" when the truth is "the thing behind it is";
   * 503 is the answer a load balancer understands. And a stack trace every
   * fifteen seconds buries every other line in the log — which is exactly what
   * the outage this was written for looked like from the outside: pages of
   * identical traces with the actual cause nowhere in them.
   *
   * It now reports, and says WHICH failure it is. "Cannot get a connection"
   * and "the query failed" have completely different causes — pool exhaustion
   * or an unreachable server against a database that answered and refused —
   * and the distinction is the whole diagnosis.
   */
  @Public()
  @SkipAudit()
  @Get('readyz')
  async ready(@Res({ passthrough: true }) res: FastifyReply) {
    /*
     * The pool's own counters, which are the fastest way to tell a saturated
     * pool from an unreachable server and cost nothing to read.
     *
     * `waiting` above zero means requests are queued for a connection that is
     * not free. If that is non-zero while `idle` is zero and `total` is at the
     * maximum, the pool is exhausted — somebody is holding connections open —
     * and no amount of restarting Postgres will help.
     */
    const stats = {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };

    const startedAt = Date.now();

    try {
      await this.db.execute(sql`SELECT 1`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const elapsed = Date.now() - startedAt;

      /*
       * Throttled to once a minute.
       *
       * A probe runs every fifteen seconds and an outage lasts hours. Logging
       * every failure is how the log stops being readable at the moment
       * somebody needs to read it — and the second identical line tells nobody
       * anything the first did not.
       */
      const now = Date.now();
      if (now - this.lastReported > 60_000) {
        this.lastReported = now;
        this.logger.error(
          `DATABASE UNREACHABLE after ${elapsed}ms — ${message}. ` +
            `Pool: ${stats.total} open, ${stats.idle} idle, ${stats.waiting} waiting. ` +
            (stats.waiting > 0 && stats.idle === 0
              ? 'Requests are queued for connections that are never freed: the pool is ' +
                'EXHAUSTED, which is a held transaction rather than a database that is down.'
              : 'No requests are queued, so this is the server or the network between ' +
                'here and it, not pool exhaustion.'),
        );
      }

      /*
       * 503, and the body says what is wrong in a sentence. A readiness probe
       * is read by a load balancer and by whoever is on the end of an alert at
       * two in the morning; both are served by the same plain answer.
       */
      void res.status(503);
      throw new ServiceUnavailableException({
        status: 'unavailable',
        database: 'unreachable',
        detail: message,
        elapsedMs: elapsed,
        pool: stats,
      });
    }

    return { status: 'ok', database: 'reachable', pool: stats };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
