import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Pool } from 'pg';
import * as schema from '@emr/db/schema';
import { config } from '../../config';

export const PLATFORM_DRIZZLE = Symbol('PLATFORM_DRIZZLE');
export const PLATFORM_POOL = Symbol('PLATFORM_POOL');

export type PlatformDb = NodePgDatabase<typeof schema>;

/**
 * A SECOND database connection, as `emr_platform`.
 *
 * This is the point of the whole design, so it is worth being blunt about it:
 * if the platform module used the application's pool, a bug in a platform
 * endpoint could read every clinic's patients. It does not use that pool. It
 * connects as a role that has no privilege on `patient`, `encounter`,
 * `communication` or `app_user` — so the worst a bug here can do is read a
 * clinic's name, its plan, and a column of integers.
 *
 * The boundary is therefore enforced twice: once by the grant (the database
 * refuses), and once by which pool the code can reach (there is no way to ask).
 * The first is what makes it true; the second is what makes it hard to
 * accidentally undo.
 *
 * NO TENANT CONTEXT. Unlike TenantDb, nothing here sets `app.clinic_id`, and the
 * role holds BYPASSRLS — because aggregating across tenants is the job. That is
 * only safe because of the grant list, which `0005_platform_plane.sql` asserts
 * on every migration.
 */
@Injectable()
export class PlatformDbService implements OnApplicationShutdown {
  constructor(
    @Inject(PLATFORM_DRIZZLE) readonly db: PlatformDb,
    @Inject(PLATFORM_POOL) private readonly pool: Pool,
  ) {}

  async onApplicationShutdown() {
    await this.pool.end().catch(() => undefined);
  }
}

export const platformDbProviders = [
  {
    provide: PLATFORM_POOL,
    useFactory: () => {
      /*
       * NO FALLBACK TO DATABASE_URL.
       *
       * That connection is `emr_app`, which can read every patient in the
       * clinic whose context is set. Quietly falling back to it would turn the
       * console's central guarantee off while leaving every comment claiming it
       * was on — the worst possible failure, because nothing would look wrong.
       *
       * A deployment that does not want the console does not set this, and the
       * API refuses to start rather than serving one that is not what it says.
       */
      if (!config.PLATFORM_DATABASE_URL) {
        throw new Error(
          'PLATFORM_DATABASE_URL is not set. The operations console needs its own ' +
            'connection as emr_platform — a role with no privilege on any clinical ' +
            'table. It must never share the application connection.',
        );
      }

      return new pg.Pool({
        connectionString: config.PLATFORM_DATABASE_URL,
        // Smaller than the application pool. A handful of operators, not a
        // clinic full of receptionists.
        max: 4,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
      });
    },
  },
  {
    provide: PLATFORM_DRIZZLE,
    inject: [PLATFORM_POOL],
    useFactory: (pool: Pool) => drizzle(pool, { schema }),
  },
  PlatformDbService,
];
