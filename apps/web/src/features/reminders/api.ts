'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ReminderSettings,
  SaveReminderSettings,
  ScheduledReminder,
} from '@emr/contracts';
import { api } from '@/lib/api-client';

/**
 * Follow-up reminders: the settings, and the log of what went out.
 *
 * There is no "send now" here, deliberately. Reminders go out when they are due,
 * and the endpoint that sends them is authenticated with a deployment secret for
 * a cron line — not something a clinic screen can trigger. A button that made
 * reminders fire early would be a button somebody presses to test, and the test
 * would reach a real patient.
 */

export const rk = {
  settings: ['reminders', 'settings'] as const,
  log: (patientId?: string) => ['reminders', 'log', patientId ?? 'all'] as const,
};

export function useReminderSettings() {
  return useQuery({
    queryKey: rk.settings,
    queryFn: () => api.get<ReminderSettings>('/settings/reminders'),
  });
}

export function useSaveReminderSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: SaveReminderSettings) =>
      api.post<ReminderSettings>('/settings/reminders', patch),
    onSuccess: (saved) => {
      // Seeded from the response rather than refetched: the server merges the
      // patch and returns the whole set, so this is already the truth.
      queryClient.setQueryData(rk.settings, saved);
    },
  });
}

export function useReminderLog(patientId?: string) {
  return useQuery({
    queryKey: rk.log(patientId),
    queryFn: () =>
      api.get<{ items: ScheduledReminder[] }>('/reminders', {
        query: patientId ? { patientId } : {},
      }),
    select: (data) => data.items,
  });
}

export function useCancelReminder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/reminders/${id}/cancel`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['reminders'] });
    },
  });
}
