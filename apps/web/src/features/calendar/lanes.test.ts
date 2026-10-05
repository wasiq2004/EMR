import { beforeEach, describe, expect, it } from 'vitest';
import type { CalendarEntry } from '@emr/contracts';
import { layOutLanes } from './time-grid';

/**
 * Overlap lanes.
 *
 * Tested because the previous grid got this wrong in a way nothing would have
 * caught: every block was `inset-x-1`, so two appointments at the same time were
 * drawn exactly on top of each other and the one underneath was invisible. For a
 * clinic running a token system — four people told "after ten", which
 * `capacity_per_slot` exists to express — that hid the entire point of the
 * feature, and the page still rendered perfectly.
 *
 * Minutes here are LOCAL, because the grid positions blocks from local
 * `getHours()`. The helper builds an ISO string with no zone suffix so the
 * runtime reads it as local, matching what the component does.
 */

let counter = 0;

/*
 * Reset per test, so ids are e1, e2… within each one.
 *
 * Without this the counter carries across tests and the second test asserts on
 * `e1` while the helper has already produced `e3` — every expectation reads
 * `expected undefined`, which looks like the algorithm failing rather than the
 * fixture numbering drifting.
 */
beforeEach(() => {
  counter = 0;
});

function entry(startLocal: string, minutes: number): CalendarEntry {
  counter += 1;
  const start = new Date(`2026-10-05T${startLocal}:00`);
  return {
    id: `e${counter}`,
    patientId: '00000000-0000-0000-0000-000000000001',
    patientName: `Patient ${counter}`,
    patientMrn: `MRN${counter}`,
    patientMobile: null,
    practitionerId: null,
    practitionerName: null,
    locationId: null,
    status: 'SCHEDULED',
    scheduledStart: start.toISOString(),
    scheduledEnd: new Date(start.getTime() + minutes * 60_000).toISOString(),
    minutes,
    isWalkIn: false,
    reasonText: null,
    version: 1,
  };
}

/** `{ id: [lane, lanes] }`, which is what the component actually consumes. */
function lanesOf(entries: CalendarEntry[]): Record<string, [number, number]> {
  return Object.fromEntries(
    layOutLanes(entries).map((l) => [l.entry.id, [l.lane, l.lanes]]),
  );
}

describe('layOutLanes', () => {
  it('gives a lone appointment the whole column', () => {
    const a = entry('09:00', 15);
    expect(lanesOf([a])).toEqual({ e1: [0, 1] });
  });

  it('leaves appointments that do not overlap at full width', () => {
    // 09:00-09:15 and 09:15-09:30 touch but do not overlap. Half-width here
    // would waste the column for the commonest case there is.
    const a = entry('09:00', 15);
    const b = entry('09:15', 15);
    const out = lanesOf([a, b]);
    expect(out.e1).toEqual([0, 1]);
    expect(out.e2).toEqual([0, 1]);
  });

  it('splits two simultaneous appointments side by side', () => {
    const a = entry('10:00', 30);
    const b = entry('10:00', 30);
    const out = lanesOf([a, b]);
    expect(out.e1).toEqual([0, 2]);
    expect(out.e2).toEqual([1, 2]);
  });

  /*
   * The token-system case this exists for: a capacity-4 slot with four people
   * told "after ten". All four must be visible.
   */
  it('splits four simultaneous appointments into four lanes', () => {
    const all = [entry('10:00', 30), entry('10:00', 30), entry('10:00', 30), entry('10:00', 30)];
    const out = lanesOf(all);
    expect(new Set(Object.values(out).map(([lane]) => lane))).toEqual(new Set([0, 1, 2, 3]));
    for (const [, lanes] of Object.values(out)) expect(lanes).toBe(4);
  });

  it('reuses a lane once its occupant has ended', () => {
    // A long one spanning two short ones: the shorts share the second lane
    // rather than opening a third.
    const long = entry('09:00', 60);
    const first = entry('09:00', 30);
    const second = entry('09:30', 30);
    const out = lanesOf([long, first, second]);
    expect(out.e1).toEqual([0, 2]);
    expect(out.e2).toEqual([1, 2]);
    expect(out.e3).toEqual([1, 2]);
  });

  /*
   * CLUSTERS ARE INDEPENDENT. Two appointments at 09:00 and one at 14:00 must
   * not all become one-third width — the afternoon one has the column to itself
   * and should look like it.
   */
  it('does not let one busy hour narrow the rest of the day', () => {
    const out = lanesOf([entry('09:00', 30), entry('09:00', 30), entry('14:00', 30)]);
    expect(out.e1).toEqual([0, 2]);
    expect(out.e2).toEqual([1, 2]);
    expect(out.e3).toEqual([0, 1]);
  });

  it('puts the longer appointment in the leftmost lane on a tie', () => {
    // Reads better than the reverse: the long block anchors the group rather
    // than being pushed to the right of a 10-minute one.
    const short = entry('11:00', 10);
    const long = entry('11:00', 45);
    const out = lanesOf([short, long]);
    expect(out.e2).toEqual([0, 2]);
    expect(out.e1).toEqual([1, 2]);
  });

  it('is not affected by the order it is given them in', () => {
    const a = entry('09:00', 60);
    const b = entry('09:15', 15);
    const forwards = lanesOf([a, b]);
    const backwards = lanesOf([b, a]);
    expect(backwards).toEqual(forwards);
  });

  it('returns every appointment it was given', () => {
    const all = [entry('09:00', 30), entry('09:15', 30), entry('09:30', 30)];
    expect(layOutLanes(all)).toHaveLength(3);
  });

  it('handles an empty day', () => {
    expect(layOutLanes([])).toEqual([]);
  });

  /*
   * A chain where each overlaps only its neighbour. The cluster is three wide
   * because nothing in it ends before the next begins — three lanes is correct
   * even though no single instant has three appointments in it. Getting this
   * "wrong" in the clever direction is how calendars end up drawing blocks that
   * visually overlap.
   */
  it('keeps a staircase of overlaps readable', () => {
    const out = lanesOf([entry('09:00', 30), entry('09:20', 30), entry('09:40', 30)]);
    expect(out.e1?.[0]).toBe(0);
    expect(out.e2?.[0]).toBe(1);
    // The third starts after the first has ended, so it reclaims lane 0.
    expect(out.e3?.[0]).toBe(0);
    for (const [, lanes] of Object.values(out)) expect(lanes).toBe(2);
  });
});
