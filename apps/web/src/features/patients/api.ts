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
import { api } from '@/lib/api-client';
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

/**
 * `enabled` is not optional here.
 *
 * Several screens derive the patient id from a record that is still loading —
 * the consultation screen reads it from the encounter. Without this guard the
 * hook fires `/patients/` with an empty id, which is a wasted request at best
 * and, depending on how the server treats the trailing slash, a fetch of the
 * entire patient registry at worst.
 */
export function usePatient(id: string) {
  return useQuery({
    queryKey: qk.patient(id),
    queryFn: () => api.get<Patient>(`/patients/${id}`),
    enabled: Boolean(id),
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
    enabled: Boolean(id),
  });
}

export function usePatientVisits(id: string) {
  return useQuery({
    queryKey: qk.patientVisits(id),
    queryFn: () => api.get<Encounter[]>(`/patients/${id}/visits`),
    enabled: Boolean(id),
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

/**
 * Registers a patient.
 *
 * THE KEY IS A BODY FIELD AND THE CALLER HOLDS IT — see `useAddWalkIn` for why a
 * key minted inside a `mutationFn` protects nothing. The form passes
 * `idempotencyKey` with the rest of the fields.
 *
 * What the key adds here is mostly a better answer rather than a new guarantee:
 * the search token is single-use, so a second identical submit was already
 * refused. It was refused with "search for the patient before creating a new
 * record" — to a receptionist who had just searched, and who still could not
 * tell whether the first attempt had worked. Now the retry returns the patient.
 */
export function useRegisterPatient() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Record<string, unknown>) => api.post<Patient>('/patients', input),
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
    enabled: Boolean(patientId),
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
