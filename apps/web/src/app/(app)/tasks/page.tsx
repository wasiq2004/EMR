'use client';

import * as React from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ClipboardList } from 'lucide-react';
import { TASK_TYPE_LABEL, type Task } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { formatDateTime, relativeTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel, PanelHeader, PageHeader } from '@/components/ui/surface';
import { EmptyState, SkeletonRows } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';

/**
 * The worklist.
 *
 * Several safety mechanisms in this system terminate in a human action that has
 * to be tracked to completion: a prescription not confirmed delivered within
 * fifteen minutes, a duplicate awaiting review, a lab report needing a doctor's
 * eyes. An alert nobody is accountable for is an alert nobody actions — which
 * is why these are records with an owner and a due time, not toasts.
 */
export default function TasksPage() {
  const [filter, setFilter] = React.useState<'open' | 'all'>('open');
  const queryClient = useQueryClient();
  const toast = useToast();

  const { data, isLoading } = useQuery({
    queryKey: qk.tasks(filter),
    queryFn: () => api.get<{ items: Task[] }>('/tasks', { query: { filter } }),
  });

  const complete = useMutation({
    mutationFn: (taskId: string) =>
      api.patch(`/tasks/${taskId}`, { status: 'COMPLETED' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      void queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
      toast.success('Task completed');
    },
  });

  const tasks = data?.items ?? [];

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <PageHeader
        title="Tasks"
        description="Things that need a person, not a notification."
        actions={
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={filter === 'open' ? 'primary' : 'secondary'}
              onClick={() => setFilter('open')}
            >
              Open
            </Button>
            <Button
              size="sm"
              variant={filter === 'all' ? 'primary' : 'secondary'}
              onClick={() => setFilter('all')}
            >
              All
            </Button>
          </div>
        }
      />

      <Panel>
        <PanelHeader title={filter === 'open' ? 'Open tasks' : 'All tasks'} />
        {isLoading ? (
          <SkeletonRows rows={4} />
        ) : tasks.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="Nothing needs attention"
            description="Failed messages and duplicate reviews will appear here."
          />
        ) : (
          <ul className="divide-y divide-line-soft">
            {tasks.map((task) => (
              <li key={task.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {task.priority !== 'ROUTINE' ? (
                      <Badge tone="warning">{task.priority.toLowerCase()}</Badge>
                    ) : null}
                    <Badge tone="neutral">
                      {TASK_TYPE_LABEL[task.taskType] ?? task.taskType}
                    </Badge>
                    {task.status === 'COMPLETED' ? (
                      <Badge tone="positive">Done</Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm font-medium text-ink">{task.title}</p>
                  {task.description ? (
                    <p className="mt-0.5 text-xs text-ink-soft">{task.description}</p>
                  ) : null}
                  <p className="mt-1 text-2xs text-ink-faint">
                    Raised {relativeTime(task.createdAt)}
                    {task.dueAt ? ` · due ${formatDateTime(task.dueAt)}` : ''}
                    {task.assignedToName
                      ? ` · ${task.assignedToName}`
                      : task.assignedToRole
                        ? ` · any ${task.assignedToRole.replace(/_/g, ' ').toLowerCase()}`
                        : ''}
                  </p>
                </div>

                <div className="flex shrink-0 gap-2">
                  {task.patientId ? (
                    <Button size="sm" variant="secondary" asChild>
                      <Link href={`/patients/${task.patientId}`}>Open patient</Link>
                    </Button>
                  ) : null}
                  {task.status !== 'COMPLETED' ? (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => complete.mutate(task.id)}
                    >
                      <Check aria-hidden />
                      Done
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
