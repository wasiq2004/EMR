'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Allergy,
  DuplicateCheckResult,
  Encounter,
  Patient,
  PatientSnapshot,
  PatientSummary,
} from '@emr/contracts';
import { api, idempotencyKey } from '@/lib/api-client';
import { qk } from '@/lib/query-client';

export function usePatients(search: string) {
  return useQuery({
    queryKey: qk.patients(search),
    queryFn: () =>
      api.get<{ items: PatientSummary[]; total: number }>('/patients', {
        query: { q: search },
      }),
    staleTime: 15_000,
  });
}

export function usePatient(id: string) {
  return useQuery({
    queryKey: qk.patient(id),
    queryFn: () => api.get<Patient>(`/patients/${id}`),
  });
}

/**
 * The Snapshot.
 *
 * One aggregate request rather than six, because the budget is a full render in
 * under a second — below that doctors stop opening it, and the allergy lives
 * here.
 */
export function usePatientSnapshot(id: string) {
  return useQuery({
    queryKey: qk.snapshot(id),
    queryFn: () => api.get<PatientSnapshot>(`/patients/${id}/snapshot`),
    staleTime: 10_000,
  });
}

export function usePatientVisits(id: string) {
  return useQuery({
    queryKey: qk.patientVisits(id),
    queryFn: () => api.get<Encounter[]>(`/patients/${id}/visits`),
  });
}

/**
 * Search before create.
 *
 * Returns everyone already registered on the number, plus fuzzy matches
 * elsewhere, and issues the token the registration form has to present. The
 * server rejects a registration without it, so this is a workflow rule rather
 * than a UI convention.
 */
export function useDuplicateCheck(mobile: string, name: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.duplicateCheck(mobile, name),
    queryFn: () =>
      api.get<DuplicateCheckResult>('/patients/duplicates', {
        query: { mobile, name },
      }),
    enabled,
    staleTime: 0,
    gcTime: 60_000,
  });
}

export function useRegisterPatient() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      api.post<Patient>('/patients', input, { idempotencyKey: idempotencyKey() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['patients'] });
    },
  });
}

export function useUpdatePatient(id: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Record<string, unknown> & { version: number }) =>
      api.patch<Patient>(`/patients/${id}`, input, { version: input.version }),
    onSuccess: (patient) => {
      queryClient.setQueryData(qk.patient(id), patient);
      void queryClient.invalidateQueries({ queryKey: qk.snapshot(id) });
      void queryClient.invalidateQueries({ queryKey: ['patients'] });
    },
  });
}

export function useAllergies(patientId: string) {
  return useQuery({
    queryKey: ['patients', patientId, 'allergies'],
    queryFn: () => api.get<Allergy[]>(`/patients/${patientId}/allergies`),
  });
}

export function useRecordAllergy(patientId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      api.post<Allergy>(`/patients/${patientId}/allergies`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.snapshot(patientId) });
      void queryClient.invalidateQueries({
        queryKey: ['patients', patientId, 'allergies'],
      });
      void queryClient.invalidateQueries({ queryKey: ['patients'] });
    },
  });
}

export function useRecordObservation(patientId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.post('/observations', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.snapshot(patientId) });
    },
  });
}
