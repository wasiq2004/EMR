'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

/**
 * The operations console's data layer.
 *
 * Separate from the clinic app's `features/*` on purpose: this is a different
 * session, a different cookie and a different backend role. Sharing hooks between
 * the two would invite someone to call a clinic endpoint from here, which would
 * fail — and it should be obvious from the import path why.
 *
 * One invalidation key for the whole namespace. Almost everything an operator does
 * changes what the other screens show: onboarding a clinic changes the overview,
 * retiring a plan changes the tenant list, and a feature toggle changes what the
 * clinic's own API will answer. Being precise about which query to drop would save
 * nothing measurable and get it wrong occasionally.
 */

export interface PlanRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  monthlyPricePaise: number;
  annualPricePaise: number | null;
  maxPractitioners: number | null;
  maxPatients: number | null;
  maxLocations: number | null;
  includedMessagesPerMonth: number | null;
  storageGb: number | null;
  features: Record<string, boolean>;
  isActive: boolean;
  isPrivate: boolean;
  trialDays: number;
  displayOrder: number;
  clinicsOnPlan: number;
  featureCount: number;
  featureTotal: number;
}

export interface OperatorRow {
  id: string;
  fullName: string;
  email: string;
  role: 'SUPPORT' | 'OPERATOR' | 'PLATFORM_ADMIN';
  isActive: boolean;
  lastLoginAt: string | null;
  failedLoginAttempts: number;
  lockedUntil: string | null;
  createdAt: string;
}

export interface SettingRow {
  key: string;
  label: string;
  description: string;
  type: 'number' | 'text' | 'boolean';
  value: unknown;
  isDefault: boolean;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  at: string;
  checks: { name: string; status: 'ok' | 'degraded' | 'down'; detail: string }[];
}

export const plk = {
  overview: () => ['platform', 'overview'] as const,
  tenants: () => ['platform', 'tenants'] as const,
  tenant: (id: string) => ['platform', 'tenant', id] as const,
  plans: () => ['platform', 'plans'] as const,
  operators: () => ['platform', 'operators'] as const,
  settings: () => ['platform', 'settings'] as const,
  health: () => ['platform', 'health'] as const,
};

function useInvalidatePlatform() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['platform'] });
  };
}

/* ---- Plans --------------------------------------------------------------- */

export function usePlans() {
  return useQuery({
    queryKey: plk.plans(),
    queryFn: () => api.get<{ items: PlanRow[] }>('/platform/plans'),
    select: (data) => data.items,
  });
}

export function useSavePlan() {
  const invalidate = useInvalidatePlatform();
  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.post('/platform/plans', input),
    onSuccess: invalidate,
  });
}

export function useRetirePlan() {
  const invalidate = useInvalidatePlatform();
  return useMutation({
    mutationFn: (id: string) => api.post(`/platform/plans/${id}/retire`, {}),
    onSuccess: invalidate,
  });
}

/* ---- Clinics ------------------------------------------------------------- */

/**
 * Onboards a clinic.
 *
 * Returns a one-time password for the first administrator, shown once and never
 * again — there is no mail provider, and saying so plainly beats pretending an
 * email was sent.
 */
export function useOnboardClinic() {
  const invalidate = useInvalidatePlatform();
  return useMutation({
    mutationFn: (input: {
      name: string;
      slug: string;
      adminName: string;
      adminEmail: string;
      planId?: string | null;
      city?: string | null;
      state?: string | null;
      contactEmail?: string | null;
      contactPhoneE164?: string | null;
    }) =>
      api.post<{
        clinicId: string;
        slug: string;
        temporaryPassword: string;
        /** False means no plan, so every optional module is off for this clinic. */
        planAssigned: boolean;
      }>(
        '/platform/tenants',
        input,
      ),
    onSuccess: invalidate,
  });
}

/** Rescues a locked-out clinic administrator. PLATFORM_ADMIN only. */
export function useResetClinicAdmin() {
  const invalidate = useInvalidatePlatform();
  return useMutation({
    mutationFn: ({
      clinicId,
      adminEmail,
      reason,
    }: {
      clinicId: string;
      adminEmail: string;
      reason: string;
    }) =>
      api.post<{ temporaryPassword: string }>(
        `/platform/tenants/${clinicId}/reset-admin-password`,
        { adminEmail, reason },
      ),
    onSuccess: invalidate,
  });
}

export function useSetFeatures() {
  const invalidate = useInvalidatePlatform();
  return useMutation({
    mutationFn: ({
      clinicId,
      features,
      reason,
    }: {
      clinicId: string;
      features: Record<string, boolean>;
      reason: string;
    }) => api.post(`/platform/tenants/${clinicId}/features`, { features, reason }),
    onSuccess: invalidate,
  });
}

/* ---- Operators ----------------------------------------------------------- */

export function useOperators() {
  return useQuery({
    queryKey: plk.operators(),
    queryFn: () => api.get<{ items: OperatorRow[] }>('/platform/operators'),
    select: (data) => data.items,
  });
}

export function useCreateOperator() {
  const invalidate = useInvalidatePlatform();
  return useMutation({
    mutationFn: (input: { fullName: string; email: string; role: string }) =>
      api.post<{ id: string; temporaryPassword: string }>('/platform/operators', input),
    onSuccess: invalidate,
  });
}

export function useUpdateOperator() {
  const invalidate = useInvalidatePlatform();
  return useMutation({
    mutationFn: ({
      id,
      role,
      isActive,
    }: {
      id: string;
      role?: string;
      isActive?: boolean;
    }) => api.post(`/platform/operators/${id}`, { role, isActive }),
    onSuccess: invalidate,
  });
}

export function useResetOperatorPassword() {
  const invalidate = useInvalidatePlatform();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ temporaryPassword: string }>(`/platform/operators/${id}/reset-password`, {}),
    onSuccess: invalidate,
  });
}

/* ---- Settings and health ------------------------------------------------- */

export function usePlatformSettings() {
  return useQuery({
    queryKey: plk.settings(),
    queryFn: () => api.get<{ items: SettingRow[] }>('/platform/settings'),
    select: (data) => data.items,
  });
}

export function useSaveSetting() {
  const invalidate = useInvalidatePlatform();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) =>
      api.post('/platform/settings', { key, value }),
    onSuccess: invalidate,
  });
}

export function usePlatformHealth() {
  return useQuery({
    queryKey: plk.health(),
    queryFn: () => api.get<HealthReport>('/platform/health'),
    // An operator leaves this open. A minute is often enough to notice a problem
    // before the first support call about it.
    refetchInterval: 60_000,
  });
}

export function useAggregateUsage() {
  const invalidate = useInvalidatePlatform();
  return useMutation({
    mutationFn: () => api.post<{ clinics: number }>('/platform/usage/aggregate', {}),
    onSuccess: invalidate,
  });
}
