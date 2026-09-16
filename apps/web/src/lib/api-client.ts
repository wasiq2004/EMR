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
  /** Required for any request that dispatches or charges. */
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

async function request<T>(
  method: string,
  path: string,
  body: unknown,
  options: RequestOptions = {},
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

/** Stable key for an operation that must not be applied twice. */
export function idempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}
