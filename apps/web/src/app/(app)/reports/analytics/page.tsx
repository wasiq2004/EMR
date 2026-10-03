'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download } from 'lucide-react';
import {
  ANALYTICS_EXPORTS,
  PaymentMethod,
  type AnalyticsBreakdown,
  type ClinicLocation,
  type Practitioner,
  type ServiceItem,
} from '@emr/contracts';
import { ApiError, api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { cn } from '@/lib/cn';
import { formatPaise, formatPaiseShort } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Panel, PanelBody, PanelHeader, PageHeader, Stat } from '@/components/ui/surface';
import { Alert, ErrorState, Skeleton } from '@/components/ui/feedback';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import {
  analyticsExportUrl,
  useClinicAnalytics,
  type AnalyticsQuery,
} from '@/features/analytics/api';

/**
 * Clinic analytics.
 *
 * THE LABELS DO THE WORK ON THIS SCREEN. Every figure here is one somebody can
 * read wrongly, and most of the care has gone into saying which is which rather
 * than into the charts:
 *
 *   * Collected and invoiced are side by side, because showing one as "revenue"
 *     is how a clinic budgets against money it has not received.
 *   * Outstanding says "all time" on it, because it is deliberately not filtered
 *     by the date range — a debt from March is still a debt in June.
 *   * The no-show and cancellation rates print their denominator, because the
 *     obvious denominator is wrong: over all appointments it would count
 *     tomorrow's bookings as attended.
 *   * Utilisation reads "no schedules" rather than 0% when there is nothing to
 *     divide by.
 */
export default function ClinicAnalyticsPage() {
  const [filters, setFilters] = React.useState<AnalyticsQuery>(() => defaultRange());

  const analytics = useClinicAnalytics(filters);

  const { data: staff } = useQuery({
    queryKey: qk.practitioners,
    queryFn: () => api.get<{ items: Practitioner[] }>('/practitioners'),
  });
  const { data: locations } = useQuery({
    queryKey: qk.locations,
    queryFn: () =>
      api.get<{ items: ClinicLocation[] }>('/locations').catch(() => ({ items: [] })),
  });
  const { data: services } = useQuery({
    queryKey: qk.services,
    queryFn: () => api.get<{ items: ServiceItem[] }>('/services').catch(() => ({ items: [] })),
  });

  const set = (patch: Partial<AnalyticsQuery>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/reports"
        className="inline-flex w-fit items-center gap-1.5 text-xs text-ink-faint hover:text-ink"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Reports
      </Link>

      <PageHeader
        title="Clinic analytics"
        description="Revenue, patients and appointments over a period you choose."
      />

      {/* ---- Filters ---- */}
      <Panel>
        <PanelBody className="flex flex-wrap items-end gap-3">
          <Field label="From" htmlFor="from" className="w-40">
            <Input
              type="date"
              value={filters.from}
              max={filters.to}
              onChange={(event) => set({ from: event.target.value })}
            />
          </Field>
          <Field label="To" htmlFor="to" className="w-40" hint="Exclusive.">
            <Input
              type="date"
              value={filters.to}
              min={filters.from}
              onChange={(event) => set({ to: event.target.value })}
            />
          </Field>

          <Field label="Doctor" htmlFor="practitionerId" className="w-48">
            <Select
              value={filters.practitionerId ?? ''}
              onChange={(event) => set({ practitionerId: event.target.value || undefined })}
            >
              <option value="">Everyone</option>
              {(staff?.items ?? []).map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  {doctor.fullName}
                </option>
              ))}
            </Select>
          </Field>

          {(locations?.items ?? []).length > 1 ? (
            <Field label="Location" htmlFor="locationId" className="w-44">
              <Select
                value={filters.locationId ?? ''}
                onChange={(event) => set({ locationId: event.target.value || undefined })}
              >
                <option value="">All</option>
                {(locations?.items ?? []).map((place) => (
                  <option key={place.id} value={place.id}>
                    {place.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          <Field
            label="Service"
            htmlFor="serviceItemId"
            className="w-48"
            /*
             * Said on the control rather than left to be discovered.
             *
             * An appointment does not record a service — the booking path uses
             * it to work out the end time and discards it — so this narrows the
             * money and not the appointment counts. A filter that silently
             * applied to half the page would be worse than one that says so.
             */
            hint="Narrows revenue only."
          >
            <Select
              value={filters.serviceItemId ?? ''}
              onChange={(event) => set({ serviceItemId: event.target.value || undefined })}
            >
              <option value="">All</option>
              {(services?.items ?? []).map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Payment method" htmlFor="paymentMethod" className="w-40">
            <Select
              value={filters.paymentMethod ?? ''}
              onChange={(event) => set({ paymentMethod: event.target.value || undefined })}
            >
              <option value="">All</option>
              {PaymentMethod.options.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </Select>
          </Field>

          <Button variant="ghost" size="sm" onClick={() => setFilters(defaultRange())}>
            Reset
          </Button>
        </PanelBody>
      </Panel>

      {analytics.isError ? (
        <ErrorState
          title="Could not load the analytics"
          description={
            analytics.error instanceof ApiError
              ? analytics.error.message
              : 'Check the date range — at most 120 days at a time.'
          }
          onRetry={() => void analytics.refetch()}
        />
      ) : analytics.isLoading || !analytics.data ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <>
          {/* ---- Revenue ---- */}
          <Panel>
            <PanelHeader
              title="Revenue"
              actions={
                <ExportMenu
                  views={['revenue-by-method', 'revenue-by-doctor', 'revenue-by-service']}
                  filters={filters}
                />
              }
            />
            <PanelBody className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat
                  label="Collected"
                  value={formatPaise(analytics.data.revenue.collectedPaise)}
                  hint="Money that arrived in this range"
                  tone="positive"
                />
                <Stat
                  label="Invoiced"
                  value={formatPaise(analytics.data.revenue.invoicedPaise)}
                  hint="Money billed in this range"
                />
                <Stat
                  label="Outstanding"
                  value={formatPaise(analytics.data.revenue.outstandingPaise)}
                  /*
                   * Says "all time" on the figure itself. It is the one number on
                   * the page the range does not touch, and a reader who assumes
                   * otherwise will think a debt disappeared when they narrowed
                   * the window.
                   */
                  hint="Owed now, all time — not filtered by the range"
                  tone={analytics.data.revenue.outstandingPaise > 0 ? 'warning' : 'neutral'}
                />
                <Stat
                  label="Refunded"
                  value={formatPaise(analytics.data.revenue.refundedPaise)}
                  hint="Collections above are gross"
                />
              </div>

              <CollectionsChart series={analytics.data.revenue.series} />

              <div className="grid gap-4 lg:grid-cols-3">
                <BreakdownTable
                  title="By payment method"
                  heading="Method"
                  rows={analytics.data.revenue.byMethod}
                />
                <BreakdownTable
                  title="By doctor"
                  heading="Doctor"
                  rows={analytics.data.revenue.byPractitioner}
                />
                <BreakdownTable
                  title="By service"
                  heading="Service"
                  rows={analytics.data.revenue.byService}
                  /*
                   * Billed, not collected, and it says so. A part-payment against
                   * a three-line invoice cannot be apportioned between the lines
                   * without inventing a rule, so this measures what was charged.
                   */
                  note="What was billed. A part-paid invoice cannot be split between its lines."
                />
              </div>
            </PanelBody>
          </Panel>

          {/* ---- Appointments ---- */}
          <Panel>
            <PanelHeader title="Appointments" />
            <PanelBody className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Booked" value={analytics.data.appointments.bookedCount} />
              <Stat
                label="Completed"
                value={analytics.data.appointments.completedCount}
                tone="positive"
              />
              <Stat label="Walk-ins" value={analytics.data.appointments.walkInCount} />
              <Stat
                label="No-show"
                value={
                  analytics.data.appointments.noShowPct === null
                    ? '—'
                    : `${analytics.data.appointments.noShowPct}%`
                }
                /* The denominator, printed, because the obvious one is wrong. */
                hint={`${analytics.data.appointments.noShowCount} of ${analytics.data.appointments.closedCount} closed`}
                tone={
                  (analytics.data.appointments.noShowPct ?? 0) > 20 ? 'warning' : 'neutral'
                }
              />
              <Stat
                label="Cancelled"
                value={
                  analytics.data.appointments.cancellationPct === null
                    ? '—'
                    : `${analytics.data.appointments.cancellationPct}%`
                }
                hint={`${analytics.data.appointments.cancelledCount} of ${analytics.data.appointments.closedCount} closed`}
              />
              <Stat
                label="Utilisation"
                value={
                  analytics.data.appointments.utilisationPct === null
                    ? '—'
                    : `${analytics.data.appointments.utilisationPct}%`
                }
                hint={
                  analytics.data.appointments.offeredMinutes === null
                    ? 'No doctor schedules cover this range'
                    : `${analytics.data.appointments.bookedMinutes} of ${analytics.data.appointments.offeredMinutes} min offered`
                }
              />
            </PanelBody>
            {analytics.data.appointments.offeredMinutes === null ? (
              <PanelBody className="pt-0">
                <Alert tone="info" title="Utilisation needs working hours">
                  Set each doctor&rsquo;s hours under{' '}
                  <Link href="/settings/schedules" className="font-medium underline">
                    Settings → Doctor schedules
                  </Link>{' '}
                  and this becomes a real figure. It is blank rather than 0% because
                  there is nothing to divide by — not because nobody came.
                </Alert>
              </PanelBody>
            ) : null}
          </Panel>

          {/* ---- Patients ---- */}
          <Panel>
            <PanelHeader
              title="Patients"
              actions={<ExportMenu views={['registrations-daily']} filters={filters} />}
            />
            <PanelBody className="grid grid-cols-3 gap-4">
              <Stat
                label="New"
                value={analytics.data.patients.newCount}
                hint="Registered in this range"
              />
              <Stat
                label="Returning"
                value={analytics.data.patients.returningCount}
                hint="Registered earlier, seen in this range"
              />
              <Stat
                label="Seen"
                value={analytics.data.patients.seenCount}
                hint="Distinct patients with a consultation"
              />
            </PanelBody>
          </Panel>

          {/* ---- Ageing ---- */}
          <Panel>
            <PanelHeader
              title="Outstanding by age"
              description={
                analytics.data.ageing.oldestDays === null
                  ? 'Nothing is owed.'
                  : `Oldest unpaid invoice: ${analytics.data.ageing.oldestDays} days. Aged from when each was issued.`
              }
              actions={<ExportMenu views={['invoice-ageing']} filters={filters} />}
            />
            <Table>
              <THead>
                <TR>
                  <TH>Age</TH>
                  <TH>Invoices</TH>
                  <TH>Outstanding</TH>
                </TR>
              </THead>
              <TBody>
                {analytics.data.ageing.buckets.map((bucket) => (
                  <TR key={bucket.label}>
                    <TD>{bucket.label}</TD>
                    <TD className="tabular">{bucket.count}</TD>
                    <TD
                      className={cn(
                        'tabular',
                        bucket.label === 'Over 60 days' && bucket.amountPaise > 0
                          ? 'font-medium text-critical'
                          : undefined,
                      )}
                    >
                      {formatPaise(bucket.amountPaise)}
                    </TD>
                  </TR>
                ))}
                <TR>
                  <TD className="font-medium">Total</TD>
                  <TD />
                  <TD className="font-medium tabular">
                    {formatPaise(analytics.data.ageing.totalPaise)}
                  </TD>
                </TR>
              </TBody>
            </Table>
          </Panel>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Plain links, not fetch-and-Blob.
 *
 * The server sets `content-disposition`, so the browser saves the file with the
 * right name and shows its own progress. Fetching it into memory first would
 * lose both and hold the whole file on the heap for nothing.
 */
function ExportMenu({
  views,
  filters,
}: {
  views: readonly string[];
  filters: AnalyticsQuery;
}) {
  const options = ANALYTICS_EXPORTS.filter((e) => views.includes(e.value));

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options.map((option) => (
        <a
          key={option.value}
          href={analyticsExportUrl(option.value, filters)}
          download
          className="inline-flex items-center gap-1 rounded-sm border border-line bg-surface px-2 py-1 text-2xs font-medium text-ink-soft hover:bg-surface-sunk hover:text-ink"
        >
          <Download className="size-3" aria-hidden />
          {option.label.replace(/^.*?by /, 'by ')}
        </a>
      ))}
    </div>
  );
}

function BreakdownTable({
  title,
  heading,
  rows,
  note,
}: {
  title: string;
  heading: string;
  rows: AnalyticsBreakdown[];
  note?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-2xs uppercase tracking-wide text-ink-faint">{title}</p>
      {note ? <p className="mt-0.5 text-2xs text-ink-faint">{note}</p> : null}
      {rows.length === 0 ? (
        <p className="mt-2 text-xs text-ink-faint">Nothing in this range.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1">
          {rows.slice(0, 8).map((row) => (
            <li
              key={`${row.id ?? 'none'}-${row.label}`}
              className="flex items-baseline justify-between gap-2 border-b border-line-soft/60 pb-1"
            >
              <span className="min-w-0 truncate text-xs text-ink" title={row.label}>
                {row.label}
                <span className="ml-1 text-ink-faint">({row.count})</span>
              </span>
              <span className="shrink-0 text-xs tabular text-ink">
                {formatPaise(row.amountPaise)}
              </span>
            </li>
          ))}
          {rows.length > 8 ? (
            <li className="text-2xs text-ink-faint">
              {rows.length - 8} more — export for the full list.
            </li>
          ) : null}
        </ul>
      )}
      <p className="sr-only">{heading}</p>
    </div>
  );
}

/**
 * Collections per day.
 *
 * A bar per day, scaled to the busiest. No axis labels: at this size they would
 * crowd out the bars, and the two figures that matter — the total and the peak —
 * are both stated in words.
 */
function CollectionsChart({
  series,
}: {
  series: { date: string; collectedPaise: number }[];
}) {
  const peak = Math.max(1, ...series.map((point) => point.collectedPaise));
  const total = series.reduce((sum, point) => sum + point.collectedPaise, 0);

  if (total === 0) {
    return <p className="text-xs text-ink-faint">No collections in this range.</p>;
  }

  return (
    <div>
      <p className="text-2xs uppercase tracking-wide text-ink-faint">
        Collections per day · peak {formatPaiseShort(peak)}
      </p>
      <div className="mt-2 flex h-20 items-end gap-px" role="img" aria-label="Collections per day">
        {series.map((point) => (
          <div
            key={point.date}
            className="min-w-0 flex-1 rounded-t-sm bg-accent/70"
            style={{ height: `${Math.max(2, (point.collectedPaise / peak) * 100)}%` }}
            title={`${point.date}: ${formatPaise(point.collectedPaise)}`}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The default window: the last 30 days, ending tomorrow.
 *
 * `to` is EXCLUSIVE throughout this product, so tomorrow is what includes today.
 * UTC, because these strings are compared against dates the API returns and a
 * local date is wrong for part of every day east of Greenwich.
 */
function defaultRange(): AnalyticsQuery {
  const to = new Date();
  to.setUTCDate(to.getUTCDate() + 1);
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - 30);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}
