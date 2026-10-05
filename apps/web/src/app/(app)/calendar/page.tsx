'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { CalendarPlus, ChevronLeft, ChevronRight, Filter, X } from 'lucide-react';
import {
  APPOINTMENT_STATUS_LABEL,
  AppointmentStatus,
  CALENDAR_VIEWS,
  type CalendarEntry,
  type CalendarView,
  type ClinicLocation,
  type Practitioner,
  type Slot,
} from '@emr/contracts';
import { ApiError, api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { Panel, PanelBody, PanelHeader, PageHeader } from '@/components/ui/surface';
import { Alert, ErrorState, Skeleton } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import {
  rangeFor,
  step,
  startOfMonth,
  todayIso,
  useCalendar,
  useCalendarLiveUpdates,
  useReschedule,
  type CalendarFilters,
} from '@/features/calendar/api';
import { DayAnalyticsStrip } from '@/features/calendar/day-analytics';
import { MiniMonth } from '@/features/calendar/mini-month';
import { TimeGrid } from '@/features/calendar/time-grid';
import { MonthGrid } from '@/features/calendar/month-grid';
import { BookSlotDialog } from '@/features/calendar/book-slot-dialog';

/**
 * The calendar.
 *
 * ONE REQUEST PER VIEW. The bookings, the free slots and the day's numbers come
 * back together, counted over the same filtered rows — so narrowing to one
 * doctor narrows the strip above the grid too. See `CalendarService` for why
 * that is a server concern.
 *
 * THE MONTH VIEW ASKS FOR NO SLOTS. Thirty cells of counts do not need six
 * thousand derived slot objects, and `includeSlots=false` says so.
 *
 * WHO SEES THIS. Reaching it needs `appointment:read`, which the doctor, the
 * front desk, the nurse and the administrator hold and the pharmacist and the
 * research analyst do not. There is no client-side role check here because
 * there should not be one — the guard on `/calendar` is the control, and a
 * second copy in the browser is a thing that can disagree with it.
 */
export default function CalendarPage() {
  const router = useRouter();
  const toast = useToast();
  const session = useSession();

  /*
   * THE VIEW AND THE DATE LIVE IN THE URL, not in component state.
   *
   * Three things need this. A receptionist asked to "look at next Thursday"
   * should be able to send the link rather than describe the clicks. The browser
   * back button should undo a month-to-day drill-down, which is what the gesture
   * means. And the calendar is the one screen people leave open all day — a
   * refresh that silently returns them to today is a small theft of their place.
   *
   * It also makes the day reachable directly, which is why the browser suite can
   * open a date a month out instead of pressing Next thirty times.
   */
  const params = useSearchParams();
  const view = parseView(params.get('view'));
  const anchor = parseDate(params.get('date')) ?? todayIso();

  const setParams = React.useCallback(
    (next: { view?: CalendarView; date?: string }) => {
      const merged = new URLSearchParams(params.toString());
      if (next.view) merged.set('view', next.view);
      if (next.date) merged.set('date', next.date);
      // `replace`, not `push`, for paging — otherwise walking forward a week a
      // day at a time leaves seven entries to back out through. The month-to-day
      // drill-down below uses `push`, because there the back button SHOULD
      // return to the month.
      router.replace(`/calendar?${merged.toString()}`);
    },
    [params, router],
  );

  const setView = (next: CalendarView) => setParams({ view: next });
  const setAnchor = (next: string) => setParams({ date: next });

  const [showFilters, setShowFilters] = React.useState(false);
  const [filters, setFilters] = React.useState<CalendarFilters>({});

  /** The slot a click opened, and the date it belongs to. */
  const [booking, setBooking] = React.useState<{ slot: Slot; date: string } | null>(null);

  const { from, to } = rangeFor(view, anchor);
  const includeSlots = view !== 'month';

  const { data, isLoading, isError, error, refetch } = useCalendar(from, to, filters, {
    includeSlots,
  });
  useCalendarLiveUpdates();

  const reschedule = useReschedule();

  const { data: staff } = useQuery({
    queryKey: qk.practitioners,
    queryFn: () => api.get<{ items: Practitioner[] }>('/practitioners'),
  });
  const { data: locations } = useQuery({
    queryKey: qk.locations,
    queryFn: () =>
      api.get<{ items: ClinicLocation[] }>('/locations').catch(() => ({ items: [] })),
  });

  /**
   * "Only mine" is a filter on the signed-in doctor, not a separate mode.
   *
   * Expressed as `practitionerId` so the server counts the analytics over the
   * same rows. A doctor opening the calendar wants their own day; keeping it a
   * filter means they can still widen it to see who else is in, which is what
   * "can somebody else take this patient" needs.
   */
  const myId = session?.userId ?? null;
  const isMine = Boolean(myId) && filters.practitionerId === myId;

  const activeFilterCount =
    (filters.practitionerId ? 1 : 0) +
    (filters.locationId ? 1 : 0) +
    (filters.statuses?.length ? 1 : 0) +
    (filters.walkInsOnly === undefined ? 0 : 1);

  const onMove = (entry: CalendarEntry, target: { startsAt: string; column: { practitionerId: string | null } }) => {
    // The length is preserved across a move. A drag to a new time means "same
    // appointment, later" — resizing it to the target slot's length as well
    // would change two things from one gesture.
    const end = new Date(
      new Date(target.startsAt).getTime() + entry.minutes * 60_000,
    ).toISOString();

    reschedule.mutate(
      {
        id: entry.id,
        scheduledStart: target.startsAt,
        scheduledEnd: end,
        practitionerId: target.column.practitionerId,
        version: entry.version,
      },
      {
        onSuccess: () => toast.success('Appointment moved'),
        onError: (err) =>
          toast.error(
            'Could not move it',
            err instanceof ApiError ? err.message : 'Try again in a moment.',
          ),
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Calendar"
        actions={
          <>
            <Button variant="secondary" onClick={() => setAnchor(todayIso())}>
              Today
            </Button>
            <Button onClick={() => router.push('/appointments/new')}>
              <CalendarPlus className="size-4" aria-hidden />
              Book
            </Button>
          </>
        }
      />

      {/* ---- The view switcher and paging ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Previous"
            onClick={() => setAnchor(step(view, anchor, -1))}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <span className="min-w-44 text-center text-sm font-medium text-ink">
            {rangeLabel(view, anchor, from, to)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Next"
            onClick={() => setAnchor(step(view, anchor, 1))}
          >
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>

        <div
          className="flex overflow-hidden rounded-md border border-line"
          role="group"
          aria-label="Calendar view"
        >
          {CALENDAR_VIEWS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={view === option.value}
              onClick={() => setView(option.value)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium transition-colors',
                'border-r border-line last:border-r-0',
                view === option.value
                  ? 'bg-accent text-accent-contrast'
                  : 'bg-surface text-ink-soft hover:bg-surface-sunk hover:text-ink',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        {myId ? (
          <Button
            variant={isMine ? 'primary' : 'secondary'}
            size="sm"
            aria-pressed={isMine}
            onClick={() =>
              setFilters((f) => ({ ...f, practitionerId: isMine ? undefined : myId }))
            }
          >
            Only mine
          </Button>
        ) : null}

        <Button
          variant={showFilters || activeFilterCount > 0 ? 'primary' : 'secondary'}
          size="sm"
          aria-expanded={showFilters}
          onClick={() => setShowFilters((open) => !open)}
        >
          <Filter className="size-3.5" aria-hidden />
          Filters
          {activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
        </Button>
      </div>

      {showFilters ? (
        <Panel>
          <PanelBody className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-2xs uppercase tracking-wide text-ink-faint">Doctor</span>
              <Select
                value={filters.practitionerId ?? ''}
                onChange={(event) =>
                  setFilters((f) => ({ ...f, practitionerId: event.target.value || undefined }))
                }
              >
                <option value="">Everyone</option>
                {(staff?.items ?? []).map((doctor) => (
                  <option key={doctor.id} value={doctor.id}>
                    {doctor.fullName}
                  </option>
                ))}
              </Select>
            </label>

            {(locations?.items ?? []).length > 1 ? (
              <label className="flex flex-col gap-1">
                <span className="text-2xs uppercase tracking-wide text-ink-faint">
                  Location
                </span>
                <Select
                  value={filters.locationId ?? ''}
                  onChange={(event) =>
                    setFilters((f) => ({ ...f, locationId: event.target.value || undefined }))
                  }
                >
                  <option value="">All</option>
                  {(locations?.items ?? []).map((place) => (
                    <option key={place.id} value={place.id}>
                      {place.name}
                    </option>
                  ))}
                </Select>
              </label>
            ) : null}

            <label className="flex flex-col gap-1">
              <span className="text-2xs uppercase tracking-wide text-ink-faint">Type</span>
              <Select
                value={
                  filters.walkInsOnly === undefined ? '' : filters.walkInsOnly ? 'walk' : 'booked'
                }
                onChange={(event) =>
                  setFilters((f) => ({
                    ...f,
                    walkInsOnly:
                      event.target.value === ''
                        ? undefined
                        : event.target.value === 'walk',
                  }))
                }
              >
                <option value="">Both</option>
                <option value="booked">Booked</option>
                <option value="walk">Walk-ins</option>
              </Select>
            </label>

            <fieldset className="flex flex-col gap-1">
              <legend className="text-2xs uppercase tracking-wide text-ink-faint">Status</legend>
              <div className="flex flex-wrap gap-1.5">
                {AppointmentStatus.options.map((status) => {
                  const on = filters.statuses?.includes(status) ?? false;
                  return (
                    <button
                      key={status}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setFilters((f) => {
                          const next = new Set(f.statuses ?? []);
                          if (next.has(status)) next.delete(status);
                          else next.add(status);
                          const list = [...next];
                          return { ...f, statuses: list.length ? list : undefined };
                        })
                      }
                      className={cn(
                        'rounded-sm border px-2 py-0.5 text-2xs font-medium transition-colors',
                        on
                          ? 'border-accent bg-accent text-accent-contrast'
                          : 'border-line bg-surface text-ink-soft hover:bg-surface-sunk',
                      )}
                    >
                      {APPOINTMENT_STATUS_LABEL[status]}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {activeFilterCount > 0 ? (
              <Button variant="ghost" size="sm" onClick={() => setFilters({})}>
                <X className="size-3.5" aria-hidden />
                Clear
              </Button>
            ) : null}
          </PanelBody>
        </Panel>
      ) : null}

      {/* ---- Sidebar and grid ---- */}
      <div className="flex flex-col gap-4 lg:flex-row">
        {/*
          The mini-month, for jumping further than the arrows reach.

          Paging a day view eleven times to get to the end of the month is what
          makes people stop using a calendar, and a date input cannot answer the
          question somebody actually has — which day of the week the 14th is,
          when a patient says "next week, not Thursday".

          Hidden on narrow screens: on a phone the grid needs the whole width,
          and the arrows plus the view switcher are enough.
        */}
        <aside className="hidden w-52 shrink-0 flex-col gap-4 lg:flex">
          <Panel>
            <PanelBody className="p-3">
              <MiniMonth selected={anchor} onSelect={(date) => setAnchor(date)} />
            </PanelBody>
          </Panel>

          {/*
            The day's numbers move here from above the grid.

            On a day view they describe the day on screen; stacked in a narrow
            column they read as a list rather than as a strip competing with the
            grid for horizontal space.
          */}
          {data && data.days.length === 1 && data.days[0] ? (
            <Panel>
              <PanelHeader title="Today at a glance" />
              <PanelBody className="p-3">
                <DayAnalyticsStrip analytics={data.days[0].analytics} stacked />
              </PanelBody>
            </Panel>
          ) : null}
        </aside>

        <div className="min-w-0 flex-1">
      {isError ? (
        <ErrorState
          title="Could not load the calendar"
          description={error instanceof ApiError ? error.message : undefined}
          onRetry={() => void refetch()}
        />
      ) : isLoading || !data ? (
        <Skeleton className="h-[32rem] w-full" />
      ) : view === 'month' ? (
        <MonthGrid
          days={data.days}
          anchorMonth={startOfMonth(anchor)}
          onOpenDay={(date) => {
            const merged = new URLSearchParams(params.toString());
            merged.set('view', 'day');
            merged.set('date', date);
            // `push`: backing out of a day opened from the month returns to the
            // month, which is what pressing back after drilling in means.
            router.push(`/calendar?${merged.toString()}`);
          }}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {data.days.every((day) => day.columns.length === 0 && day.entries.length === 0) ? (
            <Alert tone="info" title="Nothing on the calendar yet">
              No doctor has working hours for{' '}
              {data.days.length === 1 ? 'this day' : 'these days'}, and nothing is booked. Set
              them under{' '}
              <Link href="/settings/schedules" className="font-medium underline">
                Settings → Doctor schedules
              </Link>{' '}
              and the free slots will appear here.
            </Alert>
          ) : (
            /*
             * One column per DOCTOR on a day view, one per DAY otherwise.
             *
             * A week of three doctors as day-doctor pairs is twenty-one columns,
             * which is unreadable at any screen width — and nobody scanning a
             * week is choosing between doctors, they are looking for a day. The
             * grid draws its own border, so no Panel around it.
             */
            <TimeGrid
              days={data.days}
              groupBy={view === 'day' ? 'practitioner' : 'day'}
              isMoving={reschedule.isPending}
              onBookSlot={(slot, date) => setBooking({ slot, date })}
              onOpenEntry={(entry) => router.push(`/patients/${entry.patientId}`)}
              onMoveEntry={onMove}
            />
          )}
        </div>
      )}

        </div>
      </div>

      <BookSlotDialog
        slot={booking?.slot ?? null}
        date={booking?.date ?? null}
        onClose={() => setBooking(null)}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Both readers fall back rather than throwing.
 *
 * A URL is user input — pasted, truncated, edited by hand, or left over from a
 * version of this screen that had different views. A calendar that renders an
 * error page because `?view=fortnight` is in the address bar is worse than one
 * that shows today.
 */
function parseView(value: string | null): CalendarView {
  return CALENDAR_VIEWS.some((v) => v.value === value) ? (value as CalendarView) : 'day';
}

function parseDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  // Shape alone is not enough: 2026-02-31 matches the pattern and is not a day.
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : value;
}

/** "Thu 2 Oct", "2–4 Oct", "29 Sep – 5 Oct", "October 2026". */
function rangeLabel(view: CalendarView, anchor: string, from: string, to: string): string {
  /*
   * `en-GB`, which is DAY FIRST — "25 Oct", not "Oct 25".
   *
   * Not a locale preference: the rest of this product formats dates with
   * date-fns as `d MMM yyyy`, and the default locale here was producing
   * month-first, so the calendar's own header read "19 – Oct 25" while every
   * other screen read "25 Oct 2026". Two orderings on one page is the kind of
   * thing that makes somebody misread a date, which on a clinic calendar means
   * a patient told the wrong day.
   */
  const LOCALE = 'en-GB';
  const at = (iso: string) => new Date(`${iso}T12:00:00`);

  if (view === 'month') {
    return at(startOfMonth(anchor)).toLocaleDateString(LOCALE, {
      month: 'long',
      year: 'numeric',
    });
  }

  if (view === 'day') {
    return at(from).toLocaleDateString(LOCALE, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  }

  // `to` is exclusive, so the last day shown is the one before it.
  const last = new Date(at(to).getTime() - 86_400_000);
  const sameMonth = last.getMonth() === at(from).getMonth();

  // "19 – 25 Oct" within a month, "29 Sep – 5 Oct" across one.
  return `${at(from).toLocaleDateString(LOCALE, {
    day: 'numeric',
    ...(sameMonth ? {} : { month: 'short' }),
  })} – ${last.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })}`;
}
