import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseWatchdog } from './database.watchdog';

/**
 * The watchdog, which deliberately exits the process.
 *
 * Tested closely for one reason: every other bug in this codebase makes a
 * feature wrong, and this one makes a HEALTHY API restart. The guards are the
 * whole component — the exit is three lines — so the guards are what is tested.
 *
 * `probe` is private, so these call it through a cast rather than waiting out
 * real fifteen-second intervals. The alternative is fake timers around a
 * `setInterval` that is deliberately `unref`'d, which tests the scheduler
 * rather than the decision.
 */

type Probe = { probe: () => Promise<void> };

/*
 * Returns the Probe view only, not `DatabaseWatchdog & Probe`. Intersecting a
 * class with an interface that redeclares one of its PRIVATE members collapses
 * to `never`, which is a confusing way to learn that `probe` is private.
 */
function watchdogWith(execute: () => Promise<unknown>): Probe {
  const db = { execute } as unknown as ConstructorParameters<typeof DatabaseWatchdog>[0];
  return new DatabaseWatchdog(db) as unknown as Probe;
}

/** Inferred from the spy, because `process.exit` returns `never`. */
function spyOnExit() {
  return vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
}

const ok = () => Promise.resolve([]);
const dead = () => Promise.reject(new Error('connection timeout'));

describe('DatabaseWatchdog', () => {
  let exit: ReturnType<typeof spyOnExit>;

  beforeEach(() => {
    // Replaced rather than allowed to run, for obvious reasons.
    exit = spyOnExit();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /*
   * THE GUARD THAT MATTERS MOST. A deploy where Postgres takes two minutes to
   * accept connections must not exit the API six times before it has ever
   * started — that turns a slow start into a crash loop that looks like a far
   * worse problem than it is.
   */
  it('never exits before the database has answered once', async () => {
    const w = watchdogWith(dead);
    for (let i = 0; i < 20; i += 1) await w.probe();
    expect(exit).not.toHaveBeenCalled();
  });

  it('exits after six consecutive failures, once it has connected', async () => {
    let healthy = true;
    const w = watchdogWith(() => (healthy ? ok() : dead()));

    await w.probe(); // the first success arms it
    healthy = false;

    for (let i = 0; i < 5; i += 1) {
      await w.probe();
      expect(exit, `exited after only ${i + 1} failures`).not.toHaveBeenCalled();
    }

    await w.probe(); // the sixth
    expect(exit).toHaveBeenCalledWith(1);
  });

  /*
   * A blip must not accumulate. Five failures, one success, five more failures
   * is a flaky network — not an outage — and restarting through it would make
   * the flakiness worse by adding a cold start to every recovery.
   */
  it('a single success resets the count completely', async () => {
    let healthy = true;
    const w = watchdogWith(() => (healthy ? ok() : dead()));

    await w.probe();
    healthy = false;
    for (let i = 0; i < 5; i += 1) await w.probe();
    expect(exit).not.toHaveBeenCalled();

    healthy = true;
    await w.probe();

    healthy = false;
    for (let i = 0; i < 5; i += 1) await w.probe();
    expect(exit, 'the count carried over a success').not.toHaveBeenCalled();

    await w.probe();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits non-zero, so a restart policy treats it as a failure', async () => {
    let healthy = true;
    const w = watchdogWith(() => (healthy ? ok() : dead()));
    await w.probe();
    healthy = false;
    for (let i = 0; i < 6; i += 1) await w.probe();

    expect(exit).toHaveBeenCalledWith(1);
    expect(exit).not.toHaveBeenCalledWith(0);
  });

  /** A database that simply works must never be interrupted. */
  it('does nothing at all while the database answers', async () => {
    const w = watchdogWith(ok);
    for (let i = 0; i < 50; i += 1) await w.probe();
    expect(exit).not.toHaveBeenCalled();
  });

  /*
   * A rejection that is not an Error — a string, a driver object — must not
   * throw inside the handler. An exception in the watchdog would surface as an
   * unhandled rejection and could take the process down for the wrong reason.
   */
  it('survives a rejection that is not an Error', async () => {
    let healthy = true;
    const w = watchdogWith(() => (healthy ? ok() : Promise.reject('socket hang up')));
    await w.probe();
    healthy = false;
    for (let i = 0; i < 6; i += 1) await expect(w.probe()).resolves.toBeUndefined();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
