'use client';

import * as React from 'react';

/**
 * The live update stream.
 *
 * ONE EventSource PER TAB, fanned out to every subscriber. Opening a stream per
 * component would burn several of the browser's six connections per origin —
 * and the inbox alone would want three, leaving the screens next to it unable
 * to load. The hook's surface hides that entirely: subscribe, get events.
 *
 * RECONNECTION IS THE HARD PART. EventSource cannot read the HTTP status of a
 * failed connection, so an expired session and a dropped network are the same
 * observable event. What separates them is whether the stream ever OPENED: a
 * rejected connection never fires `onopen`. So consecutive failures with no
 * open are treated as "repeating this will not help", and after a few we stop
 * and say so — rather than reconnecting forever against a 401, which is how a
 * quiet reconnect loop turns into a busy one nobody notices.
 */

export type ServerEventType =
  | 'hello'
  | 'heartbeat'
  | 'message-new'
  | 'message-status'
  | 'conversation-changed'
  | 'broadcast-progress';

export interface ServerEvent {
  type: ServerEventType;
  data: Record<string, string | number | boolean | null>;
}

type Subscriber = (event: ServerEvent) => void;

const STREAM_URL = '/api/events';
const EVENT_TYPES: ServerEventType[] = [
  'hello',
  'heartbeat',
  'message-new',
  'message-status',
  'conversation-changed',
  'broadcast-progress',
];

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
/** Consecutive failures that never opened, after which we stop trying. */
const MAX_COLD_FAILURES = 6;

const subscribers = new Set<Subscriber>();
const statusWatchers = new Set<(status: StreamStatus) => void>();

export type StreamStatus = 'connecting' | 'live' | 'retrying' | 'off';

let source: EventSource | null = null;
let handlers: Partial<Record<ServerEventType, (event: MessageEvent) => void>> = {};
let coldFailures = 0;
let openedThisConnection = false;
let gaveUp = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let status: StreamStatus = 'off';

function setStatus(next: StreamStatus) {
  if (status === next) return;
  status = next;
  for (const watcher of statusWatchers) watcher(next);
}

function backoffDelay(): number {
  const exponential = Math.min(BASE_DELAY_MS * 2 ** coldFailures, MAX_DELAY_MS);
  // Jitter. Every tab in the building reconnects on the same server blip, and a
  // synchronised retry is how a recovering server gets knocked over again.
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

function scheduleRetry() {
  if (retryTimer || gaveUp || subscribers.size === 0) return;
  setStatus('retrying');
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, backoffDelay());
}

function connect() {
  if (typeof EventSource === 'undefined') return; // SSR, or a test environment
  if (gaveUp || subscribers.size === 0) return;
  // EventSource retries by itself while CONNECTING; only step in once it is
  // fully CLOSED (readyState 2) or absent.
  if (source && source.readyState !== 2) return;

  setStatus('connecting');
  source = new EventSource(STREAM_URL, { withCredentials: true });
  openedThisConnection = false;

  source.onopen = () => {
    openedThisConnection = true;
    coldFailures = 0; // a real connection clears the budget
    setStatus('live');
  };

  source.onerror = () => {
    if (!openedThisConnection) coldFailures += 1;

    if (coldFailures >= MAX_COLD_FAILURES) {
      gaveUp = true;
      setStatus('off');
      try {
        source?.close();
      } catch {
        /* already gone */
      }
      source = null;
      // Said plainly. A silent stop looks exactly like a quiet clinic, and
      // someone would sit in front of a screen that stopped updating.
      console.error(
        `[events] gave up after ${coldFailures} failed connections — live updates are off until this page is reloaded`,
      );
      return;
    }

    if (source?.readyState === 2) scheduleRetry();
  };

  for (const type of EVENT_TYPES) {
    const handler = (event: MessageEvent) => {
      let data: ServerEvent['data'] = {};
      try {
        data = JSON.parse(event.data as string);
      } catch {
        /* an unparseable event is not worth taking the stream down for */
      }
      for (const subscriber of subscribers) {
        try {
          subscriber({ type, data });
        } catch {
          // One broken subscriber must not stop delivery to the rest.
        }
      }
    };
    handlers[type] = handler;
    source.addEventListener(type, handler);
  }
}

function disconnect() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (!source) return;
  for (const type of EVENT_TYPES) {
    const handler = handlers[type];
    if (handler) source.removeEventListener(type, handler);
  }
  handlers = {};
  try {
    source.close();
  } catch {
    /* already gone */
  }
  source = null;
  setStatus('off');
}

/**
 * Subscribes to live events for the signed-in clinic.
 *
 * `onEvent` must be stable — wrap it in useCallback. An unstable callback
 * resubscribes on every render, which is handled correctly but pointlessly.
 */
export function useServerEvents(onEvent: Subscriber): void {
  React.useEffect(() => {
    subscribers.add(onEvent);
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    connect();

    return () => {
      subscribers.delete(onEvent);
      if (subscribers.size > 0) return;

      // Deferred. A dependency change removes the old callback and adds the new
      // one in the same commit, and tearing the stream down in between would
      // reconnect on every keystroke that changes a dependency.
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        closeTimer = null;
        if (subscribers.size === 0) disconnect();
      }, 1_000);
    };
  }, [onEvent]);
}

/** Whether live updates are working, for the small indicator in the inbox. */
export function useStreamStatus(): StreamStatus {
  const [current, setCurrent] = React.useState<StreamStatus>(status);

  React.useEffect(() => {
    statusWatchers.add(setCurrent);
    setCurrent(status);
    return () => {
      statusWatchers.delete(setCurrent);
    };
  }, []);

  return current;
}

/** Test seam: drops the connection and every subscriber. */
export function __resetServerEvents() {
  disconnect();
  subscribers.clear();
  statusWatchers.clear();
  coldFailures = 0;
  gaveUp = false;
  status = 'off';
}
