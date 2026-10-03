'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  EnterLabResult,
  LabOrder,
  LabResult,
  LabReviewSummary,
  LabTestCatalogueItem,
  OrderLabTest,
} from '@emr/contracts';
import { api } from '@/lib/api-client';
import { useServerEvents, type ServerEvent } from '@/lib/server-events';

/**
 * Lab orders and results.
 *
 * Everything here invalidates the whole `lab` namespace on a write, because a
 * single result changes the order, the review summary, the patient's list and
 * the awaiting list at once — and working out which of those a given write
 * touched would be more code and more wrong.
 */

export const lk = {
  tests: (term: string) => ['lab', 'tests', term] as const,
  orders: (patientId?: string, awaiting?: boolean) =>
    ['lab', 'orders', patientId ?? 'all', awaiting ?? false] as const,
  order: (id: string) => ['lab', 'orders', id] as const,
  history: (id: string) => ['lab', 'orders', id, 'history'] as const,
  summary: ['lab', 'review-summary'] as const,
};

function useInvalidateLab() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: ['lab'] });
}

export function useLabTestSearch(term: string, enabled = true) {
  const trimmed = term.trim();
  return useQuery({
    queryKey: lk.tests(trimmed),
    queryFn: () =>
      api.get<{ items: LabTestCatalogueItem[] }>('/lab/tests/search', {
        query: { q: trimmed },
      }),
    enabled,
    select: (data) => data.items,
    staleTime: 60_000,
  });
}

export function useLabOrders(options: { patientId?: string; awaiting?: boolean } = {}) {
  return useQuery({
    queryKey: lk.orders(options.patientId, options.awaiting),
    queryFn: () =>
      api.get<{ items: LabOrder[] }>('/lab/orders', {
        query: {
          patientId: options.patientId ?? null,
          awaiting: options.awaiting ? 'true' : null,
        },
      }),
    select: (data) => data.items,
  });
}

export function useLabResultHistory(orderId: string | null) {
  return useQuery({
    queryKey: lk.history(orderId ?? ''),
    queryFn: () => api.get<{ items: LabResult[] }>(`/lab/orders/${orderId}/history`),
    enabled: Boolean(orderId),
    select: (data) => data.items,
  });
}

/**
 * The counts behind the doctor's "results to review" card.
 *
 * Polled as well as pushed. An unread critical result is the one thing in this
 * product where a stale screen has a clinical cost, so the poll is the floor
 * under the live stream rather than an optimisation.
 */
export function useLabReviewSummary(enabled = true) {
  return useQuery({
    queryKey: lk.summary,
    queryFn: () => api.get<LabReviewSummary>('/lab/review-summary'),
    enabled,
    refetchInterval: 120_000,
    staleTime: 30_000,
  });
}

export function useOrderLabTest() {
  const invalidate = useInvalidateLab();
  return useMutation({
    mutationFn: (input: OrderLabTest) => api.post<LabOrder>('/lab/orders', input),
    onSuccess: invalidate,
  });
}

export function useEnterLabResult() {
  const invalidate = useInvalidateLab();
  return useMutation({
    mutationFn: ({ orderId, ...input }: EnterLabResult & { orderId: string }) =>
      api.post<LabOrder>(`/lab/orders/${orderId}/result`, input),
    onSuccess: invalidate,
  });
}

export function useReviewLabResult() {
  const invalidate = useInvalidateLab();
  return useMutation({
    mutationFn: (orderId: string) => api.post<LabOrder>(`/lab/orders/${orderId}/review`, {}),
    onSuccess: invalidate,
  });
}

export function useCancelLabOrder() {
  const invalidate = useInvalidateLab();
  return useMutation({
    mutationFn: ({ orderId, reason }: { orderId: string; reason: string }) =>
      api.post<LabOrder>(`/lab/orders/${orderId}/cancel`, { reason }),
    onSuccess: invalidate,
  });
}

/** Keeps the lab screens current when a result is entered elsewhere. */
export function useLabLiveUpdates(): void {
  const queryClient = useQueryClient();
  const onEvent = React.useCallback(
    (event: ServerEvent) => {
      if (event.type !== 'lab-changed') return;
      void queryClient.invalidateQueries({ queryKey: ['lab'] });
    },
    [queryClient],
  );
  useServerEvents(onEvent);
}
