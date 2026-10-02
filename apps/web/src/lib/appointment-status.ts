import type { AppointmentStatus } from '@emr/contracts';

/**
 * How an appointment's state is coloured, in one place.
 *
 * It was previously inlined in the appointments list with `'info' as never` to
 * get past the type, and with no entry for `CHECKED_OUT` — so a checked-out
 * appointment fell through to neutral grey and looked identical to one nobody
 * had touched yet. Two screens now draw the same statuses and they must not
 * disagree about what a colour means.
 *
 * THE GROUPING IS BY WHAT THE FRONT DESK HAS TO DO:
 *   neutral  — nothing to do yet
 *   info     — confirmed, so expected
 *   accent   — the patient is HERE and waiting on somebody
 *   positive — finished cleanly
 *   warning  — went wrong in a way worth noticing (a no-show is lost revenue)
 *
 * Cancelled stays neutral on purpose. It is not a problem to act on; a
 * cancellation entered yesterday does not need to catch the eye today.
 */
export type StatusTone = 'neutral' | 'accent' | 'positive' | 'warning' | 'critical' | 'info';

export const APPOINTMENT_STATUS_TONE: Record<AppointmentStatus, StatusTone> = {
  SCHEDULED: 'neutral',
  CONFIRMED: 'info',
  ARRIVED: 'accent',
  IN_PROGRESS: 'accent',
  FULFILLED: 'positive',
  CHECKED_OUT: 'positive',
  CANCELLED: 'neutral',
  NOSHOW: 'warning',
};

/**
 * The block's fill on the calendar grid.
 *
 * Separate from the badge tone because a grid block is a large area of colour
 * rather than a chip, and the badge's fills at that size read as alarming — a
 * day of ordinary scheduled appointments should not look like a day of alerts.
 * These are quieter, with the left border carrying the state.
 */
export const APPOINTMENT_BLOCK_CLASS: Record<AppointmentStatus, string> = {
  SCHEDULED: 'border-l-line-strong bg-surface-sunk text-ink',
  CONFIRMED: 'border-l-info bg-info-soft text-info',
  ARRIVED: 'border-l-accent bg-accent-soft text-accent-ink',
  IN_PROGRESS: 'border-l-accent bg-accent-soft text-accent-ink',
  FULFILLED: 'border-l-positive bg-positive-soft text-positive',
  CHECKED_OUT: 'border-l-positive/50 bg-surface-sunk text-ink-soft',
  // Struck through as well as faded: a cancelled block still occupies its place
  // in the grid, and fading alone reads as "not loaded yet".
  CANCELLED: 'border-l-line bg-surface-sunk text-ink-faint line-through',
  NOSHOW: 'border-l-warning bg-warning-soft text-warning',
};
