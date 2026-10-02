'use client';

import * as React from 'react';
import type { CalendarColumn, CalendarDay, CalendarEntry, Slot } from '@emr/contracts';
import { APPOINTMENT_STATUS_LABEL, APPOINTMENT_CLOSED_STATUSES } from '@emr/contracts';
import { cn } from '@/lib/cn';
import { formatTime } from '@/lib/format';
import { APPOINTMENT_BLOCK_CLASS } from '@/lib/appointment-status';

/**
 * The time grid: one column per doctor, appointments drawn against the clock.
 *
 * WHY ABSOLUTE POSITIONING RATHER THAN A CSS GRID OF SLOT CELLS. Appointments do
 * not respect the slot boundaries. A 15-minute grid with a 20-minute appointment
 * on it, or two overlapping ones from a capacity-2 session, cannot be expressed
 * as cells — and the clinic that overbooks deliberately is the one that most
 * needs to see the overlap. So the slots are the background and the appointments
 * float above them, positioned by minutes from the top.
 *
 * THE GRID'S EXTENT COMES FROM THE DATA, not from a fixed 00:00–24:00. A clinic
 * open 09:00–20:00 should not scroll past nine empty hours to reach its morning,
 * and one with a 07:00 session should not find it clipped. The bounds are the
 * earliest and latest of everything there is to draw — slots and appointments
 * both, because an appointment outside the pattern still has to appear
 * somewhere.
 */

/** Pixels per minute. 1.3 gives a 15-minute slot ~20px: tappable, not wasteful. */
const PX_PER_MINUTE = 1.3;
/** Fallback window when a day has nothing at all to draw. */
const DEFAULT_OPEN_MINUTES = 9 * 60;
const DEFAULT_CLOSE_MINUTES = 20 * 60;

export interface TimeGridProps {
  days: CalendarDay[];
  /** Null when slots are hidden; the grid then draws appointments only. */
  onBookSlot?: (slot: Slot, date: string) => void;
  onOpenEntry?: (entry: CalendarEntry) => void;
  onMoveEntry?: (entry: CalendarEntry, to: { startsAt: string; column: CalendarColumn }) => void;
  /** Shown while a reschedule is in flight, so a drag cannot be repeated. */
  isMoving?: boolean;
}

export function TimeGrid({
  days,
  onBookSlot,
  onOpenEntry,
  onMoveEntry,
  isMoving = false,
}: TimeGridProps) {
  const bounds = React.useMemo(() => dayBounds(days), [days]);
  const height = (bounds.close - bounds.open) * PX_PER_MINUTE;

  /*
   * The appointment being dragged, held here rather than in the DOM.
   *
   * HTML drag-and-drop can only carry strings, and reading the entry back out of
   * `dataTransfer` means re-finding it by id on every dragover — which fires
   * continuously. Keeping the object makes the drop handler trivial and the
   * hover highlight cheap.
   */
  const [dragging, setDragging] = React.useState<CalendarEntry | null>(null);
  const [hovering, setHovering] = React.useState<string | null>(null);

  return (
    <div className="overflow-x-auto">
      <div className="flex min-w-fit">
        {/* The clock down the side, once, however many days are shown. */}
        <div className="sticky left-0 z-20 w-14 shrink-0 bg-surface">
          <div className="h-[3.25rem] border-b border-line-soft" />
          <div className="relative" style={{ height }}>
            {hourMarks(bounds).map((minutes) => (
              <div
                key={minutes}
                className="absolute -translate-y-1/2 pr-2 text-right text-2xs tabular text-ink-faint"
                style={{ top: (minutes - bounds.open) * PX_PER_MINUTE, width: '100%' }}
              >
                {labelForMinutes(minutes)}
              </div>
            ))}
          </div>
        </div>

        {days.map((day) => (
          <DayColumns
            key={day.date}
            day={day}
            bounds={bounds}
            height={height}
            showDate={days.length > 1}
            dragging={dragging}
            hovering={hovering}
            isMoving={isMoving}
            onDragStart={setDragging}
            onDragEnd={() => {
              setDragging(null);
              setHovering(null);
            }}
            onHover={setHovering}
            onBookSlot={onBookSlot}
            onOpenEntry={onOpenEntry}
            onMoveEntry={onMoveEntry}
          />
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function DayColumns({
  day,
  bounds,
  height,
  showDate,
  dragging,
  hovering,
  isMoving,
  onDragStart,
  onDragEnd,
  onHover,
  onBookSlot,
  onOpenEntry,
  onMoveEntry,
}: {
  day: CalendarDay;
  bounds: Bounds;
  height: number;
  showDate: boolean;
  dragging: CalendarEntry | null;
  hovering: string | null;
  isMoving: boolean;
  onDragStart: (entry: CalendarEntry) => void;
  onDragEnd: () => void;
  onHover: (key: string | null) => void;
  onBookSlot?: TimeGridProps['onBookSlot'];
  onOpenEntry?: TimeGridProps['onOpenEntry'];
  onMoveEntry?: TimeGridProps['onMoveEntry'];
}) {
  /*
   * Appointments with no doctor get a column of their own.
   *
   * A walk-in added at the counter before anybody decides who will see them is
   * the normal case at an Indian OPD, and dropping those rows — or hiding them
   * under the first doctor — loses patients who are physically in the building.
   */
  const columns = columnsWithUnassigned(day);

  return (
    <div className="shrink-0 border-l border-line-soft">
      <div className="flex h-[3.25rem] items-center border-b border-line-soft">
        {columns.map((column) => (
          <div
            key={column.practitionerId ?? 'unassigned'}
            className="w-44 shrink-0 px-2 py-1.5"
          >
            {showDate ? (
              <p className="truncate text-2xs uppercase tracking-wide text-ink-faint">
                {formatDayLabel(day.date)}
              </p>
            ) : null}
            <p className="truncate text-xs font-medium text-ink">{column.practitionerName}</p>
            {column.closedReason ? (
              <p className="truncate text-2xs text-warning" title={column.closedReason}>
                {column.closedReason}
              </p>
            ) : null}
          </div>
        ))}
      </div>

      <div className="flex">
        {columns.map((column) => {
          const entries = day.entries.filter(
            (entry) => (entry.practitionerId ?? null) === column.practitionerId,
          );

          return (
            <div
              key={column.practitionerId ?? 'unassigned'}
              className="relative w-44 shrink-0 border-l border-line-soft/60 first:border-l-0"
              style={{ height }}
            >
              {/* Hour rules, behind everything. */}
              {hourMarks(bounds).map((minutes) => (
                <div
                  key={minutes}
                  className="pointer-events-none absolute inset-x-0 border-t border-line-soft/50"
                  style={{ top: (minutes - bounds.open) * PX_PER_MINUTE }}
                />
              ))}

              {column.slots.map((slot) => {
                const key = `${column.practitionerId ?? 'unassigned'}:${slot.startsAt}`;
                return (
                  <SlotCell
                    key={slot.startsAt}
                    slot={slot}
                    bounds={bounds}
                    isDropTarget={dragging !== null}
                    isHovered={hovering === key}
                    onHover={(on) => onHover(on ? key : null)}
                    onBook={onBookSlot ? () => onBookSlot(slot, day.date) : undefined}
                    onDrop={
                      onMoveEntry && dragging
                        ? () => onMoveEntry(dragging, { startsAt: slot.startsAt, column })
                        : undefined
                    }
                  />
                );
              })}

              {column.closedReason && column.slots.length === 0 ? (
                <div className="absolute inset-0 flex items-start justify-center pt-6">
                  <p className="px-2 text-center text-2xs text-ink-faint">
                    {column.closedReason}
                  </p>
                </div>
              ) : null}

              {entries.map((entry) => (
                <EntryBlock
                  key={entry.id}
                  entry={entry}
                  bounds={bounds}
                  isMoving={isMoving}
                  onOpen={onOpenEntry ? () => onOpenEntry(entry) : undefined}
                  onDragStart={() => onDragStart(entry)}
                  onDragEnd={onDragEnd}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function SlotCell({
  slot,
  bounds,
  isDropTarget,
  isHovered,
  onHover,
  onBook,
  onDrop,
}: {
  slot: Slot;
  bounds: Bounds;
  isDropTarget: boolean;
  isHovered: boolean;
  onHover: (on: boolean) => void;
  onBook?: () => void;
  onDrop?: () => void;
}) {
  const top = (minutesOfDay(slot.startsAt) - bounds.open) * PX_PER_MINUTE;
  const height = slot.minutes * PX_PER_MINUTE;

  const full = !slot.isAvailable;
  const label = `${formatTime(slot.startsAt)}${
    full
      ? ` — full (${slot.bookedCount} of ${slot.capacity})`
      : slot.capacity > 1
        ? ` — ${slot.capacity - slot.bookedCount} of ${slot.capacity} free`
        : ' — free'
  }`;

  return (
    <button
      type="button"
      // Disabled when full and nothing can be dropped on it: a button that
      // looks pressable and does nothing is worse than one that is plainly not.
      disabled={full && !isDropTarget}
      onClick={full ? undefined : onBook}
      onDragOver={
        onDrop
          ? (event) => {
              event.preventDefault();
              onHover(true);
            }
          : undefined
      }
      onDragLeave={onDrop ? () => onHover(false) : undefined}
      onDrop={
        onDrop
          ? (event) => {
              event.preventDefault();
              onHover(false);
              onDrop();
            }
          : undefined
      }
      aria-label={label}
      title={label}
      className={cn(
        'absolute inset-x-0.5 rounded-sm border border-dashed text-left transition-colors',
        full
          ? 'border-line-soft/40 bg-transparent'
          : 'border-line-soft bg-surface hover:border-accent hover:bg-accent-soft',
        isHovered && 'border-accent border-solid bg-accent-soft',
        !full && 'cursor-pointer',
      )}
      style={{ top, height }}
    >
      {/*
        The time is printed only on slots tall enough to hold it. A 5-minute slot
        at this scale is 6px; a label in it overflows into its neighbours and the
        column becomes unreadable.
      */}
      {!full && height >= 18 ? (
        <span className="pointer-events-none block px-1 pt-0.5 text-2xs tabular text-ink-faint">
          {formatTime(slot.startsAt)}
        </span>
      ) : null}
    </button>
  );
}

/* -------------------------------------------------------------------------- */

function EntryBlock({
  entry,
  bounds,
  isMoving,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  entry: CalendarEntry;
  bounds: Bounds;
  isMoving: boolean;
  onOpen?: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const top = (minutesOfDay(entry.scheduledStart) - bounds.open) * PX_PER_MINUTE;
  const height = Math.max(16, entry.minutes * PX_PER_MINUTE);

  /*
   * A closed appointment cannot be dragged.
   *
   * The server refuses it — moving a cancelled or checked-out visit would
   * rewrite history, since it happened, or did not, at the time it says. Making
   * the block undraggable means the user finds that out by the gesture not
   * starting, rather than by an error after they have already let go.
   */
  const draggable = !APPOINTMENT_CLOSED_STATUSES.includes(entry.status) && !isMoving;

  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      onDragStart={
        draggable
          ? (event) => {
              // Firefox will not start a drag without some payload set.
              event.dataTransfer.setData('text/plain', entry.id);
              event.dataTransfer.effectAllowed = 'move';
              onDragStart();
            }
          : undefined
      }
      onDragEnd={draggable ? onDragEnd : undefined}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onOpen?.();
      }}
      title={`${formatTime(entry.scheduledStart)} · ${entry.patientName} · ${
        APPOINTMENT_STATUS_LABEL[entry.status]
      }`}
      className={cn(
        'absolute inset-x-1 z-10 overflow-hidden rounded-sm border border-l-3 px-1.5 py-0.5',
        'border-line-soft text-left shadow-xs',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
        APPOINTMENT_BLOCK_CLASS[entry.status],
        draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
        isMoving && 'opacity-60',
      )}
      style={{ top, height }}
    >
      <p className="truncate text-2xs font-medium leading-tight">{entry.patientName}</p>
      {/* The second line is dropped on short blocks rather than clipped mid-word. */}
      {height >= 32 ? (
        <p className="truncate text-2xs leading-tight opacity-75">
          {formatTime(entry.scheduledStart)}
          {entry.isWalkIn ? ' · walk-in' : ''}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

interface Bounds {
  open: number;
  close: number;
}

/**
 * The window to draw, from everything there is to draw.
 *
 * Appointments are included as well as slots: one booked outside the pattern —
 * a favour squeezed in at 07:30, or a leftover from before the hours changed —
 * still has to appear somewhere, and a grid bounded by the pattern alone would
 * position it off the top where nobody sees it exists.
 */
function dayBounds(days: CalendarDay[]): Bounds {
  let open = Number.POSITIVE_INFINITY;
  let close = Number.NEGATIVE_INFINITY;

  for (const day of days) {
    for (const column of day.columns) {
      for (const slot of column.slots) {
        open = Math.min(open, minutesOfDay(slot.startsAt));
        close = Math.max(close, minutesOfDay(slot.startsAt) + slot.minutes);
      }
    }
    for (const entry of day.entries) {
      open = Math.min(open, minutesOfDay(entry.scheduledStart));
      close = Math.max(close, minutesOfDay(entry.scheduledStart) + entry.minutes);
    }
  }

  if (!Number.isFinite(open) || !Number.isFinite(close) || close <= open) {
    return { open: DEFAULT_OPEN_MINUTES, close: DEFAULT_CLOSE_MINUTES };
  }

  // Rounded out to the hour so the rules line up with the labels, with a little
  // padding so the first and last blocks are not flush against the edges.
  return {
    open: Math.max(0, Math.floor(open / 60) * 60 - 30),
    close: Math.min(24 * 60, Math.ceil(close / 60) * 60 + 30),
  };
}

function hourMarks(bounds: Bounds): number[] {
  const marks: number[] = [];
  for (let m = Math.ceil(bounds.open / 60) * 60; m <= bounds.close; m += 60) marks.push(m);
  return marks;
}

/**
 * Minutes since midnight, in the VIEWER's timezone.
 *
 * The instant comes from the server as UTC and the grid is drawn in local time,
 * which for this product is the same timezone the clinic is in. Using the UTC
 * minutes would put a 09:00 IST appointment at 03:30 on the grid — the clinic's
 * own morning, half a day out.
 */
function minutesOfDay(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

function labelForMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const suffix = h < 12 ? 'am' : 'pm';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}${suffix}`;
}

function formatDayLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * The columns to draw, including one for appointments with no doctor.
 *
 * A day with no pattern at all still gets a column per doctor who has something
 * booked — otherwise a clinic that has not entered its schedules yet sees an
 * empty calendar while holding a full day of appointments, which reads as data
 * loss.
 */
function columnsWithUnassigned(day: CalendarDay): CalendarColumn[] {
  const columns = [...day.columns];
  const known = new Set(columns.map((c) => c.practitionerId));

  for (const entry of day.entries) {
    const id = entry.practitionerId ?? null;
    if (known.has(id)) continue;
    known.add(id);
    columns.push({
      practitionerId: id,
      practitionerName: entry.practitionerName ?? 'No doctor assigned',
      closedReason: null,
      slots: [],
    });
  }

  if (columns.length === 0) {
    columns.push({
      practitionerId: null,
      practitionerName: 'No doctor assigned',
      closedReason: null,
      slots: [],
    });
  }

  // Named doctors first, alphabetically; the unassigned column last, because it
  // is a holding area rather than a person.
  return columns.sort((a, b) => {
    if (a.practitionerId === null) return 1;
    if (b.practitionerId === null) return -1;
    return a.practitionerName.localeCompare(b.practitionerName);
  });
}
