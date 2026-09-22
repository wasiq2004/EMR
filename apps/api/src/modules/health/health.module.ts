import { Controller, Get, Inject, Module } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DRIZZLE, type Db } from '../../common/tenancy/tenant-db.service';
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
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  @Public()
  @SkipAudit()
  @Get('healthz')
  live() {
    return { status: 'ok' };
  }

  @Public()
  @SkipAudit()
  @Get('readyz')
  async ready() {
    await this.db.execute(sql`SELECT 1`);
    return { status: 'ok', database: 'reachable' };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
