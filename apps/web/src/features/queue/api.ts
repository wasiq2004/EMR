'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Appointment, QueueEntry } from '@emr/contracts';
import { api, idempotencyKey } from '@/lib/api-client';
import { qk } from '@/lib/query-client';

export interface QueueResponse {
  waiting: QueueEntry[];
  completed: QueueEntry[];
}

/**
 * The live queue.
 *
 * Polled rather than pushed: the budget is a refresh under 100ms and the screen
 * is watched by two people at once, so a short poll is simpler and more
 * predictable than a socket that has to be reconnected on every dropout. The
 * endpoint is exempt from audit logging precisely because it is polled.
 */
export function useQueue() {
  return useQuery({
    queryKey: qk.queue(),
    queryFn: () => api.get<QueueResponse>('/queue'),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    staleTime: 2_000,
  });
}

export function useAddWalkIn() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      patientId: string;
      practitionerId?: string | null;
      reasonText?: string | null;
    }) => api.post<Appointment>('/queue', input, { idempotencyKey: idempotencyKey() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.queue() });
      void queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
    },
  });
}

/**
 * Reordering is optimistic: the row moves the instant it is dragged, then
 * reconciles against the server. The front desk reorders constantly and a
 * half-second of lag on every drag makes the board feel broken.
 */
export function useReorderQueue() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { appointmentId: string; beforeAppointmentId: string | null }) =>
      api.patch(`/queue/${input.appointmentId}/position`, {
        beforeAppointmentId: input.beforeAppointmentId,
      }),

    async onMutate(input) {
      await queryClient.cancelQueries({ queryKey: qk.queue() });
      const previous = queryClient.getQueryData<QueueResponse>(qk.queue());
      if (!previous) return { previous };

      const waiting = [...previous.waiting];
      const from = waiting.findIndex((e) => e.appointment.id === input.appointmentId);
      if (from === -1) return { previous };

      const [moved] = waiting.splice(from, 1);
      if (!moved) return { previous };

      const to = input.beforeAppointmentId
        ? waiting.findIndex((e) => e.appointment.id === input.beforeAppointmentId)
        : waiting.length;
      waiting.splice(to === -1 ? waiting.length : to, 0, moved);

      queryClient.setQueryData<QueueResponse>(qk.queue(), { ...previous, waiting });
      return { previous };
    },

    onError(_error, _input, context) {
      // Put the board back exactly as it was. A reorder that silently fails is
      // worse than one that visibly snaps back.
      if (context?.previous) queryClient.setQueryData(qk.queue(), context.previous);
    },

    onSettled() {
      void queryClient.invalidateQueries({ queryKey: qk.queue() });
    },
  });
}

export function useChangeAppointmentStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      appointmentId: string;
      status: Appointment['status'];
      cancelledReason?: string | null;
    }) =>
      api.patch<Appointment>(`/appointments/${input.appointmentId}/status`, {
        status: input.status,
        cancelledReason: input.cancelledReason ?? null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.queue() });
      void queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
    },
  });
}

/** Opens a consultation, or resumes the draft if one is already open. */
export function useStartConsultation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { patientId: string; appointmentId?: string | null }) =>
      api.post<{ id: string }>('/encounters', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.queue() });
    },
  });
}
