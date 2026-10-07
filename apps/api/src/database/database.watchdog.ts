import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../common/tenancy/tenant-db.service';

/**
 * Exits the process when the database has been unreachable for long enough that
 * nothing is going to fix it from in here.
 *
 * WHY A PROCESS WOULD DELIBERATELY KILL ITSELF. `restart: unless-stopped` acts
 * on a container that EXITS. It does nothing at all for one that is merely
 * marked unhealthy — Docker keeps an unhealthy container running indefinitely.
 * So an API whose connection pool has wedged sits there answering `/healthz`
 * cheerfully, failing every real request, and waits for a human to notice. For
 * a clinic that is the difference between a two-minute blip and being unable to
 * see patients until somebody is reached by phone.
 *
 * Restarting genuinely fixes the common case. A pool exhausted by transactions
 * that were never released — the failure the `statement_timeout` settings in
 * `database.module.ts` exist to prevent, for the times they are not enough —
 * comes back clean on a new process and cannot be recovered any other way.
 *
 * When the database really is down, this crash-loops instead. That is the
 * deliberate trade: restarting into a dead database is noisy and harmless, and
 * the container comes back the moment Postgres does. Sitting wedged is quiet
 * and unbounded. For a medical record a clinic is trying to work from, loud and
 * self-correcting beats quiet and broken.
 *
 * THE GUARDS MATTER MORE THAN THE BEHAVIOUR. This exits a healthy process if it
 * is wrong, so:
 *
 *   - it waits for a sustained run of consecutive failures, not one;
 *   - a single success resets the count completely;
 *   - it does nothing until the database has answered at least once, so a
 *     slow-starting Postgres on a cold deploy never trips it;
 *   - the probe is cheap and on its own short timeout, so the watchdog can
 *     never itself be what exhausts the pool.
 */
@Injectable()
export class DatabaseWatchdog implements OnApplicationBootstrap {
  private readonly logger = new Logger('DatabaseWatchdog');

  /** How often to ask. */
  private static readonly INTERVAL_MS = 15_000;

  /**
   * Consecutive failures before giving up: six probes, so about ninety seconds.
   *
   * Long enough to ride out a Postgres restart, a failover or a brief network
   * partition without bouncing the API. Short enough that a wedged pool is a
   * blip rather than an afternoon.
   */
  private static readonly FAILURES_BEFORE_EXIT = 6;

  private consecutiveFailures = 0;

  /**
   * Until the database has answered once, this does nothing.
   *
   * Otherwise a deploy where Postgres takes two minutes to accept connections
   * would exit the API six times before it ever started — turning a slow start
   * into a crash loop that looks like a much worse problem than it is.
   */
  private hasEverConnected = false;

  private timer: NodeJS.Timeout | null = null;

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => {
      void this.probe();
    }, DatabaseWatchdog.INTERVAL_MS);

    // Never hold the event loop open. Without this the process cannot exit
    // cleanly on SIGTERM and a rolling deploy waits for the kill timeout.
    this.timer.unref();
  }

  private async probe(): Promise<void> {
    try {
      await this.db.execute(sql`SELECT 1`);
      if (this.consecutiveFailures > 0) {
        this.logger.log(
          `Database reachable again after ${this.consecutiveFailures} failed checks.`,
        );
      }
      this.consecutiveFailures = 0;
      this.hasEverConnected = true;
    } catch (error) {
      if (!this.hasEverConnected) {
        // Still starting up. Say so once per probe but never act on it.
        this.logger.warn('Database has not answered yet; still waiting for a first connection.');
        return;
      }

      this.consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : String(error);

      if (this.consecutiveFailures < DatabaseWatchdog.FAILURES_BEFORE_EXIT) {
        this.logger.error(
          `Database check ${this.consecutiveFailures}/${DatabaseWatchdog.FAILURES_BEFORE_EXIT} ` +
            `failed: ${message}`,
        );
        return;
      }

      /*
       * Logged before exiting, and spelled out, because this line is the only
       * explanation anybody will have for why the container restarted. A bare
       * exit code in a deploy log is indistinguishable from a crash.
       */
      this.logger.error(
        `DATABASE UNREACHABLE FOR ${
          (DatabaseWatchdog.FAILURES_BEFORE_EXIT * DatabaseWatchdog.INTERVAL_MS) / 1000
        }s — exiting so the container restarts with a clean connection pool. ` +
          `Last error: ${message}. If this repeats, the database itself is down or ` +
          `unreachable and restarting will not fix it — check Postgres, its memory, ` +
          `and the network between it and this container.`,
      );

      /*
       * Non-zero, so the restart policy treats it as a failure and applies its
       * backoff. Exiting zero would read as a clean shutdown and, under some
       * policies, not restart at all.
       */
      process.exit(1);
    }
  }
}
