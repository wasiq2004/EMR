'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { GitMerge, Users } from 'lucide-react';
import type { Task } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { Button } from '@/components/ui/button';
import { Panel, PanelHeader, PageHeader } from '@/components/ui/surface';
import { Alert, EmptyState, SkeletonRows } from '@/components/ui/feedback';

/**
 * Duplicate review and merge.
 *
 * Merging is NEVER automatic. An incorrect merge is considerably harder to
 * unwind than a duplicate, so every one requires a person to look at both
 * records and confirm. Candidates come from the nightly sweep and arrive here
 * as tasks.
 *
 * A merge re-parents encounters, prescriptions, documents and allergies onto
 * the surviving record, writes a full audit chain, and keeps the merged-from
 * identifier permanently so the history can be reconstructed.
 */
export default function MergePatientsPage() {
  const { data, isLoading } = useQuery({
    queryKey: qk.duplicateCandidates,
    queryFn: () => api.get<{ items: Task[] }>('/tasks', { query: { filter: 'open' } }),
  });

  const candidates = (data?.items ?? []).filter(
    (task) => task.taskType === 'DUPLICATE_REVIEW',
  );

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <PageHeader
        title="Duplicate patients"
        description="Candidates found by the nightly check. Each one needs a person to decide."
      />

      <Alert tone="warning" title="Merging cannot be undone easily">
        Check both records before merging. Everything on the merged record moves
        onto the surviving one, and the original identifier is kept for
        traceability.
      </Alert>

      <Panel>
        <PanelHeader
          title="Awaiting review"
          description={`${candidates.length} possible duplicate${candidates.length === 1 ? '' : 's'}`}
        />
        {isLoading ? (
          <SkeletonRows rows={3} />
        ) : candidates.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No duplicates to review"
            description="The nightly check found nothing that needs a decision."
          />
        ) : (
          <ul className="divide-y divide-line-soft">
            {candidates.map((task) => (
              <li key={task.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">{task.title}</p>
                  {task.description ? (
                    <p className="mt-0.5 text-xs text-ink-faint">{task.description}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-2">
                  {task.patientId ? (
                    <Button size="sm" variant="secondary" asChild>
                      <Link href={`/patients/${task.patientId}`}>Open first</Link>
                    </Button>
                  ) : null}
                  {task.focusResourceId ? (
                    <Button size="sm" variant="secondary" asChild>
                      <Link href={`/patients/${task.focusResourceId}`}>Open second</Link>
                    </Button>
                  ) : null}
                  <Button size="sm" variant="primary">
                    <GitMerge aria-hidden />
                    Review and merge
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
