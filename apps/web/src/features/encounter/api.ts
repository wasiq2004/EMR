'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConsultationMode,
  Encounter,
  EncounterDraft,
  InternalNote,
  MedicationRequest,
} from '@emr/contracts';
import { ApiError, api, idempotencyKey } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { clearDraft, enqueue, loadDraft, saveDraft } from '@/lib/outbox';

export function useEncounter(id: string) {
  return useQuery({
    queryKey: qk.encounter(id),
    queryFn: () => api.get<Encounter>(`/encounters/${id}`),
  });
}

export function usePrescriptionLines(encounterId: string) {
  return useQuery({
    queryKey: qk.prescriptions(encounterId),
    queryFn: () => api.get<MedicationRequest[]>(`/encounters/${encounterId}/prescriptions`),
  });
}

export function useAddPrescriptionLine(encounterId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      api.post<MedicationRequest>(`/encounters/${encounterId}/prescriptions`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.prescriptions(encounterId) });
    },
  });
}

export function useRemovePrescriptionLine(encounterId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (lineId: string) => api.delete(`/prescriptions/${lineId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.prescriptions(encounterId) });
    },
  });
}

export function useInternalNotes(encounterId: string) {
  return useQuery({
    queryKey: qk.encounterNotes(encounterId),
    queryFn: () => api.get<InternalNote[]>(`/encounters/${encounterId}/internal-notes`),
  });
}

export function useAddInternalNote(encounterId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { note: string; patientId: string }) =>
      api.post<InternalNote>(`/encounters/${encounterId}/internal-notes`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.encounterNotes(encounterId) });
    },
  });
}

export function useAddDiagnosis(encounterId: string, patientId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { displayText: string; isChronic: boolean }) =>
      api.post('/conditions', { ...input, encounterId, patientId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.encounter(encounterId) });
      void queryClient.invalidateQueries({ queryKey: qk.snapshot(patientId) });
    },
  });
}

/**
 * Switches a draft consultation between in-person and remote.
 *
 * Its own mutation rather than a field on the autosaved draft. Autosave is
 * debounced because it is fed by typing; this is a discrete decision that
 * changes what the doctor is allowed to prescribe and what the printed
 * prescription declares, so it saves at once and the screen shows the result.
 */
export function useSetConsultationMode(encounterId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { mode: ConsultationMode; version: number }) =>
      api.patch<Encounter>(
        `/encounters/${encounterId}`,
        { consultationMode: input.mode },
        { version: input.version },
      ),
    onSuccess: (encounter) => {
      queryClient.setQueryData(qk.encounter(encounterId), encounter);
    },
  });
}

export function useFinaliseEncounter(encounterId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { version: number }) =>
      api.post<Encounter>(
        `/encounters/${encounterId}/finalise`,
        { previewAcknowledged: true },
        { version: input.version, idempotencyKey: idempotencyKey() },
      ),
    onSuccess: (encounter) => {
      queryClient.setQueryData(qk.encounter(encounterId), encounter);
      void queryClient.invalidateQueries({ queryKey: qk.snapshot(encounter.patientId) });
      void queryClient.invalidateQueries({ queryKey: qk.queue() });
      void queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
    },
  });
}

/* ------------------------------------------------------------------------- *
 * Autosaving the consultation note
 * ------------------------------------------------------------------------- */

export type SaveState = 'idle' | 'saving' | 'saved' | 'offline' | 'error';

const AUTOSAVE_MS = 3000;

/**
 * Autosave for the consultation note.
 *
 * Writes to the device immediately on every keystroke and to the server every
 * three seconds. A dropout mid-consultation therefore costs nothing: the draft
 * is on the device, and the queued write replays when the connection returns.
 *
 * This is what makes "clinic internet is unreliable" a handled condition rather
 * than a lost consultation, and it is why the save state is always visible
 * instead of assumed.
 */
export function useEncounterAutosave(
  encounterId: string,
  initial: EncounterDraft | null,
  version: number,
) {
  const [draft, setDraft] = React.useState<EncounterDraft | null>(initial);
  const [state, setState] = React.useState<SaveState>('idle');
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [recovered, setRecovered] = React.useState<EncounterDraft | null>(null);

  const dirty = React.useRef(false);
  const latest = React.useRef<EncounterDraft | null>(initial);

  /**
   * The row version we will send with the next save.
   *
   * Every successful save increments it server-side, so we read the new value
   * back from the response. Taking it only from the query would go stale the
   * moment the first autosave landed, and every save after that would be
   * rejected as a conflict — on the one screen where losing the note matters
   * most.
   */
  const versionRef = React.useRef(version);
  const serverVersion = React.useRef<number | null>(null);
  versionRef.current = serverVersion.current ?? version;

  React.useEffect(() => {
    if (initial && draft === null) {
      setDraft(initial);
      latest.current = initial;
    }
  }, [initial, draft]);

  // An unsent draft from a previous session means the tab was closed offline.
  // Offer it rather than silently discarding or silently applying it.
  React.useEffect(() => {
    let cancelled = false;
    void loadDraft<EncounterDraft>(`encounter:${encounterId}`).then((stored) => {
      if (!cancelled && stored) setRecovered(stored.value);
    });
    return () => {
      cancelled = true;
    };
  }, [encounterId]);

  const update = React.useCallback(
    (patch: Partial<EncounterDraft>) => {
      setDraft((current) => {
        const next = { ...(current ?? ({} as EncounterDraft)), ...patch };
        latest.current = next;
        dirty.current = true;
        void saveDraft(`encounter:${encounterId}`, next);
        return next;
      });
    },
    [encounterId],
  );

  React.useEffect(() => {
    const timer = globalThis.setInterval(async () => {
      if (!dirty.current || !latest.current) return;
      dirty.current = false;
      setState('saving');

      try {
        const saved = await api.patch<Encounter>(
          `/encounters/${encounterId}`,
          latest.current,
          { version: versionRef.current },
        );
        // Carry the new version forward, or the next save is a stale write.
        serverVersion.current = saved.version;
        setState('saved');
        setSavedAt(Date.now());
        void clearDraft(`encounter:${encounterId}`);
      } catch (error) {
        if (error instanceof ApiError && error.isTransient) {
          // Queue it and tell the truth: saved here, not there yet.
          await enqueue({
            method: 'PATCH',
            path: `/encounters/${encounterId}`,
            body: latest.current,
            idempotencyKey: `encounter-${encounterId}-${Date.now()}`,
            version: versionRef.current,
            label: 'Consultation note',
          });
          setState('offline');
        } else {
          setState('error');
        }
      }
    }, AUTOSAVE_MS);

    return () => globalThis.clearInterval(timer);
  }, [encounterId]);

  /**
   * Save immediately rather than waiting for the next tick.
   *
   * Called when the doctor leaves the screen. Without it, up to three seconds
   * of typing is only on the device — recoverable, but the doctor would have to
   * be told about it, and a note that reappears as a "recovered draft" when you
   * expected it saved is alarming.
   */
  const flush = React.useCallback(async () => {
    if (!latest.current || !dirty.current) return;
    dirty.current = false;
    try {
      const saved = await api.patch<Encounter>(
        `/encounters/${encounterId}`,
        latest.current,
        { version: versionRef.current },
      );
      serverVersion.current = saved.version;
    } catch {
      // Leave the local draft in place. The outbox or the recovery prompt on
      // next open will deal with it — never silently discard the note.
    }
  }, [encounterId]);

  // Flush on unmount and when the tab is hidden, which is what a doctor
  // switching windows mid-consultation actually does.
  React.useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      void flush();
    };
  }, [flush]);

  const discardRecovered = React.useCallback(() => {
    setRecovered(null);
    void clearDraft(`encounter:${encounterId}`);
  }, [encounterId]);

  const applyRecovered = React.useCallback(() => {
    if (!recovered) return;
    update(recovered);
    setRecovered(null);
  }, [recovered, update]);

  return {
    draft,
    update,
    state,
    savedAt,
    flush,
    recovered,
    applyRecovered,
    discardRecovered,
  };
}
