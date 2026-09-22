/**
 * The BFF.
 *
 * This is the only thing the browser talks to. Its entire job is to attach the
 * httpOnly session cookie and forward the request to the NestJS API, which is
 * what allows that service to live in a private subnet with no public route.
 *
 * There is deliberately NO business logic here. The web tier does not hold a
 * database connection, does not evaluate permissions and does not write audit
 * rows — all three live behind the API's global guards, where they can be
 * verified from one place rather than by reading every route.
 *
 * API_BASE_URL is REQUIRED. There was once a mock implementation here that
 * answered when it was unset, and it had to go: a second implementation of every
 * endpoint drifts from the first, and it drifts silently, because the screens go
 * on working. The prescribing safety check is the cautionary tale — it ran in
 * the browser, the server stored whatever the browser sent, and the whole thing
 * looked correct from the outside for as long as nobody asked the server to
 * check anything itself.
 *
 * `docker compose up` brings up the real API and the real database, so there is
 * nothing a mock would buy.
 */

import { NextResponse, type NextRequest } from 'next/server';

const API_BASE_URL = process.env.API_BASE_URL;

/** Headers we refuse to pass upstream, whatever the client sends. */
const BLOCKED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  // The tenant is read from the verified token by the API, never from a header.
  // Forwarding these would hand a client a way to suggest a clinic id.
  'x-clinic-id',
  'x-tenant-id',
  'x-user-id',
  'x-role',
]);

async function forward(request: NextRequest, path: string[]): Promise<Response> {
  const url = new URL(request.url);
  const suffix = path.join('/');
  const bodyText =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await request.text();

  if (!API_BASE_URL) {
    // Refuse loudly. Returning empty data would make a misconfigured deployment
    // look like a clinic with no patients.
    return NextResponse.json(
      {
        type: 'about:blank',
        title: 'This deployment is not configured',
        status: 503,
        detail: 'API_BASE_URL is not set, so there is no API to talk to.',
      },
      { status: 503, headers: { 'content-type': 'application/problem+json' } },
    );
  }

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!BLOCKED_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });

  const upstream = await fetch(`${API_BASE_URL}/v1/${suffix}${url.search}`, {
    method: request.method,
    headers,
    body: bodyText,
    redirect: 'manual',
    cache: 'no-store',
    /*
     * Tie the upstream request to the browser's.
     *
     * Matters most for the event stream, which is held open for hours: without
     * this, closing a tab leaves the API writing into a socket nobody is
     * reading, and every reload adds another. A clinic that leaves the inbox
     * open all day accumulates one dead stream per refresh until the API runs
     * out of connections.
     */
    signal: request.signal,
  });

  const response = new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
  });

  /*
   * Pass through the content type, the correlation id, the cache directives and
   * any session cookie the API rotated. Nothing else crosses back.
   *
   * cache-control and x-accel-buffering are here for the event stream. Dropping
   * them lets an intermediary buffer the response, which holds every event
   * until the buffer fills — so a live feed arrives in silent bursts minutes
   * apart and looks exactly like a broken feature rather than a proxy setting.
   */
  for (const key of ['content-type', 'x-request-id', 'cache-control', 'x-accel-buffering']) {
    const value = upstream.headers.get(key);
    if (value) response.headers.set(key, value);
  }
  const setCookie = upstream.headers.getSetCookie?.() ?? [];
  for (const cookie of setCookie) response.headers.append('set-cookie', cookie);

  return response;
}

type Context = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, context: Context) {
  return forward(request, (await context.params).path);
}
export async function POST(request: NextRequest, context: Context) {
  return forward(request, (await context.params).path);
}
export async function PATCH(request: NextRequest, context: Context) {
  return forward(request, (await context.params).path);
}
export async function PUT(request: NextRequest, context: Context) {
  return forward(request, (await context.params).path);
}
export async function DELETE(request: NextRequest, context: Context) {
  return forward(request, (await context.params).path);
}

// Clinical data is never cached at the edge or rendered statically.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
