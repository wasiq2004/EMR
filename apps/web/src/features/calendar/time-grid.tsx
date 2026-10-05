'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';
import type { CalendarColumn, CalendarDay, CalendarEntry, Slot } from '@emr/contracts';
import { APPOINTMENT_CLOSED_STATUSES, APPOINTMENT_STATUS_LABEL } from '@emr/contracts';
import { cn } from '@/lib/cn';
import { formatTime } from '@/lib/format';
import { APPOINTMENT_BLOCK_CLASS } from '@/lib/appointment-status';

/**
 * The time grid.
 *
 * WHY ABSOLUTE POSITIONING RATHER THAN A CSS GRID OF SLOT CELLS. Appointments do
 * not respect slot boundaries. A 15-minute grid with a 20-minute appointment on
 * it, or two overlapping ones from a capacity-2 session, cannot be expressed as
 * cells — and a clinic that overbooks deliberately is the one that most needs to
 * see the overlap. So the slots are the background and the appointments float
 * above them, positioned by minutes from the top.
 *
 * TWO COLUMN MODES, because the right answer differs by view:
 *
 *   - `practitioner` — one column per doctor. This is the day view, and it is
 *     what a front desk works from: three doctors side by side, and you can see
 *     at a glance which one has the gap.
 *   - `day` — one column per day, every doctor merged, with the doctor's name on
 *     the block. This is the week view. One column per day-doctor PAIR would be
 *     twenty-one columns for three doctors over a week, which is unreadable at
 *     any screen width — and nobody scanning a week is choosing between doctors,
 *     they are looking for a day.
 *
 * THE GRID'S EXTENT COMES FROM THE DATA, not from a fixed 00:00–24:00. A clinic
 * open 09:00–20:00 should not scroll past nine empty hours to reach its morning,
 * and one with a 07:00 session should not find it clipped.
 */

/** Pixels per minute. 1.0 gives an hour 60px, which is Google Calendar's own. */
const PX_PER_MINUTE = 1;
/** Fallback window when a day has nothing at all to draw. */
const DEFAULT_OPEN_MINUTES = 8 * 60;
const DEFAULT_CLOSE_MINUTES = 20 * 60;
/** The header's height, shared by the gutter spacer so the two line up. */
const HEADER_HEIGHT = 56;

export type GroupBy = 'practitioner' | 'day';

export interface TimeGridProps {
  days: CalendarDay[];
  /** One column per doctor, or one per day. See the note above. */
  groupBy?: GroupBy;
  onBookSlot?: (slot: Slot, date: string) => void;
  onOpenEntry?: (entry: CalendarEntry) => void;
  onMoveEntry?: (entry: CalendarEntry, to: { startsAt: string; column: CalendarColumn }) => void;
  /** Shown while a reschedule is in flight, so a drag cannot be repeated. */
  isMoving?: boolean;
}

export function TimeGrid({
  days,
  groupBy = 'practitioner',
  onBookSlot,
  onOpenEntry,
  onMoveEntry,
  isMoving = false,
}: TimeGridProps) {
  const bounds = React.useMemo(() => dayBounds(days), [days]);
  const height = (bounds.close - bounds.open) * PX_PER_MINUTE;

  const now = useNow();
  const scroller = React.useRef<HTMLDivElement>(null);

  /*
   * The appointment being dragged, held here rather than in the DOM.
   *
   * HTML drag-and-drop can only carry strings, and reading the entry back out of
   * `dataTransfer` means re-finding it by id on every dragover — which fires
   * continuously. Keeping the object makes the drop handler trivial.
   */
  const [dragging, setDragging] = React.useState<CalendarEntry | null>(null);
  const [hovering, setHovering] = React.useState<string | null>(null);

  /*
   * Scrolled to the working day on mount, once.
   *
   * Opening on 08:00 when the clinic starts at nine wastes the top of the
   * screen; opening on the current time is wrong at 7pm, when what you want is
   * tomorrow morning's shape. So: an hour before now if now is inside the day,
   * otherwise the start of the day.
   */
  React.useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const target =
      nowMinutes > bounds.open && nowMinutes < bounds.close ? nowMinutes - 60 : bounds.open;
    el.scrollTop = Math.max(0, (target - bounds.open) * PX_PER_MINUTE);
    // Deliberately on mount only — re-scrolling as the clock ticks would drag
    // the page out from under somebody reading it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds.open, bounds.close]);

  const columns = React.useMemo(
    () => buildColumns(days, groupBy),
    [days, groupBy],
  );

  return (
    <div className="flex flex-col overflow-hidden rounded-md border border-line-soft bg-surface">
      {/* ---- Sticky header: the day and doctor labels ---- */}
      <div className="flex shrink-0 border-b border-line-soft">
        <div className="w-16 shrink-0 border-r border-line-soft" />
        <div className="flex min-w-0 flex-1">
          {columns.map((column) => (
            <ColumnHeader key={column.key} column={column} groupBy={groupBy} />
          ))}
        </div>
      </div>

      {/* ---- The scrolling body ---- */}
      <div ref={scroller} className="flex max-h-[34rem] overflow-y-auto scroll-thin">
        {/* The clock, in its own gutter so the labels never overlap a block. */}
        <div className="sticky left-0 z-20 w-16 shrink-0 border-r border-line-soft bg-surface">
          <div className="relative" style={{ height }}>
            {hourMarks(bounds).map((minutes) => (
              <span
                key={minutes}
                className="absolute right-2 -translate-y-1/2 text-2xs tabular text-ink-faint"
                style={{ top: (minutes - bounds.open) * PX_PER_MINUTE }}
              >
                {labelForMinutes(minutes)}
              </span>
            ))}
          </div>
        </div>

        <div className="flex min-w-0 flex-1" style={{ height }}>
          {columns.map((column) => (
            <GridColumn
              key={column.key}
              column={column}
              bounds={bounds}
              now={now}
              dragging={dragging}
              hovering={hovering}
              isMoving={isMoving}
              groupBy={groupBy}
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
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Headers                                                                    */
/* -------------------------------------------------------------------------- */

function ColumnHeader({ column, groupBy }: { column: BuiltColumn; groupBy: GroupBy }) {
  const today = isToday(column.date);

  return (
    <div
      className={cn(
        'min-w-0 flex-1 border-r border-line-soft px-2 py-1.5 text-center last:border-r-0',
        today && 'bg-accent-soft/30',
      )}
      style={{ height: HEADER_HEIGHT }}
    >
      {groupBy === 'day' ? (
        <>
          <p
            className={cn(
              'text-2xs uppercase tracking-wide',
              today ? 'font-semibold text-accent-ink' : 'text-ink-faint',
            )}
          >
            {weekdayShort(column.date)}
          </p>
          {/*
            The date in a circle when it is today, which is the one piece of
            Google Calendar's chrome that genuinely helps: on a week view you
            need to find today before you can read anything else.
          */}
          <p className="mt-0.5">
            <span
              className={cn(
                'inline-flex size-6 items-center justify-center rounded-full text-sm tabular',
                today ? 'bg-accent font-semibold text-accent-contrast' : 'text-ink',
              )}
            >
              {Number(column.date.slice(8, 10))}
            </span>
          </p>
        </>
      ) : (
        <>
          <p className="truncate text-xs font-medium text-ink" title={column.label}>
            {column.label}
          </p>
          {column.closedReason ? (
            <p className="truncate text-2xs text-warning" title={column.closedReason}>
              {column.closedReason}
            </p>
          ) : (
            <p className="text-2xs text-ink-faint">
              {column.freeCount > 0 ? `${column.freeCount} free` : 'no free slots'}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* A column                                                                   */
/* -------------------------------------------------------------------------- */

function GridColumn({
  column,
  bounds,
  now,
  dragging,
  hovering,
  isMoving,
  groupBy,
  onDragStart,
  onDragEnd,
  onHover,
  onBookSlot,
  onOpenEntry,
  onMoveEntry,
}: {
  column: BuiltColumn;
  bounds: Bounds;
  now: Date;
  dragging: CalendarEntry | null;
  hovering: string | null;
  isMoving: boolean;
  groupBy: GroupBy;
  onDragStart: (entry: CalendarEntry) => void;
  onDragEnd: () => void;
  onHover: (key: string | null) => void;
  onBookSlot?: TimeGridProps['onBookSlot'];
  onOpenEntry?: TimeGridProps['onOpenEntry'];
  onMoveEntry?: TimeGridProps['onMoveEntry'];
}) {
  const today = isToday(column.date);

  /*
   * Overlapping appointments are laid out in LANES.
   *
   * This is the thing the previous grid got wrong: every block was
   * `inset-x-1`, so two appointments at the same time sat exactly on top of each
   * other and the one underneath was invisible. For a clinic running a token
   * system — four people told "after ten", which `capacity_per_slot` exists to
   * express — that hid the entire point of the feature.
   */
  const laid = React.useMemo(() => layOutLanes(column.entries), [column.entries]);

  return (
    <div
      className={cn(
        'relative min-w-0 flex-1 border-r border-line-soft last:border-r-0',
        today && 'bg-accent-soft/15',
      )}
    >
      {/* Hour and half-hour rules, behind everything. */}
      {hourMarks(bounds).map((minutes) => (
        <div
          key={minutes}
          className="pointer-events-none absolute inset-x-0 border-t border-line-soft"
          style={{ top: (minutes - bounds.open) * PX_PER_MINUTE }}
        />
      ))}
      {halfHourMarks(bounds).map((minutes) => (
        <div
          key={minutes}
          /* Lighter than the hour line: it should give a sense of position
             without competing with the blocks. */
          className="pointer-events-none absolute inset-x-0 border-t border-line-soft/40"
          style={{ top: (minutes - bounds.open) * PX_PER_MINUTE }}
        />
      ))}

      {/* Bookable slots. */}
      {column.slots.map((slot) => {
        const key = `${column.key}:${slot.startsAt}`;
        return (
          <SlotCell
            key={`${slot.practitionerId}-${slot.startsAt}`}
            slot={slot}
            bounds={bounds}
            isDropTarget={dragging !== null}
            isHovered={hovering === key}
            onHover={(on) => onHover(on ? key : null)}
            onBook={onBookSlot ? () => onBookSlot(slot, column.date) : undefined}
            onDrop={
              onMoveEntry && dragging
                ? () =>
                    onMoveEntry(dragging, {
                      startsAt: slot.startsAt,
                      column: {
                        practitionerId: slot.practitionerId,
                        practitionerName: slot.practitionerName,
                        closedReason: null,
                        slots: [],
                      },
                    })
                : undefined
            }
          />
        );
      })}

      {column.closedReason && column.slots.length === 0 ? (
        <div className="pointer-events-none absolute inset-x-0 top-6 text-center">
          <span className="rounded-sm bg-warning-soft px-1.5 py-0.5 text-2xs text-warning">
            {column.closedReason}
          </span>
        </div>
      ) : null}

      {/* Appointments, in their lanes. */}
      {laid.map(({ entry, lane, lanes }) => (
        <EntryBlock
          key={entry.id}
          entry={entry}
          bounds={bounds}
          lane={lane}
          lanes={lanes}
          showPractitioner={groupBy === 'day'}
          isMoving={isMoving}
          onOpen={onOpenEntry ? () => onOpenEntry(entry) : undefined}
          onDragStart={() => onDragStart(entry)}
          onDragEnd={onDragEnd}
        />
      ))}

      {/*
        The "now" line.

        Only on today, and above everything else. It is the one piece of chrome
        that answers "where are we" without reading a clock, and on a clinic
        calendar it also answers "how far behind are we" — the gap between the
        line and the block being consulted is the running delay.
      */}
      {today ? <NowLine bounds={bounds} now={now} /> : null}
    </div>
  );
}

function NowLine({ bounds, now }: { bounds: Bounds; now: Date }) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (minutes < bounds.open || minutes > bounds.close) return null;

  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-30"
      style={{ top: (minutes - bounds.open) * PX_PER_MINUTE }}
      aria-hidden
    >
      <div className="relative border-t border-critical">
        <span className="absolute -left-1 -top-[3px] size-1.5 rounded-full bg-critical" />
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
  const label = `${formatTime(slot.startsAt)} with ${slot.practitionerName}${
    full
      ? ` — full (${slot.bookedCount} of ${slot.capacity})`
      : slot.capacity > 1
        ? ` — ${slot.capacity - slot.bookedCount} of ${slot.capacity} free`
        : ' — free'
  }`;

  return (
    <button
      type="button"
      // Disabled when full and nothing can be dropped on it: a button that looks
      // pressable and does nothing is worse than one that is plainly not.
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
        'group absolute inset-x-0 text-left transition-colors',
        full ? 'cursor-default' : 'cursor-pointer hover:bg-accent-soft/60',
        isHovered && 'bg-accent-soft ring-1 ring-inset ring-accent',
      )}
      style={{ top, height }}
    >
      {/*
        A faint "+" on hover rather than a permanent dashed box.

        Google Calendar's empty grid is empty — the affordance appears under the
        cursor. A grid of outlined boxes competes with the appointments for
        attention, and the appointments are the content.
      */}
      {!full && height >= 20 ? (
        <span className="pointer-events-none flex h-full items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
          <Plus className="size-3 text-accent" aria-hidden />
        </span>
      ) : null}
    </button>
  );
}

/* -------------------------------------------------------------------------- */

function EntryBlock({
  entry,
  bounds,
  lane,
  lanes,
  showPractitioner,
  isMoving,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  entry: CalendarEntry;
  bounds: Bounds;
  lane: number;
  lanes: number;
  showPractitioner: boolean;
  isMoving: boolean;
  onOpen?: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const top = (minutesOfDay(entry.scheduledStart) - bounds.open) * PX_PER_MINUTE;
  const height = Math.max(18, entry.minutes * PX_PER_MINUTE);

  /*
   * A closed appointment cannot be dragged.
   *
   * The server refuses it — moving a cancelled or checked-out visit would
   * rewrite history, since it happened, or did not, at the time it says. Making
   * the block undraggable means the user finds that out by the gesture not
   * starting, rather than by an error after they have let go.
   */
  const draggable = !APPOINTMENT_CLOSED_STATUSES.includes(entry.status) && !isMoving;

  /*
   * Lanes, with the last one running to the edge.
   *
   * A 2% gap between lanes keeps two simultaneous appointments visually
   * separate; the rightmost lane takes the remaining width so the column has no
   * dead strip down its right side.
   */
  const widthPct = 100 / lanes;
  const leftPct = lane * widthPct;

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
      title={`${formatTime(entry.scheduledStart)} · ${entry.patientName}${
        entry.practitionerName ? ` · ${entry.practitionerName}` : ''
      } · ${APPOINTMENT_STATUS_LABEL[entry.status]}`}
      className={cn(
        'absolute z-10 overflow-hidden rounded-md border border-l-3 px-1.5 py-0.5',
        'border-line-soft text-left shadow-xs',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
        APPOINTMENT_BLOCK_CLASS[entry.status],
        draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
        isMoving && 'opacity-60',
      )}
      style={{
        top,
        height,
        left: `calc(${leftPct}% + 2px)`,
        width: `calc(${widthPct}% - 4px)`,
      }}
    >
      <p className="truncate text-2xs font-medium leading-tight">{entry.patientName}</p>
      {/*
        Each extra line is dropped rather than clipped mid-word once the block is
        too short for it. A 15-minute block is 15px; anything beyond the name
        would be a sliver of text.
      */}
      {height >= 30 ? (
        <p className="truncate text-2xs leading-tight opacity-75">
          {formatTime(entry.scheduledStart)}
          {entry.isWalkIn ? ' · walk-in' : ''}
        </p>
      ) : null}
      {height >= 44 && showPractitioner && entry.practitionerName ? (
        <p className="truncate text-2xs leading-tight opacity-75">
          {entry.practitionerName}
        </p>
      ) : null}
      {height >= 58 && entry.reasonText ? (
        <p className="truncate text-2xs leading-tight opacity-60">{entry.reasonText}</p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

interface BuiltColumn {
  key: string;
  date: string;
  label: string;
  practitionerId: string | null;
  closedReason: string | null;
  slots: Slot[];
  entries: CalendarEntry[];
  freeCount: number;
}

/**
 * Turns the API's day/column shape into the columns this grid draws.
 *
 * `practitioner` mode produces one column per doctor on the single day, plus one
 * for appointments with nobody assigned — a walk-in added at the counter before
 * anybody decided who would see them is the normal case at an Indian OPD, and
 * dropping those rows would lose patients who are physically in the building.
 *
 * `day` mode produces one column per day with everything merged.
 */
function buildColumns(days: CalendarDay[], groupBy: GroupBy): BuiltColumn[] {
  if (groupBy === 'day') {
    return days.map((day) => {
      const slots = day.columns.flatMap((column) => column.slots);
      return {
        key: day.date,
        date: day.date,
        label: formatDayLabel(day.date),
        practitionerId: null,
        closedReason: day.columns.find((c) => c.closedReason)?.closedReason ?? null,
        slots,
        entries: day.entries,
        freeCount: slots.filter((s) => s.isAvailable).length,
      };
    });
  }

  const day = days[0];
  if (!day) return [];

  const columns = [...day.columns];
  const known = new Set(columns.map((c) => c.practitionerId));

  /*
   * A doctor with appointments but no pattern still gets a column.
   *
   * Otherwise a clinic that has not entered its schedules sees an empty calendar
   * while holding a full day of appointments, which reads as data loss.
   */
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

  return columns
    .sort((a, b) => {
      // The unassigned column last: it is a holding area, not a person.
      if (a.practitionerId === null) return 1;
      if (b.practitionerId === null) return -1;
      return a.practitionerName.localeCompare(b.practitionerName);
    })
    .map((column) => ({
      key: `${day.date}:${column.practitionerId ?? 'unassigned'}`,
      date: day.date,
      label: column.practitionerName,
      practitionerId: column.practitionerId,
      closedReason: column.closedReason,
      slots: column.slots,
      entries: day.entries.filter(
        (entry) => (entry.practitionerId ?? null) === column.practitionerId,
      ),
      freeCount: column.slots.filter((s) => s.isAvailable).length,
    }));
}

/**
 * Side-by-side lanes for appointments that overlap in time.
 *
 * The standard interval-graph colouring every calendar uses:
 *
 *   1. Sort by start, longest first on a tie — so the long appointment takes the
 *      leftmost lane and the short ones stack to its right, which reads better
 *      than the reverse.
 *   2. Walk the list accumulating a CLUSTER: a run of appointments where each
 *      one starts before the latest end seen so far. Everything in a cluster
 *      shares a lane count, so two appointments at 9:00 and a third at 11:00 do
 *      not all become one-third width.
 *   3. Inside a cluster, put each appointment in the first lane whose previous
 *      occupant has already ended.
 *
 * Without this, two appointments at the same time are drawn exactly on top of
 * each other and the one underneath is invisible — which for a clinic running a
 * token system, four people told "after ten", hides the whole point of
 * `capacity_per_slot`.
 */
export function layOutLanes(
  entries: CalendarEntry[],
): { entry: CalendarEntry; lane: number; lanes: number }[] {
  if (entries.length === 0) return [];

  const sorted = [...entries].sort((a, b) => {
    const byStart = minutesOfDay(a.scheduledStart) - minutesOfDay(b.scheduledStart);
    return byStart !== 0 ? byStart : b.minutes - a.minutes;
  });

  const out: { entry: CalendarEntry; lane: number; lanes: number }[] = [];

  let cluster: { entry: CalendarEntry; lane: number }[] = [];
  let clusterEnd = -Infinity;
  /** The end minute of the last appointment in each lane of this cluster. */
  let laneEnds: number[] = [];

  const flush = () => {
    const lanes = Math.max(1, laneEnds.length);
    for (const member of cluster) out.push({ ...member, lanes });
    cluster = [];
    laneEnds = [];
    clusterEnd = -Infinity;
  };

  for (const entry of sorted) {
    const start = minutesOfDay(entry.scheduledStart);
    const end = start + entry.minutes;

    // A gap: this appointment overlaps nothing before it, so the previous
    // cluster is complete and its lane count is final.
    if (start >= clusterEnd) flush();

    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }

    cluster.push({ entry, lane });
    clusterEnd = Math.max(clusterEnd, end);
  }
  flush();

  return out;
}

/* -------------------------------------------------------------------------- */
/* Time                                                                       */
/* -------------------------------------------------------------------------- */

interface Bounds {
  open: number;
  close: number;
}

/**
 * The window to draw, from everything there is to draw.
 *
 * Appointments are included as well as slots: one booked outside the pattern — a
 * favour squeezed in at 07:30, or a leftover from before the hours changed —
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

  // Rounded out to the hour so the rules line up with the labels, with padding
  // so the first and last blocks are not flush against the edges.
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

function halfHourMarks(bounds: Bounds): number[] {
  const marks: number[] = [];
  for (let m = Math.ceil(bounds.open / 30) * 30; m <= bounds.close; m += 30) {
    if (m % 60 !== 0) marks.push(m);
  }
  return marks;
}

/**
 * The clock, ticking once a minute.
 *
 * A minute is the right granularity: the "now" line moves one pixel per minute
 * at this scale, and a faster interval would re-render the whole grid for a
 * sub-pixel change.
 */
function useNow(): Date {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(new Date()), 60_000);
    return () => globalThis.clearInterval(timer);
  }, []);
  return now;
}

/**
 * Minutes since midnight, in the VIEWER's timezone.
 *
 * The instant comes from the server as UTC and the grid is drawn in local time,
 * which for this product is the clinic's own timezone. Using the UTC minutes
 * would put a 09:00 IST appointment at 03:30 on the grid — the clinic's own
 * morning, half a day out.
 */
function minutesOfDay(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

function labelForMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const suffix = h < 12 ? 'am' : 'pm';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display} ${suffix}`;
}

/* Day first, matching the rest of the product. See `rangeLabel` on the page. */
function formatDayLabel(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function weekdayShort(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short' });
}

/**
 * Local-date comparison, not an instant comparison.
 *
 * `new Date(iso) === now` is never true, and comparing instants would make
 * "today" depend on the time of day. The column's date is already a local
 * calendar date, so the comparison is string against string.
 */
function isToday(isoDate: string): boolean {
  const now = new Date();
  const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return isoDate === local;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
