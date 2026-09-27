'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { Download, Microscope, Play, Plus, Save, Trash2 } from 'lucide-react';
import type { Cohort, CohortFilters } from '@emr/contracts';
import {
  downloadCohortCsv,
  useCohorts,
  useDeleteCohort,
  useEvaluateCohort,
  usePreviewCohort,
  useRequestExport,
  useSaveCohort,
  type CohortResult,
} from '@/features/research/api';
import {
  CohortBuilder,
  SuppressionNote,
  defaultFilters,
} from '@/features/research/cohort-builder';
import { ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { DataState, StatRow } from '@/components/ui/data-state';
import { Alert } from '@/components/ui/feedback';
import { PageHeader, Panel, PanelBody, PanelHeader, Stat } from '@/components/ui/surface';
import { Table, TBody, TD, TH, THead, TR, TableScroller } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Cohorts: define, run, save, export.
 *
 * PREVIEW AND SAVED RUN GO THROUGH THE SAME EVALUATOR, so what a preview shows is
 * exactly what saving it would produce. A preview that could differ from the real
 * thing is worse than no preview.
 *
 * EXPORT CARRIES ITS PROVENANCE. The definition as it was, its version, the generation
 * time and the exact column list are recorded server-side before the file is built —
 * so a figure quoted in a report next year is traceable, and a reviewer can confirm no
 * identifying column was included without reading the file.
 */
export default function CohortsPage() {
  const params = useSearchParams();
  const openId = params.get('open');

  const toast = useToast();
  const cohorts = useCohorts();
  const preview = usePreviewCohort();
  const evaluate = useEvaluateCohort();
  const remove = useDeleteCohort();

  const [filters, setFilters] = React.useState<CohortFilters>(defaultFilters);
  const [result, setResult] = React.useState<CohortResult | null>(null);
  const [activeCohort, setActiveCohort] = React.useState<Cohort | null>(null);
  const [saveOpen, setSaveOpen] = React.useState(false);

  /* Deep link from the overview opens and runs that cohort. */
  React.useEffect(() => {
    if (!openId || !cohorts.data) return;
    const found = cohorts.data.find((c) => c.id === openId);
    if (!found) return;
    setActiveCohort(found);
    setFilters(found.filters);
    evaluate.mutate(found.id, { onSuccess: setResult });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, cohorts.data]);

  const run = () => {
    if (activeCohort) {
      evaluate.mutate(activeCohort.id, {
        onSuccess: setResult,
        onError: (error) =>
          toast.error(error instanceof ApiError ? error.message : 'That did not run'),
      });
      return;
    }
    preview.mutate(filters, {
      onSuccess: setResult,
      onError: (error) =>
        toast.error(error instanceof ApiError ? error.message : 'That did not run'),
    });
  };

  const running = preview.isPending || evaluate.isPending;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Cohorts"
        description={
          activeCohort
            ? `${activeCohort.name} — version ${activeCohort.definitionVersion}`
            : 'Define a group by its characteristics, never by its members.'
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {activeCohort ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setActiveCohort(null);
                  setFilters(defaultFilters());
                  setResult(null);
                }}
              >
                <Plus aria-hidden />
                New definition
              </Button>
            ) : null}
            <Button variant="secondary" onClick={() => setSaveOpen(true)}>
              <Save aria-hidden />
              {activeCohort ? 'Save changes' : 'Save cohort'}
            </Button>
            <Button variant="primary" loading={running} onClick={run}>
              <Play aria-hidden />
              Run
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Panel>
            <PanelHeader title="Definition" />
            <PanelBody>
              <CohortBuilder value={filters} onChange={setFilters} disabled={running} />
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader title="Saved" description="Shared cohorts are visible to the whole clinic." />
            <PanelBody>
              <DataState
                query={cohorts}
                empty={{ icon: Microscope, title: 'Nothing saved yet' }}
                skeletonRows={3}
              >
                {(items) => (
                  <div className="space-y-1.5">
                    {items.map((cohort) => (
                      <div
                        key={cohort.id}
                        className="flex items-start justify-between gap-2 rounded-md border border-line px-2.5 py-2"
                      >
                        <button
                          type="button"
                          className="min-w-0 text-left"
                          onClick={() => {
                            setActiveCohort(cohort);
                            setFilters(cohort.filters);
                            setResult(null);
                          }}
                        >
                          <span className="block truncate text-sm font-medium text-ink">
                            {cohort.name}
                          </span>
                          <span className="block truncate text-2xs text-ink-faint">
                            {cohort.purpose}
                          </span>
                        </button>
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Delete ${cohort.name}`}
                          onClick={() =>
                            remove.mutate(cohort.id, {
                              onSuccess: () => {
                                toast.success('Cohort deleted');
                                if (activeCohort?.id === cohort.id) setActiveCohort(null);
                              },
                            })
                          }
                        >
                          <Trash2 aria-hidden />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </DataState>
            </PanelBody>
          </Panel>
        </div>

        <div className="space-y-4">
          {result ? (
            <Results result={result} cohort={activeCohort} filters={filters} />
          ) : (
            <Panel>
              <PanelBody>
                <Alert tone="info" title="Nothing run yet">
                  Set a date range and press Run. The definition on the left is the whole
                  of the cohort — there is no hidden filter.
                </Alert>
              </PanelBody>
            </Panel>
          )}
        </div>
      </div>

      <SaveDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        filters={filters}
        existing={activeCohort}
        onSaved={(cohort) => setActiveCohort(cohort)}
      />
    </div>
  );
}

function Results({
  result,
  cohort,
  filters,
}: {
  result: CohortResult;
  cohort: Cohort | null;
  filters: CohortFilters;
}) {
  const toast = useToast();
  const request = useRequestExport();
  const { summary } = result;

  return (
    <>
      <StatRow columns={4}>
        <Stat label="Patients" value={summary.size} />
        <Stat label="Consultations" value={summary.encounterCount} />
        <Stat
          label="Follow-up completed"
          value={summary.followUp.ratePercent === null ? '—' : `${summary.followUp.ratePercent}%`}
          hint={
            summary.followUp.ratePercent === null
              ? `Base of ${summary.followUp.instructed} is too small to report`
              : `${summary.followUp.completed} of ${summary.followUp.instructed}`
          }
        />
        <Stat
          label="Hidden cells"
          value={summary.suppressedCellCount}
          tone={summary.suppressedCellCount > 0 ? 'warning' : 'neutral'}
          hint={`Below ${summary.smallCellThreshold} patients`}
        />
      </StatRow>

      <Panel>
        <PanelHeader
          title="Breakdown"
          description={`Generated ${formatDateTime(summary.generatedAt)}`}
          actions={
            <Button
              size="sm"
              variant="secondary"
              loading={request.isPending}
              onClick={() =>
                request.mutate(
                  {
                    cohortId: cohort?.id ?? null,
                    filters: cohort ? undefined : filters,
                    exportType: 'COHORT_ROWS',
                  },
                  {
                    onSuccess: (data) => {
                      downloadCohortCsv(
                        data.rows,
                        data.columnsIncluded,
                        `${(cohort?.name ?? 'cohort').replace(/\W+/g, '-')}-${summary.generatedAt.slice(0, 10)}.csv`,
                      );
                      toast.success(`${data.rowCount} rows exported`);
                    },
                    onError: (error) =>
                      toast.error(
                        error instanceof ApiError ? error.message : 'That did not export',
                      ),
                  },
                )
              }
            >
              <Download aria-hidden />
              Export CSV
            </Button>
          }
        />
        <PanelBody className="space-y-4">
          <Breakdown
            title="By age band"
            rows={summary.byAgeBand.map((row) => ({ label: row.band, count: row.count }))}
            total={summary.size}
          />
          <Breakdown
            title="By sex"
            rows={summary.bySex.map((row) => ({ label: row.sex, count: row.count }))}
            total={summary.size}
          />
          <SuppressionNote
            suppressedCellCount={summary.suppressedCellCount}
            threshold={summary.smallCellThreshold}
          />
        </PanelBody>
      </Panel>

      {summary.topDiagnoses.length > 0 ? (
        <Panel>
          <PanelHeader
            title="Diagnoses in this cohort"
            description="Coded diagnoses only. Uncoded ones are absent from this list, not zero."
          />
          <PanelBody>
            <TableScroller>
              <Table>
                <THead>
                  <TR>
                    <TH>Code</TH>
                    <TH>Diagnosis</TH>
                    <TH align="right">Patients</TH>
                  </TR>
                </THead>
                <TBody>
                  {summary.topDiagnoses.map((row) => (
                    <TR key={row.code}>
                      <TD className="token">{row.code}</TD>
                      <TD>{row.display}</TD>
                      <TD align="right" className="tabular">
                        {row.count === null ? (
                          <Badge tone="neutral">hidden</Badge>
                        ) : (
                          row.count
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableScroller>
          </PanelBody>
        </Panel>
      ) : null}

      {summary.byMonth.length > 0 ? (
        <Panel>
          <PanelHeader title="By month" description="Month precision — never a date." />
          <PanelBody>
            <TableScroller>
              <Table>
                <THead>
                  <TR>
                    <TH>Month</TH>
                    <TH align="right">Patients</TH>
                    <TH align="right">New</TH>
                    <TH align="right">Consultations</TH>
                  </TR>
                </THead>
                <TBody>
                  {summary.byMonth.map((row) => (
                    <TR key={row.month}>
                      <TD className="token">{row.month}</TD>
                      <TD align="right" className="tabular">
                        {row.patients ?? <Badge>hidden</Badge>}
                      </TD>
                      <TD align="right" className="tabular">
                        {row.newPatients ?? <Badge>hidden</Badge>}
                      </TD>
                      <TD align="right" className="tabular">
                        {row.encounters ?? <Badge>hidden</Badge>}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableScroller>
          </PanelBody>
        </Panel>
      ) : null}
    </>
  );
}

/** A labelled bar row per category, with hidden cells shown as hidden. */
function Breakdown({
  title,
  rows,
  total,
}: {
  title: string;
  rows: { label: string; count: number | null }[];
  total: number;
}) {
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((r) => r.count ?? 0), 1);

  return (
    <div>
      <p className="text-2xs uppercase tracking-wide text-ink-faint">{title}</p>
      <div className="mt-1.5 space-y-1">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center gap-2">
            <span className="w-24 shrink-0 truncate text-xs text-ink-soft">{row.label}</span>
            <div className="h-4 min-w-0 flex-1 overflow-hidden rounded-sm bg-surface-sunk">
              {row.count === null ? (
                <div className="h-full w-2 bg-line-strong" />
              ) : (
                <div
                  className="h-full rounded-sm bg-accent"
                  style={{ width: `${Math.max((row.count / max) * 100, 2)}%` }}
                />
              )}
            </div>
            <span className="w-16 shrink-0 text-right tabular text-xs text-ink">
              {row.count === null ? (
                <span className="text-ink-faint">hidden</span>
              ) : total > 0 ? (
                `${row.count} · ${Math.round((row.count / total) * 100)}%`
              ) : (
                row.count
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SaveDialog({
  open,
  onOpenChange,
  filters,
  existing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: CohortFilters;
  existing: Cohort | null;
  onSaved: (cohort: Cohort) => void;
}) {
  const toast = useToast();
  const save = useSaveCohort();
  const [name, setName] = React.useState('');
  const [purpose, setPurpose] = React.useState('');
  const [isShared, setIsShared] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setName(existing?.name ?? '');
    setPurpose(existing?.purpose ?? '');
    setIsShared(existing?.isShared ?? false);
  }, [open, existing]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? 'Save changes' : 'Save this cohort'}</DialogTitle>
        </DialogHeader>

        <Field label="Name" htmlFor="cohort-name" required>
          <Input
            id="cohort-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Diabetics over 45, last two quarters"
          />
        </Field>

        <Field
          label="What question does this answer"
          htmlFor="cohort-purpose"
          required
          hint="Required, and not a formality: a saved definition nobody can explain six months later is a liability."
        >
          <Input
            id="cohort-purpose"
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
            placeholder="Are we reviewing our diabetic patients at least twice a year?"
          />
        </Field>

        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={isShared}
            onChange={(event) => setIsShared(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            Share with the clinic
            <span className="block text-2xs text-ink-faint">
              Private by default, because a half-built definition read as finished is how
              wrong numbers escape.
            </span>
          </span>
        </label>

        {existing ? (
          <Alert tone="info" title="Changing the filters bumps the version">
            Renaming it does not. An export always records the version it ran against, so
            an old figure stays traceable to the definition that produced it.
          </Alert>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={name.trim().length < 3 || purpose.trim().length < 10}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                { id: existing?.id, name, purpose, filters, isShared, chartConfig: null },
                {
                  onSuccess: (cohort) => {
                    toast.success('Cohort saved');
                    onSaved(cohort);
                    onOpenChange(false);
                  },
                  onError: (error) =>
                    toast.error(
                      error instanceof ApiError ? error.message : 'That did not save',
                    ),
                },
              )
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
