'use client';

import * as React from 'react';
import Link from 'next/link';
import { FlaskConical, LineChart, Microscope, ShieldCheck } from 'lucide-react';
import { useCohorts, useDataQuality } from '@/features/research/api';
import { formatDateTime, relativeTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataState, StatRow } from '@/components/ui/data-state';
import { Alert, SkeletonRows } from '@/components/ui/feedback';
import { PageHeader, Panel, PanelBody, PanelHeader, Stat } from '@/components/ui/surface';

/**
 * The analytics overview.
 *
 * DATA QUALITY IS ABOVE THE COHORTS, and that ordering is the argument of the whole
 * panel. A cohort built on 40% missing diagnosis codes is not a finding, and the only
 * way anybody discovers that is by being shown it before they start. Every other
 * product in this market puts the charts first.
 */
export default function AnalyticsOverviewPage() {
  const to = React.useMemo(() => new Date().toISOString().slice(0, 10), []);
  const from = React.useMemo(
    () => new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10),
    [],
  );

  const quality = useDataQuality(from, to);
  const cohorts = useCohorts();

  const metrics = quality.data?.metrics ?? [];
  const poor = metrics.filter((m) => m.verdict === 'poor');
  const watch = metrics.filter((m) => m.verdict === 'watch');
  const coding = metrics.find((m) => m.key === 'diagnoses-coded');
  const signed = metrics.find((m) => m.key === 'encounters-finalised');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Analytics"
        description="Governed, de-identified analysis of this clinic's own records."
        actions={
          <Button variant="primary" asChild>
            <Link href="/analytics/cohorts">
              <Microscope aria-hidden />
              Build a cohort
            </Link>
          </Button>
        }
      />

      <Alert tone="info" title="You are looking at counts, not people">
        This panel returns age bands, codes and totals. There is no screen here — and no
        endpoint behind it — that returns a name, a phone number or a record number.
        Breakdown cells with fewer than five patients are hidden rather than shown.
      </Alert>

      {quality.isLoading ? (
        <SkeletonRows rows={4} />
      ) : (
        <StatRow>
          <Stat
            label="Consultations signed"
            value={signed?.percent === null || signed === undefined ? '—' : `${signed.percent}%`}
            tone={verdictTone(signed?.verdict)}
            hint="Unsigned consultations are invisible to every cohort"
          />
          <Stat
            label="Diagnoses coded"
            value={coding?.percent === null || coding === undefined ? '—' : `${coding.percent}%`}
            tone={verdictTone(coding?.verdict)}
            hint="Uncoded diagnoses cannot be filtered on"
          />
          <Stat
            label="Measures needing attention"
            value={poor.length}
            tone={poor.length > 0 ? 'critical' : 'positive'}
          />
          <Stat label="Saved cohorts" value={cohorts.data?.length ?? 0} />
        </StatRow>
      )}

      {/* ---- The honest prerequisite ------------------------------------- */}
      <Panel className={poor.length > 0 ? 'border-critical-line' : undefined}>
        <PanelHeader
          title="Before you analyse anything"
          description="Ninety days. Each figure is about the completeness of the record, not about a patient."
          actions={
            <Button size="sm" variant="secondary" asChild>
              <Link href="/analytics/quality">
                <FlaskConical aria-hidden />
                Full report
              </Link>
            </Button>
          }
        />
        <PanelBody className="space-y-2">
          {quality.isLoading ? (
            <SkeletonRows rows={3} />
          ) : poor.length === 0 && watch.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-positive">
              <ShieldCheck className="size-4" aria-hidden />
              Every completeness measure is above 90%. Cohorts built on this data will be
              representative.
            </div>
          ) : (
            [...poor, ...watch].slice(0, 5).map((metric) => (
              <div
                key={metric.key}
                className="rounded-md border border-line bg-surface px-3 py-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink">{metric.label}</span>
                  <Badge tone={metric.verdict === 'poor' ? 'critical' : 'warning'}>
                    {metric.percent === null ? 'no data' : `${metric.percent}%`}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-ink-faint">{metric.definition}</p>
              </div>
            ))
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="Saved cohorts"
          description="A cohort stores the question, not the answer — it is re-evaluated against live data every time."
        />
        <PanelBody>
          <DataState
            query={cohorts}
            empty={{
              icon: LineChart,
              title: 'No cohorts yet',
              description:
                'Define one and it becomes a question you can re-ask every month.',
              action: (
                <Button variant="primary" asChild>
                  <Link href="/analytics/cohorts">Build a cohort</Link>
                </Button>
              ),
            }}
          >
            {(items) => (
              <div className="space-y-2">
                {items.map((cohort) => (
                  <Link
                    key={cohort.id}
                    href={`/analytics/cohorts?open=${cohort.id}`}
                    className="block rounded-md border border-line bg-surface px-3 py-2 hover:bg-surface-sunk"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-ink">{cohort.name}</span>
                      <span className="flex items-center gap-2">
                        {cohort.isShared ? <Badge tone="info">Shared</Badge> : null}
                        <Badge>v{cohort.definitionVersion}</Badge>
                        {cohort.lastEvaluatedSize !== null ? (
                          <span className="tabular text-xs text-ink-soft">
                            {cohort.lastEvaluatedSize} patients
                          </span>
                        ) : null}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-faint">{cohort.purpose}</p>
                    <p className="mt-0.5 text-2xs text-ink-faint">
                      {cohort.lastEvaluatedAt
                        ? `Last run ${relativeTime(cohort.lastEvaluatedAt)} · figures change as the data does`
                        : 'Never run'}
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </DataState>
        </PanelBody>
      </Panel>

      {quality.data ? (
        <p className="text-2xs text-ink-faint">
          Quality figures computed {formatDateTime(quality.data.generatedAt)}. Nothing on
          this panel is cached overnight — a stale quality figure is worse than none,
          because somebody would act on it.
        </p>
      ) : null}
    </div>
  );
}

function verdictTone(verdict?: string) {
  if (verdict === 'poor') return 'critical' as const;
  if (verdict === 'watch') return 'warning' as const;
  if (verdict === 'good') return 'positive' as const;
  return 'neutral' as const;
}
