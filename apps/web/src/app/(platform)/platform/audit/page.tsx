'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { formatDate } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Panel, PanelBody, PageHeader } from '@/components/ui/surface';
import { Skeleton } from '@/components/ui/feedback';

interface AuditEntry {
  id: string;
  actorName: string | null;
  actorRole: string | null;
  action: string;
  outcome: string;
  targetClinicId: string | null;
  targetClinicName: string | null;
  reason: string | null;
  occurredAt: string;
}

/**
 * What operators did.
 *
 * Separate from any clinic's own activity log, and append-only at the database
 * level: a trigger rejects UPDATE and DELETE, so an operator cannot edit the
 * record of their own mistake. This is the log a clinic gets shown when it asks
 * why it was suspended.
 */
export default function PlatformAuditPage() {
  const audit = useQuery({
    queryKey: ['platform', 'audit'],
    queryFn: () => api.get<{ items: AuditEntry[] }>('/platform/audit'),
  });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Operator log"
        description="Every action taken from this console. Append-only — it cannot be edited or deleted."
      />

      {audit.isLoading ? <Skeleton className="h-64 w-full" /> : null}

      <Panel>
        <PanelBody className="flex flex-col gap-2">
          {(audit.data?.items ?? []).length === 0 && !audit.isLoading ? (
            <p className="py-8 text-center text-sm text-ink-faint">Nothing recorded yet.</p>
          ) : null}

          {(audit.data?.items ?? []).map((entry) => (
            <div
              key={entry.id}
              className="flex flex-col gap-1 border-b border-line-soft pb-2 last:border-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-ink">
                  {entry.action.replaceAll('_', ' ').toLowerCase()}
                </span>
                {entry.outcome !== 'SUCCESS' ? (
                  <Badge tone="critical">{entry.outcome}</Badge>
                ) : null}
                {entry.targetClinicName ? (
                  entry.targetClinicId ? (
                    <Link
                      href={`/platform/tenants/${entry.targetClinicId}`}
                      className="text-xs text-accent hover:underline"
                    >
                      {entry.targetClinicName}
                    </Link>
                  ) : (
                    <span className="text-xs text-ink-soft">{entry.targetClinicName}</span>
                  )
                ) : null}
                <span className="ml-auto text-2xs text-ink-faint">
                  {formatDate(entry.occurredAt)}
                </span>
              </div>

              <p className="text-xs text-ink-faint">
                {entry.actorName ?? 'Unknown'}
                {entry.actorRole ? ` · ${entry.actorRole.replace('_', ' ')}` : ''}
              </p>

              {entry.reason ? (
                <p className="text-xs text-ink-soft">{entry.reason}</p>
              ) : null}
            </div>
          ))}
        </PanelBody>
      </Panel>
    </div>
  );
}
