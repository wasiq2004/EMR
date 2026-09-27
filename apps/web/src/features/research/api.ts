'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AnalystExportRow,
  Cohort,
  CohortFilters,
  CohortRow,
  CohortSummary,
  DataQualityReport,
  DictionaryEntry,
  SaveCohort,
} from '@emr/contracts';
import { api } from '@/lib/api-client';

/**
 * The analytics data layer.
 *
 * Note what is NOT here: there is no patient hook, no search, no lookup by name or
 * phone. Not because they were omitted — because the analyst session has no
 * permission that would let them return anything, so a hook for one would be a hook
 * that always 403s.
 *
 * Cohort results are cached briefly and NEVER persisted. The query client's
 * localStorage persister is scoped to the clinic app's own keys; a cohort's rows are
 * derived data that should not survive a page reload on a shared machine.
 */

export const rk = {
  cohorts: () => ['analytics', 'cohorts'] as const,
  cohort: (id: string) => ['analytics', 'cohort', id] as const,
  result: (id: string) => ['analytics', 'result', id] as const,
  preview: (filters: CohortFilters) => ['analytics', 'preview', filters] as const,
  quality: (from: string, to: string) => ['analytics', 'quality', from, to] as const,
  dictionary: () => ['analytics', 'dictionary'] as const,
  exports: () => ['analytics', 'exports'] as const,
};

export interface CohortResult {
  rows: CohortRow[];
  summary: CohortSummary;
}

export function useCohorts() {
  return useQuery({
    queryKey: rk.cohorts(),
    queryFn: () => api.get<{ items: Cohort[] }>('/analytics/cohorts'),
    select: (data) => data.items,
  });
}

export function useCohort(id: string) {
  return useQuery({
    queryKey: rk.cohort(id),
    queryFn: () => api.get<Cohort>(`/analytics/cohorts/${id}`),
    enabled: Boolean(id),
  });
}

export function useSaveCohort() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveCohort & { id?: string }) => api.post<Cohort>('/analytics/cohorts', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['analytics'] });
    },
  });
}

export function useDeleteCohort() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/analytics/cohorts/${id}/delete`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['analytics'] });
    },
  });
}

/**
 * Runs a saved cohort.
 *
 * A mutation rather than a query because it writes — it caches the evaluated size on
 * the cohort — and because it should appear in the audit trail as something the
 * analyst did rather than as a page load.
 */
export function useEvaluateCohort() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<CohortResult>(`/analytics/cohorts/${id}/evaluate`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: rk.cohorts() });
    },
  });
}

/** Previews an unsaved definition through the same evaluator. */
export function usePreviewCohort() {
  return useMutation({
    mutationFn: (filters: CohortFilters) =>
      api.post<CohortResult>('/analytics/cohorts/preview', filters),
  });
}

export function useDataQuality(from: string, to: string) {
  return useQuery({
    queryKey: rk.quality(from, to),
    queryFn: () => api.get<DataQualityReport>('/analytics/quality', { query: { from, to } }),
    staleTime: 60_000,
  });
}

export function useDictionary() {
  return useQuery({
    queryKey: rk.dictionary(),
    queryFn: () => api.get<{ items: DictionaryEntry[] }>('/analytics/dictionary'),
    select: (data) => data.items,
    // The dictionary changes when the schema does, which is not during a session.
    staleTime: 10 * 60_000,
  });
}

export function useAnalystExports() {
  return useQuery({
    queryKey: rk.exports(),
    queryFn: () => api.get<{ items: AnalystExportRow[] }>('/analytics/exports'),
    select: (data) => data.items,
  });
}

export function useRequestExport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      cohortId?: string | null;
      filters?: CohortFilters;
      exportType: 'COHORT_ROWS' | 'TREND_SERIES' | 'DATA_QUALITY';
    }) =>
      api.post<{
        id: string;
        rowCount: number;
        columnsIncluded: string[];
        rows: CohortRow[];
      }>('/analytics/exports', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: rk.exports() });
    },
  });
}

/**
 * Turns cohort rows into a CSV the browser downloads.
 *
 * Done in the browser rather than server-side on purpose: the server already told us
 * exactly which columns were exported and recorded that list for provenance, so
 * writing the file here avoids a de-identified extract sitting in object storage with
 * its own lifecycle to forget about.
 *
 * Every value is quoted and internal quotes doubled — a diagnosis display text with a
 * comma in it would otherwise shift every following column.
 */
export function downloadCohortCsv(
  rows: CohortRow[],
  columns: string[],
  filename: string,
): void {
  const cell = (value: unknown): string => {
    const text =
      Array.isArray(value) ? value.join('; ') : value === null || value === undefined ? '' : String(value);
    return `"${text.replace(/"/g, '""')}"`;
  };

  const header = columns.map(cell).join(',');
  const body = rows
    .map((row) =>
      [
        row.subjectKey,
        row.ageBand,
        row.sex,
        row.encounterCount,
        row.firstEncounterMonth,
        row.lastEncounterMonth,
        row.diagnosisCodes,
        row.medicationMolecules,
        row.followUpCompleted,
      ]
        .map(cell)
        .join(','),
    )
    .join('\n');

  const blob = new Blob([`${header}\n${body}\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
