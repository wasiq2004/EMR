/**
 * Draft outbox and local autosave.
 *
 * A receptionist mid-registration on a connection that drops for twenty seconds
 * must not lose the form, and a doctor mid-consultation must not lose the note.
 *
 * This is deliberately NOT offline-first. There is no local database and no
 * conflict-resolution algorithm — that approach roughly triples the cost and
 * its failure modes are genuinely dangerous in a clinical setting. What we do
 * instead: keep the work on the device, replay it in order when the connection
 * returns, and always tell the user what is still pending. Degrade gracefully;
 * never pretend.
 */

import { del, get, keys, set } from 'idb-keyval';
import { ApiError, api } from './api-client';

const DRAFT_PREFIX = 'draft:';
const OUTBOX_KEY = 'outbox:queue';

/* ------------------------------------------------------------------------- *
 * Drafts — the in-progress form on this device
 * ------------------------------------------------------------------------- */

export interface Draft<T> {
  value: T;
  savedAt: number;
}

export async function saveDraft<T>(id: string, value: T): Promise<void> {
  try {
    await set(`${DRAFT_PREFIX}${id}`, { value, savedAt: Date.now() } satisfies Draft<T>);
  } catch {
    // Private browsing or blocked site data. The form still works; it just
    // isn't recoverable after a reload, which is the honest outcome.
  }
}

export async function loadDraft<T>(id: string): Promise<Draft<T> | null> {
  try {
    return (await get<Draft<T>>(`${DRAFT_PREFIX}${id}`)) ?? null;
  } catch {
    return null;
  }
}

export async function clearDraft(id: string): Promise<void> {
  try {
    await del(`${DRAFT_PREFIX}${id}`);
  } catch {
    /* nothing to do */
  }
}

export async function listDraftIds(): Promise<string[]> {
  try {
    const all = await keys();
    return all
      .filter((k): k is string => typeof k === 'string' && k.startsWith(DRAFT_PREFIX))
      .map((k) => k.slice(DRAFT_PREFIX.length));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------------- *
 * Outbox — mutations waiting for a connection
 * ------------------------------------------------------------------------- */

export interface OutboxEntry {
  id: string;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body: unknown;
  /** Carried so a replay cannot apply the same operation twice. */
  idempotencyKey: string;
  version?: number;
  /** What the user sees in the pending list, e.g. "Vitals for Sunita Devi". */
  label: string;
  queuedAt: number;
  attempts: number;
  lastError?: string;
}

type Listener = (entries: OutboxEntry[]) => void;
const listeners = new Set<Listener>();

async function readQueue(): Promise<OutboxEntry[]> {
  try {
    return (await get<OutboxEntry[]>(OUTBOX_KEY)) ?? [];
  } catch {
    return [];
  }
}

async function writeQueue(entries: OutboxEntry[]): Promise<void> {
  try {
    await set(OUTBOX_KEY, entries);
  } catch {
    /* nothing more we can do */
  }
  for (const listener of listeners) listener(entries);
}

export function subscribeToOutbox(listener: Listener): () => void {
  listeners.add(listener);
  void readQueue().then(listener);
  return () => listeners.delete(listener);
}

export async function enqueue(
  entry: Omit<OutboxEntry, 'id' | 'queuedAt' | 'attempts'>,
): Promise<void> {
  const queue = await readQueue();
  queue.push({
    ...entry,
    id: globalThis.crypto.randomUUID(),
    queuedAt: Date.now(),
    attempts: 0,
  });
  await writeQueue(queue);
}

export async function pendingCount(): Promise<number> {
  return (await readQueue()).length;
}

let flushing = false;

/**
 * Replays the queue oldest-first, stopping at the first entry that cannot go
 * through. Order matters: an encounter must be created before its prescription,
 * so a failure blocks rather than skips.
 *
 * A rejection the server will never accept — a validation failure, a permission
 * denial — is dropped from the queue and surfaced, because retrying it forever
 * would jam everything behind it.
 */
export async function flushOutbox(): Promise<{ sent: number; failed: number }> {
  if (flushing) return { sent: 0, failed: 0 };
  flushing = true;

  try {
    let queue = await readQueue();
    let sent = 0;
    let failed = 0;

    while (queue.length > 0) {
      const entry = queue[0];
      if (!entry) break;

      try {
        const options = {
          idempotencyKey: entry.idempotencyKey,
          version: entry.version,
        };
        if (entry.method === 'DELETE') {
          await api.delete(entry.path, options);
        } else {
          const send = api[entry.method.toLowerCase() as 'post' | 'patch' | 'put'];
          await send(entry.path, entry.body, options);
        }
        queue = queue.slice(1);
        sent += 1;
        await writeQueue(queue);
      } catch (error) {
        const apiError = error instanceof ApiError ? error : null;

        if (apiError && !apiError.isTransient) {
          // Permanently rejected. Drop it so it cannot block the queue, and
          // keep the reason for the pending-changes panel.
          queue = queue.slice(1);
          failed += 1;
          await writeQueue(queue);
          reportPermanentFailure(entry, apiError);
          continue;
        }

        // Still offline, or the server is unwell. Leave it in place.
        entry.attempts += 1;
        entry.lastError = apiError?.message ?? 'Could not reach the server';
        await writeQueue(queue);
        break;
      }
    }

    return { sent, failed };
  } finally {
    flushing = false;
  }
}

const failureListeners = new Set<(entry: OutboxEntry, error: ApiError) => void>();

export function onPermanentFailure(
  listener: (entry: OutboxEntry, error: ApiError) => void,
): () => void {
  failureListeners.add(listener);
  return () => failureListeners.delete(listener);
}

function reportPermanentFailure(entry: OutboxEntry, error: ApiError): void {
  for (const listener of failureListeners) listener(entry, error);
}

export async function discardEntry(id: string): Promise<void> {
  const queue = await readQueue();
  await writeQueue(queue.filter((e) => e.id !== id));
}

/** Flush on reconnect, and once on load in case the tab was closed offline. */
export function startOutboxWorker(): () => void {
  const onOnline = () => void flushOutbox();
  globalThis.addEventListener('online', onOnline);
  if (navigator.onLine) void flushOutbox();

  // A slow-but-present connection still drops requests, so retry periodically
  // rather than waiting only for the online event.
  const timer = globalThis.setInterval(() => {
    if (navigator.onLine) void flushOutbox();
  }, 30_000);

  return () => {
    globalThis.removeEventListener('online', onOnline);
    globalThis.clearInterval(timer);
  };
}
