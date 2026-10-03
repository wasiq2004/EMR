'use client';

import { useQuery } from '@tanstack/react-query';
import type { AnalyticsExport, ClinicAnalytics } from '@emr/contracts';
import { api } from '@/lib/api-client';

/**
 * Clinic analytics.
 *
 * One request per filter set, because the breakdowns and the totals have to
 * agree — they are counted over the same rows in one read-only transaction, and
 * splitting them into separate calls would let a payment land between two of
 * them and produce a page whose parts contradict each other.
 */

export interface AnalyticsQuery {
  from: string;
  to: string;
  practitionerId?: string;
  locationId?: string;
  serviceItemId?: string;
  paymentMethod?: string;
}

export const ak = {
  analytics: (q: AnalyticsQuery) =>
    [
      'analytics',
      q.from,
      q.to,
      q.practitionerId ?? '',
      q.locationId ?? '',
      q.serviceItemId ?? '',
      q.paymentMethod ?? '',
    ] as const,
};

function queryFor(q: AnalyticsQuery) {
  return {
    from: q.from,
    to: q.to,
    practitionerId: q.practitionerId ?? null,
    locationId: q.locationId ?? null,
    serviceItemId: q.serviceItemId ?? null,
    paymentMethod: q.paymentMethod ?? null,
  };
}

export function useClinicAnalytics(q: AnalyticsQuery, enabled = true) {
  return useQuery({
    queryKey: ak.analytics(q),
    queryFn: () => api.get<ClinicAnalytics>('/reports/analytics', { query: queryFor(q) }),
    enabled,
    // These are management figures, not a live feed. A stale-time that keeps the
    // page still while somebody reads it is better than one that re-renders the
    // table under their cursor.
    staleTime: 60_000,
  });
}

/**
 * The CSV endpoint's URL.
 *
 * Returned as a link rather than fetched and turned into a Blob, deliberately.
 * The server sets `content-disposition`, so the browser saves it with the right
 * filename and shows its own download progress; fetching it into memory first
 * would lose both and put a multi-megabyte string on the heap for no reason.
 */
export function analyticsExportUrl(view: AnalyticsExport, q: AnalyticsQuery): string {
  const params = new URLSearchParams({ view, from: q.from, to: q.to });
  for (const [key, value] of Object.entries(queryFor(q))) {
    if (value && key !== 'from' && key !== 'to') params.set(key, String(value));
  }
  return `/api/reports/analytics/export?${params.toString()}`;
}
