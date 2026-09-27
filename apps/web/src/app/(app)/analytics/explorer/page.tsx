'use client';

import * as React from 'react';
import { Activity, Play } from 'lucide-react';
import type { CohortFilters } from '@emr/contracts';
import { usePreviewCohort, type CohortResult } from '@/features/research/api';
import {
  CohortBuilder,
  SuppressionNote,
  defaultFilters,
} from '@/features/research/cohort-builder';
import { ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { StatRow } from '@/components/ui/data-state';
import { Alert, EmptyState } from '@/components/ui/feedback';
import { PageHeader, Panel, PanelBody, PanelHeader, Stat } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';

/**
 * The trend explorer.
 *
 * Same evaluator, same projection, same suppression as the cohort screen — this one
 * simply renders the time series rather than the breakdown. Building a second query path
 * for it would mean two definitions of what a cohort means, which is how two screens in
 * the same product come to disagree about the same number.
 *
 * MONTH PRECISION, ALWAYS. Not a configurable granularity: a daily series over a small
 * cohort combined with an age band gets close to identifying a person, and there is no
 * clinical question at a five-doctor clinic that needs day-level trend.
 */
export default function ExplorerPage() {
  const toast = useToast();
  const preview = usePreviewCohort();
  const [filters, setFilters] = React.useState<CohortFilters>(defaultFilters);
  const [result, setResult] = React.useState<CohortResult | null>(null);

  const run = () =>
    preview.mutate(filters, {
      onSuccess: setResult,
      onError: (error) =>
        toast.error(error instanceof ApiError ? error.message : 'That did not run'),
    });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Explorer"
        description="How a group changed over time. Month by month, never day by day."
        actions={
          <Button variant="primary" loading={preview.isPending} onClick={run}>
            <Play aria-hidden />
            Run
          </Button>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <Panel>
          <PanelHeader title="Definition" />
          <PanelBody>
            <CohortBuilder
              value={filters}
              onChange={setFilters}
              disabled={preview.isPending}
            />
          </PanelBody>
        </Panel>

        <div className="space-y-4">
          {!result ? (
            <Panel>
              <PanelBody>
                <EmptyState
                  icon={Activity}
                  title="Nothing run yet"
                  description="Set a range on the left and press Run."
                />
              </PanelBody>
            </Panel>
          ) : (
            <>
              <StatRow columns={3}>
                <Stat label="Patients" value={result.summary.size} />
                <Stat label="Consultations" value={result.summary.encounterCount} />
                <Stat
                  label="Months covered"
                  value={result.summary.byMonth.length}
                  hint={`Generated ${formatDateTime(result.summary.generatedAt)}`}
                />
              </StatRow>

              <Panel>
                <PanelHeader
                  title="Patients by month"
                  description="A hidden bar is a month with fewer than five patients, not a month with none."
                />
                <PanelBody>
                  <MonthSeries
                    series={result.summary.byMonth}
                    pick={(row) => row.patients}
                    label="patients"
                  />
                  <SuppressionNote
                    suppressedCellCount={result.summary.suppressedCellCount}
                    threshold={result.summary.smallCellThreshold}
                  />
                </PanelBody>
              </Panel>

              <Panel>
                <PanelHeader
                  title="New patients by month"
                  description="First visit in the period — a retention signal rather than a volume one."
                />
                <PanelBody>
                  <MonthSeries
                    series={result.summary.byMonth}
                    pick={(row) => row.newPatients}
                    label="new patients"
                  />
                </PanelBody>
              </Panel>

              {result.summary.topMolecules.length > 0 ? (
                <Panel>
                  <PanelHeader
                    title="Treatment patterns"
                    description="Generic names. Prescriptions typed freehand without a catalogue link are missing from these counts."
                  />
                  <PanelBody className="space-y-1">
                    {result.summary.topMolecules.map((row) => (
                      <div key={row.molecule} className="flex items-center gap-2">
                        <span className="w-40 shrink-0 truncate text-xs text-ink-soft">
                          {row.molecule}
                        </span>
                        <div className="h-4 min-w-0 flex-1 overflow-hidden rounded-sm bg-surface-sunk">
                          <div
                            className={cn(
                              'h-full rounded-sm',
                              row.count === null ? 'w-2 bg-line-strong' : 'bg-chronic',
                            )}
                            style={
                              row.count === null
                                ? undefined
                                : {
                                    width: `${Math.max(
                                      (row.count /
                                        Math.max(
                                          ...result.summary.topMolecules.map(
                                            (m) => m.count ?? 0,
                                          ),
                                          1,
                                        )) *
                                        100,
                                      2,
                                    )}%`,
                                  }
                            }
                          />
                        </div>
                        <span className="w-12 shrink-0 text-right tabular text-xs text-ink">
                          {row.count === null ? (
                            <span className="text-ink-faint">hidden</span>
                          ) : (
                            row.count
                          )}
                        </span>
                      </div>
                    ))}
                  </PanelBody>
                </Panel>
              ) : null}

              <Alert tone="info" title="These figures move as the record does">
                A cohort stores the question, not the answer. Running the same definition
                next month legitimately gives a different count — that is the point of it,
                and it is why an export records the version it ran against.
              </Alert>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MonthSeries({
  series,
  pick,
  label,
}: {
  series: { month: string; patients: number | null; newPatients: number | null; encounters: number | null }[];
  pick: (row: {
    month: string;
    patients: number | null;
    newPatients: number | null;
    encounters: number | null;
  }) => number | null;
  label: string;
}) {
  if (series.length === 0) return <EmptyState title="No months in range" />;

  const max = Math.max(...series.map((row) => pick(row) ?? 0), 1);

  return (
    <div
      className="flex h-36 items-end gap-1.5"
      role="img"
      aria-label={`${label} by month: ${series
        .map((row) => `${row.month}, ${pick(row) ?? 'hidden'}`)
        .join('; ')}`}
    >
      {series.map((row) => {
        const value = pick(row);
        return (
          <div key={row.month} className="flex min-w-0 flex-1 flex-col items-center gap-1">
            <span className="tabular text-2xs text-ink-faint">
              {value === null ? '·' : value}
            </span>
            {value === null ? (
              <div
                className="w-full rounded-t-sm bg-line-strong"
                style={{ height: '4px' }}
                title="Fewer than five patients — hidden"
              />
            ) : (
              <div
                className="w-full rounded-t-sm bg-accent"
                style={{ height: `${Math.max((value / max) * 100, 2)}%` }}
                title={`${value} ${label} in ${row.month}`}
              />
            )}
            <span className="truncate text-2xs text-ink-faint">{row.month.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}
