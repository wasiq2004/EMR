import { Body, Controller, Get, Injectable, Module, Param, Patch, Query } from '@nestjs/common';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '@emr/db/schema';
import type { Task } from '@emr/contracts';
import { TenantDb } from '../../common/tenancy/tenant-db.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { Audit, RequirePermission } from '../../common/http/decorators';
import { requireUuid } from '../../common/http/zod.pipe';

const OPEN = ['REQUESTED', 'ACCEPTED', 'IN_PROGRESS'] as const;

/**
 * The worklist.
 *
 * Several safety mechanisms terminate in a human action that has to be tracked
 * to completion: a prescription not confirmed delivered within fifteen minutes,
 * a duplicate awaiting review, a lab report needing a doctor's eyes. An alert
 * nobody is accountable for is an alert nobody actions — which is why these are
 * records with an owner and a due time rather than notifications.
 */
@Injectable()
export class TasksService {
  constructor(private readonly tenantDb: TenantDb) {}

  async list(filter: string): Promise<Task[]> {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({ task: schema.task, patientName: schema.patient.fullName, assignee: schema.appUser.fullName })
        .from(schema.task)
        .leftJoin(schema.patient, eq(schema.patient.id, schema.task.patientId))
        .leftJoin(schema.appUser, eq(schema.appUser.id, schema.task.assignedToUserId))
        .where(filter === 'all' ? undefined : inArray(schema.task.status, [...OPEN]))
        // Most urgent first, then by when it is due.
        .orderBy(
          sql`CASE ${schema.task.priority}
                WHEN 'STAT' THEN 0 WHEN 'ASAP' THEN 1
                WHEN 'URGENT' THEN 2 ELSE 3 END`,
          asc(schema.task.dueAt),
        )
        .limit(200),
    );

    return rows.map(({ task, patientName, assignee }) => ({
      ...task,
      patientName,
      assignedToName: assignee,
      dueAt: task.dueAt?.toISOString() ?? null,
      completedAt: task.completedAt?.toISOString() ?? null,
      createdAt: task.createdAt.toISOString(),
    })) as unknown as Task[];
  }

  async update(taskId: string, patch: { status?: string; resolutionNotes?: string | null }) {
    const ctx = TenantContext.require();

    return this.tenantDb.run(async (tx) => {
      const [updated] = await tx
        .update(schema.task)
        .set({
          status: (patch.status as 'COMPLETED') ?? undefined,
          resolutionNotes: patch.resolutionNotes ?? undefined,
          completedAt: patch.status === 'COMPLETED' ? new Date() : undefined,
          completedBy: patch.status === 'COMPLETED' ? ctx.userId : undefined,
          updatedBy: ctx.userId,
        })
        .where(eq(schema.task.id, taskId))
        .returning();
      return updated;
    });
  }

  async openCount(): Promise<number> {
    const rows = await this.tenantDb.runReadOnly((tx) =>
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.task)
        .where(inArray(schema.task.status, [...OPEN])),
    );
    return rows[0]?.count ?? 0;
  }
}

@Controller('tasks')
class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @RequirePermission('task:read')
  @Get()
  async list(@Query('filter') filter?: string) {
    return { items: await this.tasks.list(filter ?? 'open') };
  }

  @RequirePermission('task:update')
  @Audit('TASK_UPDATED', 'task')
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { status?: string; resolutionNotes?: string }) {
    return this.tasks.update(requireUuid(id, 'Task'), body ?? {});
  }
}

@Module({
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
