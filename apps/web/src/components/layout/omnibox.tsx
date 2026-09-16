'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Search, UserRound } from 'lucide-react';
import type { PatientSummary } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { ageGender, formatPhone } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { cn } from '@/lib/cn';

/**
 * Patient search from anywhere.
 *
 * Opens on Ctrl/Cmd+K and is focused the moment it opens, because the front
 * desk's first action on almost every interaction is "find this person". The
 * search field on the registry page is focused on load for the same reason —
 * registration has to complete in under a minute and a click to focus is
 * wasted time.
 */
export function Omnibox() {
  const [open, setOpen] = React.useState(false);
  const [term, setTerm] = React.useState('');
  const [highlight, setHighlight] = React.useState(0);
  const router = useRouter();

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(true);
      }
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, []);

  const trimmed = term.trim();
  const { data, isFetching } = useQuery({
    queryKey: qk.patients(trimmed),
    queryFn: () =>
      api.get<{ items: PatientSummary[] }>('/patients/search', {
        query: { q: trimmed, limit: 8 },
      }),
    enabled: open && trimmed.length >= 2,
    staleTime: 10_000,
  });

  const results = data?.items ?? [];

  React.useEffect(() => setHighlight(0), [trimmed]);

  const go = React.useCallback(
    (patientId: string) => {
      setOpen(false);
      setTerm('');
      router.push(`/patients/${patientId}`);
    },
    [router],
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (event.key === 'Enter') {
      const target = results[highlight];
      if (target) {
        event.preventDefault();
        go(target.id);
      }
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-9 w-full max-w-sm items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-left text-sm text-ink-faint transition-colors hover:border-line-strong"
      >
        <Search className="size-4 shrink-0" aria-hidden />
        <span className="flex-1 truncate">Search patients</span>
        <kbd className="hidden shrink-0 rounded-sm border border-line px-1 py-0.5 text-2xs text-ink-faint sm:inline">
          Ctrl K
        </kbd>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="md" className="p-0">
          <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
            <Search className="size-4 shrink-0 text-ink-faint" aria-hidden />
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input
              autoFocus
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Mobile number or name"
              aria-label="Search patients by mobile number or name"
              className="h-7 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
            />
          </div>

          <div className="max-h-80 overflow-y-auto scroll-thin">
            {trimmed.length < 2 ? (
              <p className="px-4 py-6 text-center text-xs text-ink-faint">
                Type a mobile number or at least two letters of a name.
              </p>
            ) : results.length === 0 && !isFetching ? (
              <p className="px-4 py-6 text-center text-xs text-ink-faint">
                No patient matches “{trimmed}”.
              </p>
            ) : (
              <ul role="listbox" aria-label="Patient results">
                {results.map((patient, index) => (
                  <li key={patient.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === highlight}
                      onMouseEnter={() => setHighlight(index)}
                      onClick={() => go(patient.id)}
                      className={cn(
                        'flex w-full items-center gap-3 px-4 py-2 text-left',
                        index === highlight ? 'bg-surface-sunk' : 'bg-transparent',
                      )}
                    >
                      <UserRound
                        className="size-4 shrink-0 text-ink-faint"
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-ink">
                            {patient.fullName}
                          </span>
                          {patient.hasHighCriticalityAllergy ? (
                            <Badge tone="critical">Allergy</Badge>
                          ) : null}
                        </span>
                        <span className="mt-0.5 flex items-center gap-2 text-2xs text-ink-faint">
                          <span className="token">{patient.mrn}</span>
                          <span>{ageGender(patient)}</span>
                          <span className="token">
                            {formatPhone(patient.mobileE164)}
                          </span>
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
