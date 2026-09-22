import { Controller, Get, Module } from '@nestjs/common';
import { CommsService } from '../comms/comms.service';
import { TasksService } from '../tasks/tasks.module';
import { SchedulingService } from '../scheduling/scheduling.service';
import { CommsModule } from '../comms/comms.module';
import { TasksModule } from '../tasks/tasks.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { RequirePermission, SkipAudit } from '../../common/http/decorators';
import { can } from '@emr/contracts';
import { TenantContext } from '../../common/tenancy/tenant-context';

/**
 * Badge counts for the sidebar.
 *
 * One cheap call rather than three, polled rather than pushed. Each count is
 * gated on the permission for the screen it points at, so a role that cannot
 * open the inbox is not told how many messages are waiting in it.
 */
@Controller('nav')
class NavController {
  constructor(
    private readonly comms: CommsService,
    private readonly tasks: TasksService,
    private readonly scheduling: SchedulingService,
  ) {}

  @RequirePermission('clinic:read')
  @SkipAudit()
  @Get('counts')
  async counts() {
    const ctx = TenantContext.require();

    const [inbox, tasks, queue] = await Promise.all([
      can(ctx.role, 'communication:read') ? this.comms.unreadCount() : 0,
      can(ctx.role, 'task:read') ? this.tasks.openCount() : 0,
      can(ctx.role, 'appointment:read')
        ? this.scheduling.queue().then((q) => q.waiting.length)
        : 0,
    ]);

    return { inbox, tasks, queue };
  }
}

@Module({
  imports: [CommsModule, TasksModule, SchedulingModule],
  controllers: [NavController],
})
export class NavModule {}
