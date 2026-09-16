'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Eye, ScrollText } from 'lucide-react';
import type { AuditEvent } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { formatDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Input, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/surface';
import { Table, TableShell, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Alert, EmptyState, SkeletonRows } from '@/components/ui/feedback';

/**
 * The activity log.
 *
 * Who did what, to which record, and whether it succeeded. Never what was
 * recorded — free-text clinical values are hashed rather than copied here, so
 * the log does not become a second, uncontrolled copy of the clinical record
 * with different retention rules.
 *
 * Administrator access to a clinical record the administrator did not author is
 * marked distinctly. That is a transparency measure, not a restriction: a
 * practice can show its clinicians exactly when management viewed a record,
 * which is what makes that access acceptable to them.
 */
export default function AuditPage() {
  const [outcome, setOutcome] = React.useState('');
  const [term, setTerm] = React.useState('');

  const { data, isLoading } = useQuery({
    queryKey: qk.auditEvents(`${outcome}|${term}`),
    queryFn: () =>
      api.get<{ items: AuditEvent[] }>('/audit-events', {
        query: { outcome: outcome || undefined, q: term || undefined },
      }),
    // Never served from the local cache — the trail is always read live.
    staleTime: 0,
    gcTime: 0,
  });

  const events = data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Activity log"
        description="Every recorded action, in order. This log cannot be edited or deleted."
      />

      <Alert tone="info" title="This log shows actions, not clinical content">
        You can see that a record was opened, changed or shared, and by whom. The
        contents of that record are not shown here.
      </Alert>

      <div className="flex flex-wrap gap-2">
        <Input
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Filter by person or action"
          aria-label="Filter the activity log"
          className="max-w-xs"
        />
        <Select
          value={outcome}
          onChange={(event) => setOutcome(event.target.value)}
          aria-label="Filter by outcome"
          className="w-44"
        >
          <option value="">All outcomes</option>
          <option value="SUCCESS">Succeeded</option>
          <option value="SERIOUS_FAILURE">Refused</option>
          <option value="MINOR_FAILURE">Rejected</option>
          <option value="MAJOR_FAILURE">Serious failure</option>
        </Select>
      </div>

      <TableShell footer={<span>{events.length} events</span>}>
        {isLoading ? (
          <SkeletonRows rows={8} />
        ) : events.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="No activity recorded yet"
            description="Actions appear here as staff use the system."
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>When</TH>
                <TH>Who</TH>
                <TH>Did what</TH>
                <TH>To</TH>
                <TH>Outcome</TH>
              </tr>
            </THead>
            <TBody>
              {events.map((event) => (
                <TR key={event.id}>
                  <TD className="whitespace-nowrap tabular">
                    {formatDateTime(event.occurredAt)}
                  </TD>
                  <TD>
                    <span className="block text-ink">{event.actorName ?? 'System'}</span>
                    <span className="block text-2xs text-ink-faint">
                      {event.actorRole ?? event.actorType}
                    </span>
                  </TD>
                  <TD>
                    <span className="flex items-center gap-1.5">
                      <span className="token text-xs">{event.action}</span>
                      {event.isElevatedVisibility ? (
                        <Badge tone="warning">
                          <Eye aria-hidden />
                          Management access
                        </Badge>
                      ) : null}
                    </span>
                  </TD>
                  <TD>
                    {event.resourceLabel ?? event.resourceType ?? '—'}
                  </TD>
                  <TD>
                    <Badge
                      tone={
                        event.outcome === 'SUCCESS'
                          ? 'positive'
                          : event.outcome === 'MINOR_FAILURE'
                            ? 'neutral'
                            : 'critical'
                      }
                    >
                      {event.outcome === 'SUCCESS'
                        ? 'Succeeded'
                        : event.outcome === 'SERIOUS_FAILURE'
                          ? 'Refused'
                          : event.outcome === 'MINOR_FAILURE'
                            ? 'Rejected'
                            : 'Serious failure'}
                    </Badge>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </TableShell>
    </div>
  );
}
