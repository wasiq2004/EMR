'use client';

import * as React from 'react';
import { Activity } from 'lucide-react';
import { usePharmacyReport } from '@/features/pharmacy/api';
import { formatDateTime, formatMinutes, formatPaise } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatRow } from '@/components/ui/data-state';
import { Alert, EmptyState, SkeletonRows } from '@/components/ui/feedback';
import { PageHeader, Panel, PanelBody, PanelHeader, Stat } from '@/components/ui/surface';
import { Table, TBody, TD, TH, THead, TR, TableScroller } from '@/components/ui/table';
import { cn } from '@/lib/cn';

/**
 * Pharmacy reporting.
 *
 * TURNAROUND IS THE HEADLINE, and it is the figure most pharmacy software omits: how
 * long a patient stood at the counter. Reported as a MEDIAN, because one prescription
 * that waited four hours while the patient went home and came back would drag an
 * average past usefulness.
 *
 * LOSS IS VALUED AT COST, NOT MRP. Writing off expired stock loses what it was paid
 * for, not what it might have sold for. Valuing loss at retail inflates it and makes
 * the number useless for deciding how much to order next time.
 */
const RANGES = [7, 30, 90] as const;

export default function PharmacyReportsPage() {
  const [days, setDays] = React.useState<number>(30);
  const report = usePharmacyReport(days);

  if (report.isLoading) return <SkeletonRows rows={10} />;
  const data = report.data;

  const dispensedAnything = (data?.prescriptionsDispensed ?? 0) > 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Pharmacy reports"
        description={
          data
            ? `${formatDateTime(data.rangeFrom)} to ${formatDateTime(data.rangeTo)}`
            : undefined
        }
        actions={
          <div
            className="inline-flex rounded-md border border-line bg-surface p-0.5"
            role="group"
            aria-label="Period"
          >
            {RANGES.map((value) => (
              <Button
                key={value}
                size="sm"
                variant={days === value ? 'secondary' : 'ghost'}
                aria-pressed={days === value}
                className={days === value ? 'bg-accent-soft text-accent-ink' : undefined}
                onClick={() => setDays(value)}
              >
                {value} days
              </Button>
            ))}
          </div>
        }
      />

      {!dispensedAnything ? (
        <Panel>
          <PanelBody>
            <EmptyState
              icon={Activity}
              title="Nothing dispensed in this period"
              description="Figures appear once the counter has handed something over."
            />
          </PanelBody>
        </Panel>
      ) : null}

      <StatRow>
        <Stat label="Prescriptions dispensed" value={data?.prescriptionsDispensed ?? 0} />
        <Stat label="Items handed over" value={data?.itemsDispensed ?? 0} />
        <Stat
          label="Median wait at the counter"
          value={
            data?.medianTurnaroundMinutes === null || data?.medianTurnaroundMinutes === undefined
              ? '—'
              : formatMinutes(data.medianTurnaroundMinutes)
          }
          tone={
            (data?.medianTurnaroundMinutes ?? 0) > 20
              ? 'warning'
              : 'neutral'
          }
          hint="Half of patients waited less than this"
        />
        <Stat
          label="Substitutions"
          value={data?.substitutionCount ?? 0}
          hint="A different molecule than prescribed"
        />
      </StatRow>

      <StatRow>
        <Stat label="Sales" value={formatPaise(data?.salesTotalPaise ?? 0)} hint={`${data?.salesCount ?? 0} transactions`} />
        <Stat
          label="Returns"
          value={formatPaise(data?.returnsTotalPaise ?? 0)}
          tone={(data?.returnsTotalPaise ?? 0) > 0 ? 'warning' : 'neutral'}
        />
        <Stat
          label="Purchases"
          value={formatPaise(data?.purchasesTotalPaise ?? 0)}
          hint={`${data?.receiptCount ?? 0} deliveries`}
        />
        <Stat
          label="Written off"
          value={formatPaise((data?.expiryLossPaise ?? 0) + (data?.damageLossPaise ?? 0))}
          tone={
            (data?.expiryLossPaise ?? 0) + (data?.damageLossPaise ?? 0) > 0
              ? 'critical'
              : 'neutral'
          }
          hint="At cost, not at MRP"
        />
      </StatRow>

      {(data?.clarificationsRaised ?? 0) > 0 ? (
        <Alert
          tone="info"
          title={`${data!.clarificationsRaised} question${data!.clarificationsRaised === 1 ? '' : 's'} raised with prescribers`}
        >
          {data!.clarificationsAnswered} answered. Each one is a prescription the
          counter did not silently change — which is the point of the loop, even
          though it slows a hand-over down.
        </Alert>
      ) : null}

      {/* ---- Daily dispensing, as a bar series --------------------------- */}
      {(data?.dailyDispensing.length ?? 0) > 1 ? (
        <Panel>
          <PanelHeader title="Dispensing by day" description="Prescriptions handed over." />
          <PanelBody>
            <DailyBars series={data!.dailyDispensing} />
          </PanelBody>
        </Panel>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelHeader
            title="Most dispensed"
            description="By quantity leaving the shelf."
          />
          <PanelBody>
            {(data?.topProducts.length ?? 0) === 0 ? (
              <EmptyState title="Nothing moved in this period" />
            ) : (
              <TableScroller>
                <Table>
                  <THead>
                    <TR>
                      <TH>Product</TH>
                      <TH align="right">Quantity</TH>
                      <TH align="right">Value at cost</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {data!.topProducts.map((row) => (
                      <TR key={row.productId}>
                        <TD>{row.productName}</TD>
                        <TD align="right" className="tabular font-semibold">
                          {row.quantity}
                        </TD>
                        <TD align="right" className="tabular text-ink-faint">
                          {formatPaise(row.valuePaise)}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableScroller>
            )}
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader
            title="Not moving"
            description="Stock on the shelf that nothing has taken off it. Most valuable first."
          />
          <PanelBody>
            {(data?.nonMoving.length ?? 0) === 0 ? (
              <EmptyState title="Everything in stock has moved" />
            ) : (
              <>
                <Alert tone="warning" title="This is money sitting still">
                  It is the figure that says a clinic over-ordered, and the one nobody
                  looks at until the expiry write-off arrives.
                </Alert>
                <TableScroller className="mt-3">
                  <Table>
                    <THead>
                      <TR>
                        <TH>Product</TH>
                        <TH align="right">On hand</TH>
                        <TH align="right">Value at cost</TH>
                        <TH>Last moved</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {data!.nonMoving.map((row) => (
                        <TR key={row.productId}>
                          <TD>{row.productName}</TD>
                          <TD align="right" className="tabular">
                            {row.quantityOnHand}
                          </TD>
                          <TD align="right" className="tabular font-semibold">
                            {formatPaise(row.valueAtCostPaise)}
                          </TD>
                          <TD className="text-ink-faint">
                            {row.lastMovedAt ? (
                              formatDateTime(row.lastMovedAt)
                            ) : (
                              <Badge tone="warning">never</Badge>
                            )}
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </TableScroller>
              </>
            )}
          </PanelBody>
        </Panel>
      </div>
    </div>
  );
}

/**
 * A bar per day.
 *
 * Deliberately not a charting library. It is one series of small integers, the
 * accessible fallback is a table the screen reader can read from the aria label, and
 * a chart dependency for this would be more bytes than the whole panel.
 */
function DailyBars({
  series,
}: {
  series: { date: string; prescriptions: number; items: number }[];
}) {
  const max = Math.max(...series.map((point) => point.prescriptions), 1);

  return (
    <div
      className="flex h-32 items-end gap-1"
      role="img"
      aria-label={`Prescriptions dispensed per day: ${series
        .map((point) => `${point.date}, ${point.prescriptions}`)
        .join('; ')}`}
    >
      {series.map((point) => (
        <div key={point.date} className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <div
            className={cn(
              'w-full rounded-t-sm bg-accent',
              point.prescriptions === 0 && 'bg-line',
            )}
            style={{ height: `${Math.max((point.prescriptions / max) * 100, 2)}%` }}
            title={`${point.prescriptions} prescriptions, ${point.items} items on ${point.date}`}
          />
          <span className="truncate text-2xs text-ink-faint">{point.date.slice(8)}</span>
        </div>
      ))}
    </div>
  );
}
