'use client';

import type { DayAnalytics } from '@emr/contracts';
import { cn } from '@/lib/cn';

/**
 * The day's numbers, above the day.
 *
 * COUNTED SERVER-SIDE over the same filtered rows that produced the grid, so
 * narrowing to one doctor narrows these too. Recomputing them here from the
 * entries would be the same fold written twice, and the copy that drifts is the
 * one on screen.
 *
 * ZEROES ARE HIDDEN, except for what is booked. A strip reading "0 no-shows, 0
 * cancelled, 0 walk-ins" spends most of its width saying nothing happened; the
 * eye should land on the two numbers that are not zero. Booked stays because its
 * absence is itself the news — an empty day needs to say so rather than show an
 * empty bar.
 */
export function DayAnalyticsStrip({
  analytics,
  className,
}: {
  analytics: DayAnalytics;
  className?: string;
}) {
  const figures: { label: string; value: number | null; tone?: string; always?: boolean }[] = [
    { label: 'Booked', value: analytics.booked, always: true },
    { label: 'Waiting', value: analytics.arrived, tone: 'text-accent-ink' },
    { label: 'In consult', value: analytics.inConsultation, tone: 'text-accent-ink' },
    { label: 'Done', value: analytics.completed, tone: 'text-positive' },
    { label: 'Checked out', value: analytics.checkedOut, tone: 'text-ink-soft' },
    { label: 'No-show', value: analytics.noShow, tone: 'text-warning' },
    { label: 'Cancelled', value: analytics.cancelled, tone: 'text-ink-faint' },
    { label: 'Walk-ins', value: analytics.walkIns },
    { label: 'Free slots', value: analytics.freeSlots, tone: 'text-ink-soft' },
  ];

  const shown = figures.filter((f) => f.always || (f.value !== null && f.value > 0));

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-line-soft ' +
          'bg-surface-sunk px-3 py-2',
        className,
      )}
    >
      {shown.map((figure) => (
        <div key={figure.label} className="flex items-baseline gap-1.5">
          <span className={cn('text-sm font-semibold tabular', figure.tone ?? 'text-ink')}>
            {figure.value ?? '—'}
          </span>
          <span className="text-2xs uppercase tracking-wide text-ink-faint">
            {figure.label}
          </span>
        </div>
      ))}

      {analytics.utilisationPct !== null ? (
        <div className="ml-auto flex items-center gap-2">
          <span className="text-2xs uppercase tracking-wide text-ink-faint">Utilisation</span>
          {/*
            A bar as well as a number, because "62%" means nothing without a
            sense of the scale it sits on. Cancellations and no-shows are not in
            it — a doctor is not busy during an appointment nobody attended, and
            counting them would make the worst day of the month read as the
            busiest.
          */}
          <div
            className="h-1.5 w-20 overflow-hidden rounded-full bg-line-soft"
            role="img"
            aria-label={`${analytics.utilisationPct}% of offered time is booked`}
          >
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${analytics.utilisationPct}%` }}
            />
          </div>
          <span className="text-sm font-semibold tabular text-ink">
            {analytics.utilisationPct}%
          </span>
        </div>
      ) : null}
    </div>
  );
}
