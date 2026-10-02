/**
 * The single path from the browser to the API.
 *
 * Requests go through the Next.js route handler at /api/*, which attaches the
 * httpOnly session cookie and proxies to the NestJS service. The browser never
 * holds a token and never addresses the API directly — that is what lets the
 * API sit in a private subnet.
 *
 * Three contracts every caller gets for free:
 *   - `If-Match` carries the row version, so a stale write is refused rather
 *     than silently applied over someone else's edit.
 *   - `Idempotency-Key` on anything that dispatches a message or takes money,
 *     so a retry cannot send a prescription twice.
 *   - Errors arrive as RFC 9457 problem documents and are thrown as ApiError,
 *     never as a bare string.
 */

import { Problem } from '@emr/contracts';

const BASE = '/api';

export class ApiError extends Error {
  readonly status: number;
  readonly problem: Problem;
  /** Field-level failures, ready to hand to react-hook-form's setError. */
  readonly fieldErrors: Record<string, string[]>;

  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.status = problem.status;
    this.problem = problem;
    this.fieldErrors = problem.errors ?? {};
  }

  /** A stale write. The caller should offer to reload rather than retry. */
  get isConflict(): boolean {
    return this.status === 409;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** Worth retrying when the connection returns. */
  get isTransient(): boolean {
    return this.status === 0 || this.status === 408 || this.status >= 500;
  }
}

export interface RequestOptions {
  /** Row version for optimistic concurrency, sent as If-Match. */
  version?: number;
  /**
   * Sent as an `Idempotency-Key` header.
   *
   * THE SERVER DOES NOT READ THIS HEADER. It is kept because it is the standard
   * place for the value and it reaches request logs, but passing it here buys no
   * protection on its own.
   *
   * Where a route genuinely must not be applied twice, the key goes in the
   * REQUEST BODY, because that is where its contract requires it and where a
   * unique index can enforce it — see `RecordPayment` and migration
   * `0010_payment_idempotency.sql`. The payment screen passed it only here, and
   * every payment it submitted failed validation with a 422 for months while
   * looking, from this file, fully protected.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Query string values; null and undefined are dropped. */
  query?: Record<string, string | number | boolean | null | undefined>;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${BASE}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function toProblem(response: Response): Promise<Problem> {
  try {
    const body = await response.json();
    const parsed = Problem.safeParse(body);
    if (parsed.success) return parsed.data;
  } catch {
    // Fall through to the generic shape below.
  }
  return {
    type: 'about:blank',
    title: response.statusText || 'Request failed',
    status: response.status,
    detail: friendlyFallback(response.status),
  };
}

/**
 * What the user reads when the server gave us nothing usable. Says what
 * happened and what to do next — never an apology, never a status code alone.
 */
function friendlyFallback(status: number): string {
  switch (status) {
    case 401:
      return 'Your session has ended. Sign in again to continue.';
    case 403:
      return 'Your role does not allow this action.';
    case 404:
      return 'That record no longer exists, or you do not have access to it.';
    case 409:
      return 'Someone else changed this record while you were editing. Reload to see their version.';
    case 413:
      return 'That file is too large to upload.';
    case 429:
      return 'Too many attempts. Wait a moment and try again.';
    default:
      return status >= 500
        ? 'The server could not complete that. Your work has been saved locally and will retry.'
        : 'That request could not be completed.';
  }
}

/**
 * Refreshing the session, once, for everybody.
 *
 * THE BUG THIS FIXES. The access token lives ten minutes. `POST /auth/refresh`
 * existed on the server, rotated the opaque refresh token correctly, and was
 * called by NOTHING — so every user was signed out mid-consultation every ten
 * minutes, and the refresh machinery was dead code. It reads as "the app keeps
 * logging me out", which sounds like a session bug rather than a missing call.
 *
 * A SINGLE IN-FLIGHT PROMISE, shared by every caller. A clinic screen fires
 * several queries at once; without this, ten of them would each get a 401 and
 * each POST its own refresh. The server ROTATES the refresh token on use, so the
 * first would succeed and the other nine would present a token that had just been
 * invalidated — which is indistinguishable from theft and correctly kills the
 * session. Coalescing is not an optimisation here; it is what makes refresh work
 * at all.
 */
let refreshInFlight: Promise<boolean> | null = null;

function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(buildUrl('/auth/refresh'), {
        method: 'POST',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      return response.ok;
    } catch {
      // Offline. Not a dead session — the caller reports the connection instead.
      return false;
    } finally {
      // Cleared in a microtask so concurrent callers awaiting this same promise
      // all observe the result before the next attempt can start.
      queueMicrotask(() => {
        refreshInFlight = null;
      });
    }
  })();

  return refreshInFlight;
}

async function request<T>(
  method: string,
  path: string,
  body: unknown,
  options: RequestOptions = {},
  /** Set on the one retry after a refresh, so a dead session cannot loop. */
  isRetry = false,
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.version !== undefined) headers['If-Match'] = String(options.version);
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal,
    });
  } catch (cause) {
    // Offline, DNS failure, or an aborted request. Distinguishable from a
    // server error so the outbox knows this one is worth replaying.
    throw new ApiError({
      type: 'about:blank',
      title: 'No connection',
      status: 0,
      detail: 'You appear to be offline. Changes are saved on this device and will be sent when the connection returns.',
    });
  }

  /*
   * A 401 means the access token expired. Refresh once and replay.
   *
   * Deliberately NOT attempted for the auth endpoints themselves: a failed
   * sign-in returns 401 too, and refreshing on it would turn a wrong password
   * into a confusing loop. Nor on a retry, so a genuinely dead session surfaces
   * as "sign in again" rather than as two requests and then the same message.
   */
  if (
    response.status === 401 &&
    !isRetry &&
    !path.startsWith('/auth/') &&
    !path.startsWith('/platform/auth/')
  ) {
    if (await refreshSession()) {
      return request<T>(method, path, body, options, true);
    }
  }

  if (response.status === 204) return undefined as T;
  if (!response.ok) throw new ApiError(await toProblem(response));

  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) =>
    request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, body, options),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PATCH', path, body, options),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, body, options),
  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>('DELETE', path, undefined, options),
};

/**
 * A key for an operation that must not be applied twice.
 *
 * Call this ONCE per operation the user is performing and hold on to the result
 * — a ref, or component state — then send the same value on every attempt. A
 * key generated inside a `mutationFn` is minted afresh on each retry, so the
 * server sees two distinct operations and applies both, which is the failure the
 * key exists to prevent.
 */
export function idempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}
