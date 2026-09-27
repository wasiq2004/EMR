'use client';

import * as React from 'react';
import { FlaskConical } from 'lucide-react';
import { useDataQuality } from '@/features/research/api';
import { formatDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Field, Input } from '@/components/ui/field';
import { Alert, SkeletonRows } from '@/components/ui/feedback';
import { PageHeader, Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Table, TBody, TD, TH, THead, TR, TableScroller } from '@/components/ui/table';
import { cn } from '@/lib/cn';

/**
 * Data quality — the blueprint's gap #4.
 *
 * WHAT MAKES THIS DIFFERENT from an MIS report: every row states its own definition,
 * on screen, next to the number. A completeness figure whose meaning has to be
 * guessed is a figure people argue about rather than act on.
 *
 * Thresholds are 90% and 70% for completeness measures, and they are conventions
 * rather than findings. They are named here so nobody has to reverse-engineer them
 * from a colour.
 */
export default function DataQualityPage() {
  const [to, setTo] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [from, setFrom] = React.useState(() =>
    new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10),
  );

  const report = useDataQuality(from, to);
  const metrics = report.data?.metrics ?? [];
  const poor = metrics.filter((m) => m.verdict === 'poor');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Data quality"
        description="How complete the record is. The honest prerequisite for any cohort built on it."
        actions={
          <div className="flex items-end gap-2">
            <Field label="From" htmlFor="dq-from">
              <Input
                id="dq-from"
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </Field>
            <Field label="To" htmlFor="dq-to">
              <Input
                id="dq-to"
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </Field>
          </div>
        }
      />

      {poor.length > 0 ? (
        <Alert
          tone="warning"
          title={`${poor.length} measure${poor.length === 1 ? '' : 's'} below 70%`}
        >
          Cohorts that filter on these fields will under-count, and the shortfall will look
          like a finding rather than a gap. Fix the recording before drawing conclusions.
        </Alert>
      ) : null}

      <Panel>
        <PanelHeader
          title="Measures"
          description="Every figure is about the record, never about a patient."
        />
        <PanelBody>
          {report.isLoading ? (
            <SkeletonRows rows={8} />
          ) : (
            <div className="space-y-2">
              {metrics.map((metric) => (
                <div key={metric.key} className="rounded-md border border-line px-3 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium text-ink">{metric.label}</span>
                    <span className="flex items-center gap-2">
                      <span className="tabular text-xs text-ink-faint">
                        {metric.numerator} of {metric.denominator}
                      </span>
                      <Badge
                        tone={
                          metric.verdict === 'poor'
                            ? 'critical'
                            : metric.verdict === 'watch'
                              ? 'warning'
                              : metric.verdict === 'good'
                                ? 'positive'
                                : 'neutral'
                        }
                      >
                        {metric.percent === null ? 'no data' : `${metric.percent}%`}
                      </Badge>
                    </span>
                  </div>

                  {metric.percent !== null ? (
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-sunk">
                      <div
                        className={cn(
                          'h-full rounded-full',
                          metric.verdict === 'poor'
                            ? 'bg-critical'
                            : metric.verdict === 'watch'
                              ? 'bg-warning'
                              : 'bg-positive',
                        )}
                        style={{ width: `${metric.percent}%` }}
                      />
                    </div>
                  ) : null}

                  <p className="mt-1.5 text-xs text-ink-faint">{metric.definition}</p>
                </div>
              ))}
            </div>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="Field completeness"
          description="Per field, so a gap can be traced to the screen that should have captured it."
        />
        <PanelBody>
          {report.isLoading ? (
            <SkeletonRows rows={6} />
          ) : (
            <TableScroller>
              <Table>
                <THead>
                  <TR>
                    <TH>Entity</TH>
                    <TH>Field</TH>
                    <TH align="right">Present</TH>
                    <TH align="right">Of</TH>
                    <TH align="right">Complete</TH>
                  </TR>
                </THead>
                <TBody>
                  {(report.data?.fieldCompleteness ?? []).map((row) => (
                    <TR key={`${row.entity}.${row.field}`}>
                      <TD className="text-ink-soft">{row.entity}</TD>
                      <TD className="token text-xs">{row.field}</TD>
                      <TD align="right" className="tabular">
                        {row.present}
                      </TD>
                      <TD align="right" className="tabular text-ink-faint">
                        {row.total}
                      </TD>
                      <TD align="right">
                        <Badge
                          tone={
                            row.percent >= 90
                              ? 'positive'
                              : row.percent >= 70
                                ? 'warning'
                                : 'critical'
                          }
                        >
                          {row.percent}%
                        </Badge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableScroller>
          )}
        </PanelBody>
      </Panel>

      {report.data ? (
        <p className="flex items-center gap-1.5 text-2xs text-ink-faint">
          <FlaskConical className="size-3" aria-hidden />
          Computed {formatDateTime(report.data.generatedAt)} — never cached, because a
          stale quality figure is worse than none.
        </p>
      ) : null}
    </div>
  );
}
