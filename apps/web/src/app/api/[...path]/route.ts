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
 * When API_BASE_URL is unset the mock handlers answer instead, so the frontend
 * can be run and demonstrated before the API service exists.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { handleMock } from '@/mocks/handlers';

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
    const parsed = bodyText ? safeJson(bodyText) : undefined;
    const result = await handleMock(
      request.method,
      `/${suffix}`,
      url.searchParams,
      parsed,
    );
    if (result.status === 204) return new NextResponse(null, { status: 204 });
    return NextResponse.json(result.body, { status: result.status });
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
  });

  const response = new NextResponse(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
  });

  // Pass through the content type, the correlation id and any session cookie
  // the API rotated. Nothing else crosses back.
  for (const key of ['content-type', 'x-request-id']) {
    const value = upstream.headers.get(key);
    if (value) response.headers.set(key, value);
  }
  const setCookie = upstream.headers.getSetCookie?.() ?? [];
  for (const cookie of setCookie) response.headers.append('set-cookie', cookie);

  return response;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
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
