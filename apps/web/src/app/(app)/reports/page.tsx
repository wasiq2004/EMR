'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { BarChart3 } from 'lucide-react';
import type { ReportSummary } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { formatPaise, formatPaiseShort } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Panel, PanelBody, PanelHeader, PageHeader, Stat } from '@/components/ui/surface';
import { SkeletonRows } from '@/components/ui/feedback';

/**
 * Reports.
 *
 * Deliberately small: visits, collections, appointments and no-shows over a
 * period. Anything that needs a finance team is out of scope.
 */
export default function ReportsPage() {
  const router = useRouter();
  const { data, isLoading } = useQuery({
    queryKey: qk.reports('14d', 'today'),
    queryFn: () => api.get<ReportSummary>('/reports/summary'),
  });

  const series = data?.series ?? [];
  const maxVisits = Math.max(1, ...series.map((point) => point.visits));
  const maxCollections = Math.max(1, ...series.map((point) => point.collectionsPaise));

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <PageHeader
        title="Reports"
        description="Last 14 days"
        actions={
          /*
           * This was a button with no handler — it looked like an export and did
           * nothing. The dashboard is a fixed trailing window and has nothing to
           * export that a reader cannot see; the filtered, groupable, exportable
           * version is its own screen, so the control now goes there instead of
           * pretending.
           */
          <Button variant="secondary" onClick={() => router.push('/reports/analytics')}>
            <BarChart3 aria-hidden />
            Analytics and exports
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Panel>
          <PanelBody>
            <Stat label="Visits" value={isLoading ? '—' : (data?.visits ?? 0)} />
          </PanelBody>
        </Panel>
        <Panel>
          <PanelBody>
            <Stat
              label="New patients"
              value={isLoading ? '—' : (data?.newPatients ?? 0)}
            />
          </PanelBody>
        </Panel>
        <Panel>
          <PanelBody>
            <Stat
              label="Collected"
              value={isLoading ? '—' : formatPaiseShort(data?.collectionsPaise ?? 0)}
            />
          </PanelBody>
        </Panel>
        <Panel>
          <PanelBody>
            <Stat
              label="No-shows"
              value={isLoading ? '—' : (data?.noShows ?? 0)}
              tone={(data?.noShows ?? 0) > 5 ? 'warning' : 'neutral'}
            />
          </PanelBody>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Visits per day" description="Hover a bar for the figure" />
        <PanelBody>
          {isLoading ? (
            <SkeletonRows rows={3} />
          ) : (
            <>
              <div
                className="flex h-40 items-end gap-1.5"
                role="img"
                aria-label={`Visits per day over the last ${series.length} days, peaking at ${maxVisits}`}
              >
                {series.map((point) => (
                  <div
                    key={point.date}
                    className="group flex flex-1 flex-col items-center gap-1"
                  >
                    <span className="text-2xs tabular text-ink-faint opacity-0 group-hover:opacity-100">
                      {point.visits}
                    </span>
                    <div
                      className={
                        point.visits === maxVisits
                          ? 'w-full rounded-t-xs bg-accent'
                          : 'w-full rounded-t-xs bg-accent/35'
                      }
                      style={{
                        height: `${Math.max((point.visits / maxVisits) * 100, 4)}%`,
                      }}
                      title={`${point.visits} visits on ${point.date}`}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-2 flex justify-between text-2xs tabular text-ink-faint">
                <span>{series[0]?.date}</span>
                <span>Peak {maxVisits}</span>
                <span>{series.at(-1)?.date}</span>
              </div>
            </>
          )}
        </PanelBody>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Collections per day" />
          <PanelBody>
            <ul className="flex flex-col gap-1.5">
              {series.slice(-7).map((point) => (
                <li key={point.date} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-2xs tabular text-ink-faint">
                    {point.date.slice(5)}
                  </span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunk">
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{
                        width: `${(point.collectionsPaise / maxCollections) * 100}%`,
                      }}
                    />
                  </span>
                  <span className="w-20 shrink-0 text-right text-2xs tabular text-ink">
                    {formatPaiseShort(point.collectionsPaise)}
                  </span>
                </li>
              ))}
            </ul>
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="By doctor" />
          <ul className="divide-y divide-line-soft">
            {(data?.byPractitioner ?? []).map((row) => (
              <li
                key={row.practitionerId}
                className="flex items-center justify-between gap-3 px-4 py-2.5"
              >
                <span className="truncate text-sm text-ink">{row.practitionerName}</span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-medium tabular text-ink">
                    {row.visits} visits
                  </span>
                  <span className="block text-2xs tabular text-ink-faint">
                    {formatPaise(row.collectionsPaise)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
