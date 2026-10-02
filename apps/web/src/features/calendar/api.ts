'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AppointmentStatus,
  Calendar,
  CalendarView,
  RescheduleAppointment,
} from '@emr/contracts';
import { api } from '@/lib/api-client';
import { useServerEvents, type ServerEvent } from '@/lib/server-events';

/**
 * The calendar's data.
 *
 * One request per view, because the analytics strip has to agree with the grid
 * it sits above. Two requests reconciled here would be two chances to disagree,
 * and the number that disagrees is the one somebody reads out in a meeting.
 */

export interface CalendarFilters {
  practitionerId?: string;
  locationId?: string;
  statuses?: AppointmentStatus[];
  /** `true` walk-ins only, `false` booked only, undefined both. */
  walkInsOnly?: boolean;
}

export const ck = {
  calendar: (from: string, to: string, filters: CalendarFilters, slots: boolean) =>
    [
      'calendar',
      from,
      to,
      filters.practitionerId ?? '',
      filters.locationId ?? '',
      (filters.statuses ?? []).join(','),
      filters.walkInsOnly ?? '',
      slots,
    ] as const,
};

export function useCalendar(
  from: string,
  to: string,
  filters: CalendarFilters,
  options: { includeSlots?: boolean } = {},
) {
  const includeSlots = options.includeSlots ?? true;

  return useQuery({
    queryKey: ck.calendar(from, to, filters, includeSlots),
    queryFn: () =>
      api.get<Calendar>('/calendar', {
        query: {
          from,
          to,
          includeSlots: String(includeSlots),
          practitionerId: filters.practitionerId ?? null,
          locationId: filters.locationId ?? null,
          status: filters.statuses?.length ? filters.statuses.join(',') : null,
          walkIns: filters.walkInsOnly === undefined ? null : String(filters.walkInsOnly),
        },
      }),
    /*
     * A floor under the live stream, not a substitute for it.
     *
     * A slot taken at the front desk should vanish from the doctor's calendar
     * without anybody pressing anything, and SSE does that. This is what keeps
     * the grid honest when the stream is down — a stale calendar double-books.
     */
    refetchInterval: 60_000,
    staleTime: 10_000,
  });
}

/**
 * Keeps the open calendar current from the live stream.
 *
 * Invalidates rather than patching the cached payload. A booking elsewhere can
 * change a slot's `bookedCount`, a column's free count, and three numbers in the
 * analytics strip at once — reproducing that fold on the client is the whole
 * server computation written twice, and the copy that drifts is the one on
 * screen.
 */
export function useCalendarLiveUpdates(): void {
  const queryClient = useQueryClient();

  const onEvent = React.useCallback(
    (event: ServerEvent) => {
      if (event.type !== 'appointment-changed' && event.type !== 'queue-changed') return;
      void queryClient.invalidateQueries({ queryKey: ['calendar'] });
    },
    [queryClient],
  );

  useServerEvents(onEvent);
}

/** Everything a booking or a move can change, invalidated together. */
function useInvalidateCalendar() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['calendar'] });
    void queryClient.invalidateQueries({ queryKey: ['scheduling'] });
    void queryClient.invalidateQueries({ queryKey: ['appointments'] });
    void queryClient.invalidateQueries({ queryKey: ['queue'] });
  };
}

/**
 * Moves or resizes an appointment.
 *
 * `version` is always sent. The calendar is the most concurrently edited screen
 * in the product — the front desk and the doctor are both on it — and without
 * the version the later of two simultaneous drags silently wins while the
 * earlier disappears with no trace.
 */
export function useReschedule() {
  const invalidate = useInvalidateCalendar();
  return useMutation({
    mutationFn: ({ id, ...input }: RescheduleAppointment & { id: string }) =>
      api.patch(`/appointments/${id}/schedule`, input),
    onSuccess: invalidate,
  });
}

/* -------------------------------------------------------------------------- */
/* Date arithmetic for the view switcher                                      */
/* -------------------------------------------------------------------------- */

/**
 * All of this works on YYYY-MM-DD strings rather than `Date` objects.
 *
 * A `Date` carries a time and a timezone, and neither belongs in "which day is
 * the calendar showing". Adding a day to a `Date` across a DST boundary gives
 * the same day back, and the calendar that does its paging in local `Date`
 * objects is the one that skips a day twice a year.
 */

export function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday-first, which is how an Indian clinic's week reads. */
export function startOfWeek(isoDate: string): string {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return addDays(isoDate, day === 0 ? -6 : 1 - day);
}

export function startOfMonth(isoDate: string): string {
  return `${isoDate.slice(0, 7)}-01`;
}

export function addMonths(isoDate: string, months: number): string {
  const d = new Date(`${startOfMonth(isoDate)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/**
 * The half-open range a view asks the server for.
 *
 * `to` is EXCLUSIVE throughout — a day view asks for one date and the next, a
 * week for Monday and the following Monday. Half-open ranges avoid the
 * off-by-one that an inclusive end invites every time somebody adds a view.
 *
 * The month view asks for whole WEEKS, not whole months, because the grid draws
 * the leading and trailing days of the adjacent months and they would otherwise
 * be empty cells that look like days with nothing booked.
 */
export function rangeFor(view: CalendarView, anchor: string): { from: string; to: string } {
  switch (view) {
    case 'day':
      return { from: anchor, to: addDays(anchor, 1) };
    case '3day':
      return { from: anchor, to: addDays(anchor, 3) };
    case 'week': {
      const from = startOfWeek(anchor);
      return { from, to: addDays(from, 7) };
    }
    case 'month': {
      const first = startOfMonth(anchor);
      const from = startOfWeek(first);
      const lastDay = addDays(addMonths(first, 1), -1);
      const to = addDays(startOfWeek(lastDay), 7);
      return { from, to };
    }
  }
}

/** Paging: one view's worth forwards or backwards. */
export function step(view: CalendarView, anchor: string, direction: 1 | -1): string {
  switch (view) {
    case 'day':
      return addDays(anchor, direction);
    case '3day':
      return addDays(anchor, 3 * direction);
    case 'week':
      return addDays(anchor, 7 * direction);
    case 'month':
      return addMonths(anchor, direction);
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
