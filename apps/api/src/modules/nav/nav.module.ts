import { Controller, Get, Module } from '@nestjs/common';
import { CommsService } from '../comms/comms.service';
import { TasksService } from '../tasks/tasks.module';
import { SchedulingService } from '../scheduling/scheduling.service';
import { CommsModule } from '../comms/comms.module';
import { TasksModule } from '../tasks/tasks.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { PharmacyModule } from '../pharmacy/pharmacy.module';
import { StockService } from '../pharmacy/stock.service';
import { DispensingService } from '../pharmacy/dispensing.service';
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
    private readonly stock: StockService,
    private readonly dispensing: DispensingService,
  ) {}

  @RequirePermission('clinic:read')
  @SkipAudit()
  @Get('counts')
  async counts() {
    const ctx = TenantContext.require();

    /*
     * Each count is gated on the permission for the screen it points at, so a
     * role that cannot open a list is not told how long it is. The pharmacy
     * counts additionally serve the DOCTOR panel: a prescriber sees how many
     * clarifications are waiting on them, which is the one pharmacy number a
     * clinician can act on.
     *
     * The pharmacy counts swallow their own errors. This endpoint feeds the
     * sidebar on every screen in the product, so a failure in one badge must
     * degrade that badge to zero rather than take the navigation down with it.
     * The failure is still logged by the interceptor; it just is not fatal here.
     */
    const [inbox, tasks, queue, rxQueue, clarifications, stockAlerts] = await Promise.all([
      can(ctx.role, 'communication:read') ? this.comms.unreadCount() : 0,
      can(ctx.role, 'task:read') ? this.tasks.openCount() : 0,
      can(ctx.role, 'appointment:read')
        ? this.scheduling.queue().then((q) => q.waiting.length)
        : 0,

      can(ctx.role, 'dispense:read')
        ? this.dispensing.queue().then((rows) => rows.length).catch(() => 0)
        : 0,

      can(ctx.role, 'clarification:resolve')
        ? // A prescriber is shown only their own.
          this.dispensing
            .openForPrescriber(ctx.userId)
            .then((rows) => rows.length)
            .catch(() => 0)
        : can(ctx.role, 'clarification:read')
          ? this.dispensing
              .clarifications({ status: 'OPEN' })
              .then((rows) => rows.length)
              .catch(() => 0)
          : 0,

      can(ctx.role, 'stock:update')
        ? this.stock
            .alerts()
            .then((a) => a.outOfStock.length + a.lowStock.length + a.expired.length)
            .catch(() => 0)
        : 0,
    ]);

    return { inbox, tasks, queue, rxQueue, clarifications, stockAlerts };
  }
}

@Module({
  imports: [CommsModule, TasksModule, SchedulingModule, PharmacyModule],
  controllers: [NavController],
})
export class NavModule {}
