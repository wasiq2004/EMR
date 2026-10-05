'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { addDays, addMonths, startOfMonth, startOfWeek, todayIso } from './api';

/**
 * The small month grid in the sidebar.
 *
 * WHAT IT IS FOR. Jumping to a date more than a few days away. Paging a day view
 * forward eleven times to reach the end of the month is the kind of thing that
 * makes people stop using a calendar, and a date input does not show them which
 * day of the week the 14th falls on — which is the actual question when a patient
 * says "some time next week, not Thursday".
 *
 * IT IS NOT A SECOND MONTH VIEW. It shows no appointments and no counts: it is
 * navigation, and loading a month of data to decorate a date picker would make
 * every page load slower for something nobody reads. The month VIEW, which does
 * show counts, is one of the four view buttons.
 */
export function MiniMonth({
  /** The date the main view is showing, highlighted. */
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (date: string) => void;
}) {
  /*
   * The month on display, separate from the selected date.
   *
   * Paging the mini-month must not move the main view — somebody looking for
   * next month's Tuesdays has not chosen one yet. It re-syncs when the selection
   * moves to a different month, so using the main view's arrows keeps the two
   * together.
   */
  const [cursor, setCursor] = React.useState(() => startOfMonth(selected));
  React.useEffect(() => {
    setCursor(startOfMonth(selected));
  }, [selected]);

  const today = todayIso();
  const monthLabel = new Date(`${cursor}T12:00:00`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
  });

  /* Whole weeks, Monday-first, so the grid is always six rows of seven. */
  const firstCell = startOfWeek(cursor);
  const cells = Array.from({ length: 42 }, (_, i) => addDays(firstCell, i));
  const month = cursor.slice(0, 7);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ink">{monthLabel}</span>
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => setCursor(addMonths(cursor, -1))}
            className="rounded-sm p-0.5 text-ink-faint hover:bg-surface-sunk hover:text-ink"
          >
            <ChevronLeft className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => setCursor(addMonths(cursor, 1))}
            className="rounded-sm p-0.5 text-ink-faint hover:bg-surface-sunk hover:text-ink"
          >
            <ChevronRight className="size-3.5" aria-hidden />
          </button>
        </span>
      </div>

      <div className="grid grid-cols-7 gap-px">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((label, i) => (
          <span
            key={`${label}-${i}`}
            className="py-0.5 text-center text-2xs text-ink-faint"
            aria-hidden
          >
            {label}
          </span>
        ))}

        {cells.map((date) => {
          const inMonth = date.slice(0, 7) === month;
          const isSelected = date === selected;
          const isToday = date === today;

          return (
            <button
              key={date}
              type="button"
              onClick={() => onSelect(date)}
              aria-current={isSelected ? 'date' : undefined}
              aria-label={new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}
              className={cn(
                'flex aspect-square items-center justify-center rounded-full text-2xs tabular transition-colors',
                isSelected
                  ? 'bg-accent font-semibold text-accent-contrast'
                  : isToday
                    ? 'font-semibold text-accent ring-1 ring-inset ring-accent'
                    : inMonth
                      ? 'text-ink hover:bg-surface-sunk'
                      : /* Adjacent months are dimmed, not hidden: the grid keeps
                           its shape and the days are still clickable, which is
                           what somebody reaching across a month boundary wants. */
                        'text-ink-faint hover:bg-surface-sunk',
              )}
            >
              {Number(date.slice(8, 10))}
            </button>
          );
        })}
      </div>
    </div>
  );
}
