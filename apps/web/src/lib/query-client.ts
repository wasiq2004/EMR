/**
 * TanStack Query configuration, including the IndexedDB cache.
 *
 * Clinical reads are cached to the device so a dropout mid-consultation shows
 * the last known record rather than a spinner. Two things are deliberately
 * excluded from that cache:
 *   - the audit trail, which must always be read live
 *   - anything under the compliance surface, which should leave no local trace
 */

import { QueryClient, type QueryKey } from '@tanstack/react-query';
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';
import { del, get, set } from 'idb-keyval';
import { ApiError } from './api-client';

const CACHE_KEY = 'emr:query-cache';

/** Cached reads survive a reload but not a new day. */
const MAX_CACHE_AGE_MS = 12 * 60 * 60 * 1000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: MAX_CACHE_AGE_MS,
        refetchOnWindowFocus: true,
        retry(failureCount, error) {
          // A 403 or a validation failure will never succeed on retry, and
          // retrying a denial just fills the audit log with failures.
          if (error instanceof ApiError && !error.isTransient) return false;
          return failureCount < 2;
        },
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      },
      mutations: {
        retry: false,
      },
    },
  });
}

/**
 * Query keys in one place, so an invalidation after a mutation cannot miss a
 * screen that happens to read the same data under a different key.
 */
export const qk = {
  session: ['session'] as QueryKey,

  queue: (date?: string) => ['queue', date ?? 'today'] as QueryKey,
  appointments: (from: string, to: string) => ['appointments', from, to] as QueryKey,

  patients: (search: string, cursor?: string) =>
    ['patients', 'list', search, cursor ?? null] as QueryKey,
  patient: (id: string) => ['patients', id] as QueryKey,
  snapshot: (id: string) => ['patients', id, 'snapshot'] as QueryKey,
  patientVisits: (id: string) => ['patients', id, 'visits'] as QueryKey,
  patientDocuments: (id: string) => ['patients', id, 'documents'] as QueryKey,
  patientInvoices: (id: string) => ['patients', id, 'invoices'] as QueryKey,
  patientConsents: (id: string) => ['patients', id, 'consents'] as QueryKey,
  duplicateCheck: (mobile: string, name: string) =>
    ['patients', 'duplicates', mobile, name] as QueryKey,
  duplicateCandidates: ['patients', 'duplicate-candidates'] as QueryKey,

  encounter: (id: string) => ['encounters', id] as QueryKey,
  encounterNotes: (id: string) => ['encounters', id, 'internal-notes'] as QueryKey,
  prescriptions: (encounterId: string) =>
    ['encounters', encounterId, 'prescriptions'] as QueryKey,
  drugSearch: (term: string) => ['drugs', term] as QueryKey,
  encounterTemplates: ['templates', 'encounter'] as QueryKey,
  prescriptionTemplates: ['templates', 'prescription'] as QueryKey,

  conversations: (filter: string) => ['inbox', filter] as QueryKey,
  conversation: (id: string) => ['inbox', 'conversation', id] as QueryKey,

  documents: (filter: string) => ['documents', filter] as QueryKey,
  document: (id: string) => ['documents', id] as QueryKey,
  shareLinks: (documentId: string) => ['documents', documentId, 'shares'] as QueryKey,

  tasks: (filter: string) => ['tasks', filter] as QueryKey,

  invoices: (filter: string) => ['invoices', filter] as QueryKey,
  invoice: (id: string) => ['invoices', id] as QueryKey,

  reports: (from: string, to: string) => ['reports', from, to] as QueryKey,

  clinic: ['settings', 'clinic'] as QueryKey,
  locations: ['settings', 'locations'] as QueryKey,
  staff: ['settings', 'staff'] as QueryKey,
  services: ['settings', 'services'] as QueryKey,
  whatsappAccount: ['settings', 'whatsapp'] as QueryKey,
  messageTemplates: ['settings', 'message-templates'] as QueryKey,
  reminderRules: ['settings', 'reminders'] as QueryKey,
  importJobs: ['settings', 'imports'] as QueryKey,
  importJob: (id: string) => ['settings', 'imports', id] as QueryKey,
  exportJobs: ['settings', 'exports'] as QueryKey,

  auditEvents: (filter: string) => ['audit', filter] as QueryKey,
} as const;

/** Never written to disk. */
const UNCACHEABLE_ROOTS = new Set(['audit', 'session']);

export function createIdbPersister(): Persister {
  return {
    async persistClient(client: PersistedClient) {
      try {
        const queries = client.clientState.queries.filter((query) => {
          const root = Array.isArray(query.queryKey) ? query.queryKey[0] : null;
          return typeof root === 'string' ? !UNCACHEABLE_ROOTS.has(root) : true;
        });
        await set(CACHE_KEY, { ...client, clientState: { ...client.clientState, queries } });
      } catch {
        // Blocked site data. The app runs without a persisted cache; it just
        // loses the offline read-through.
      }
    },
    async restoreClient() {
      try {
        return (await get<PersistedClient>(CACHE_KEY)) ?? undefined;
      } catch {
        return undefined;
      }
    },
    async removeClient() {
      try {
        await del(CACHE_KEY);
      } catch {
        /* nothing to do */
      }
    },
  };
}

export const persistOptions = {
  persister: createIdbPersister(),
  maxAge: MAX_CACHE_AGE_MS,
  buster: 'v1',
};
