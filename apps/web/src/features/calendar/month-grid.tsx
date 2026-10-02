'use client';

import type { CalendarDay } from '@emr/contracts';
import { cn } from '@/lib/cn';

/**
 * The month: thirty cells of counts.
 *
 * NO SLOTS ARE DERIVED FOR THIS VIEW. A month of five doctors at fifteen-minute
 * slots over a ten-hour day is six thousand slot objects, computed to render
 * numbers that do not use them — so the page asks for `includeSlots=false` and
 * the slot-dependent figures come back null rather than zero. Zero would read as
 * "fully booked", and a month claiming every day is full is worse than one
 * claiming nothing.
 *
 * A CLICK OPENS THE DAY rather than a booking dialog. At month scale a cell is
 * a day, not a time, and the next question is always "what does that day look
 * like" — booking from here would have to invent an hour.
 */
export function MonthGrid({
  days,
  anchorMonth,
  onOpenDay,
}: {
  days: CalendarDay[];
  /** YYYY-MM-DD in the month being shown; the adjacent days are dimmed. */
  anchorMonth: string;
  onOpenDay: (date: string) => void;
}) {
  const month = anchorMonth.slice(0, 7);
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

  return (
    <div className="overflow-hidden rounded-md border border-line-soft">
      <div className="grid grid-cols-7 border-b border-line-soft bg-surface-sunk">
        {/* Monday first, which is how an Indian clinic's week reads. */}
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label) => (
          <div
            key={label}
            className="px-2 py-1.5 text-center text-2xs uppercase tracking-wide text-ink-faint"
          >
            {label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {days.map((day) => {
          const inMonth = day.date.slice(0, 7) === month;
          const { booked, arrived, inConsultation, completed, checkedOut, noShow } =
            day.analytics;
          const live = booked + arrived + inConsultation + completed + checkedOut;

          return (
            <button
              key={day.date}
              type="button"
              onClick={() => onOpenDay(day.date)}
              className={cn(
                'flex min-h-20 flex-col items-start gap-1 border-b border-r border-line-soft/60 ' +
                  'p-2 text-left transition-colors hover:bg-accent-soft',
                'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
                // Adjacent months are shown rather than blanked — the grid draws
                // whole weeks, and empty cells read as days with nothing booked.
                !inMonth && 'bg-surface-sunk/50',
              )}
              aria-label={`${day.date}: ${live} appointments`}
            >
              <span
                className={cn(
                  'inline-flex size-5 items-center justify-center rounded-full text-2xs tabular',
                  day.date === todayIso
                    ? 'bg-accent font-semibold text-accent-contrast'
                    : inMonth
                      ? 'text-ink'
                      : 'text-ink-faint',
                )}
              >
                {Number(day.date.slice(8, 10))}
              </span>

              {live > 0 ? (
                <span className="text-xs font-medium tabular text-ink">
                  {live} <span className="font-normal text-ink-faint">booked</span>
                </span>
              ) : null}

              {/*
                Only no-shows get their own line. They are the number a clinic
                acts on at month scale — a run of them on the same weekday is a
                pattern worth seeing — and listing every status would fill a
                cell too small to read.
              */}
              {noShow > 0 ? (
                <span className="text-2xs tabular text-warning">{noShow} no-show</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
