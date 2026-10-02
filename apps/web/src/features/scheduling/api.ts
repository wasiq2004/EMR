'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DaySchedule,
  PractitionerSchedule,
  SaveSchedule,
  SaveScheduleException,
  ScheduleException,
} from '@emr/contracts';
import { api } from '@/lib/api-client';

/**
 * Availability and the calendar.
 *
 * Slots are derived server-side on every read, so there is nothing to invalidate
 * when a pattern changes except the slot queries themselves — which is why every
 * mutation here drops the whole `scheduling` namespace rather than reasoning about
 * which days a change touched. An edit to a Monday session can change a slot three
 * weeks out, and working out which ones would be more code and more wrong.
 */

export const sk = {
  schedules: (practitionerId?: string) =>
    ['scheduling', 'schedules', practitionerId ?? 'all'] as const,
  exceptions: (from: string, to: string) =>
    ['scheduling', 'exceptions', from, to] as const,
  slots: (from: string, to: string, practitionerId?: string, locationId?: string) =>
    ['scheduling', 'slots', from, to, practitionerId ?? '', locationId ?? ''] as const,
};

function useInvalidateScheduling() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['scheduling'] });
    // The appointment list and the queue both show what the calendar shows.
    void queryClient.invalidateQueries({ queryKey: ['appointments'] });
    void queryClient.invalidateQueries({ queryKey: ['queue'] });
  };
}

/* ---- The recurring pattern ----------------------------------------------- */

export function useSchedules(practitionerId?: string) {
  return useQuery({
    queryKey: sk.schedules(practitionerId),
    queryFn: () =>
      api.get<{ items: PractitionerSchedule[] }>('/availability/schedules', {
        query: practitionerId ? { practitionerId } : {},
      }),
    select: (data) => data.items,
  });
}

export function useSaveSchedule() {
  const invalidate = useInvalidateScheduling();
  return useMutation({
    mutationFn: (input: SaveSchedule & { id?: string }) =>
      api.post('/availability/schedules', input),
    onSuccess: invalidate,
  });
}

export function useRemoveSchedule() {
  const invalidate = useInvalidateScheduling();
  return useMutation({
    mutationFn: (id: string) => api.post(`/availability/schedules/${id}/remove`, {}),
    onSuccess: invalidate,
  });
}

/* ---- Leave, holidays and extra sessions ---------------------------------- */

export function useScheduleExceptions(from: string, to: string) {
  return useQuery({
    queryKey: sk.exceptions(from, to),
    queryFn: () =>
      api.get<{ items: ScheduleException[] }>('/availability/exceptions', {
        query: { from, to },
      }),
    select: (data) => data.items,
  });
}

export function useSaveException() {
  const invalidate = useInvalidateScheduling();
  return useMutation({
    mutationFn: (input: SaveScheduleException & { id?: string }) =>
      api.post('/availability/exceptions', input),
    onSuccess: invalidate,
  });
}

export function useRemoveException() {
  const invalidate = useInvalidateScheduling();
  return useMutation({
    mutationFn: (id: string) => api.post(`/availability/exceptions/${id}/remove`, {}),
    onSuccess: invalidate,
  });
}

/* ---- Derived slots -------------------------------------------------------- */

/**
 * Bookable slots for a range.
 *
 * `to` is EXCLUSIVE, matching the server. A day view asks for one date and the
 * next; a week asks for Monday and the following Monday. Half-open ranges avoid
 * the off-by-one that an inclusive end invites every time somebody adds a view.
 */
export function useSlots(
  from: string,
  to: string,
  options: { practitionerId?: string; locationId?: string; enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: sk.slots(from, to, options.practitionerId, options.locationId),
    queryFn: () =>
      api.get<DaySchedule[]>('/availability/slots', {
        query: {
          from,
          to,
          ...(options.practitionerId ? { practitionerId: options.practitionerId } : {}),
          ...(options.locationId ? { locationId: options.locationId } : {}),
        },
      }),
    enabled: options.enabled ?? true,
    // A slot taken at the front desk should disappear from the doctor's calendar
    // without a refresh. SSE pushes the change; this is the floor under it.
    refetchInterval: 60_000,
    staleTime: 15_000,
  });
}
