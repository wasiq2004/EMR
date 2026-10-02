'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import type { DiagnosisCatalogueItem } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { Input } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';

/**
 * Diagnosis search.
 *
 * Deliberately the same shape, keystrokes and manners as `DrugCombobox` — they
 * run under the same fingers a few seconds apart, and a picker that behaves
 * differently from the one beside it is a picker people stop trusting.
 *
 * FREE TEXT IS ALWAYS THE FIRST-CLASS PATH, not a fallback for when the search
 * fails. `condition.code` is nullable, always has been, and a diagnosis typed in
 * a doctor's own words is a complete record. The catalogue is roughly 300 curated
 * ICD-10 codes, not the full seventy thousand, so plenty of real diagnoses are
 * genuinely not in it — and a doctor who cannot find the code for what they are
 * looking at must write it down and move on. Picking the nearest wrong code is
 * the failure this is designed to avoid: a code carries the authority of a
 * standard onto an insurance claim and into the next clinician's reading, which
 * free text visibly does not claim.
 *
 * So: Enter with no match takes what was typed. There is no "no results" dead
 * end, and nothing is ever refused for being uncatalogued. The data-quality
 * screen counts the coded proportion precisely so the gap stays visible rather
 * than being forced shut.
 */
export function DiagnosisCombobox({
  onSelect,
  onFreeText,
  placeholder = 'Search a diagnosis, or type it as you would write it',
}: {
  onSelect: (item: DiagnosisCatalogueItem) => void;
  onFreeText: (displayText: string) => void;
  placeholder?: string;
}) {
  const [term, setTerm] = React.useState('');
  const [highlight, setHighlight] = React.useState(0);
  const [focused, setFocused] = React.useState(false);

  const trimmed = term.trim();

  const { data } = useQuery({
    queryKey: ['diagnoses', 'search', trimmed],
    queryFn: () =>
      api.get<{ items: DiagnosisCatalogueItem[] }>('/diagnoses/search', {
        query: { q: trimmed },
      }),
    enabled: focused,
    staleTime: 60_000,
  });

  const results = data?.items ?? [];
  React.useEffect(() => setHighlight(0), [trimmed]);

  const reset = () => {
    setTerm('');
    setHighlight(0);
  };

  const takeAsTyped = () => {
    if (trimmed.length < 2) return;
    onFreeText(trimmed);
    reset();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = results[highlight];
      if (target) {
        onSelect(target);
        reset();
      } else {
        // Nothing matched. Take it as typed rather than blocking the doctor.
        takeAsTyped();
      }
    } else if (event.key === 'Escape') {
      reset();
    }
  };

  const open = focused && trimmed.length >= 1;

  return (
    <div className="relative">
      <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
        <Search className="size-4 shrink-0 text-ink-faint" aria-hidden />
        <Input
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => globalThis.setTimeout(() => setFocused(false), 150)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label="Search diagnoses, or type one as free text"
          aria-autocomplete="list"
          aria-expanded={open}
          className="h-9 border-0 px-0 focus-visible:ring-0"
        />
      </div>

      {open ? (
        <div className="absolute z-40 mt-1 max-h-72 w-full overflow-y-auto scroll-thin rounded-md border border-line bg-surface-raised shadow-pop">
          <ul role="listbox" aria-label="Diagnoses">
            {results.map((item, index) => (
              <li key={item.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === highlight}
                  onMouseEnter={() => setHighlight(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onSelect(item);
                    reset();
                  }}
                  className={cn(
                    'flex w-full items-start gap-2 px-3 py-2 text-left',
                    index === highlight && 'bg-surface-sunk',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-medium text-ink">{item.displayText}</span>
                      <span className="token text-xs text-ink-soft">{item.code}</span>
                      {item.isChronicByDefault ? (
                        <Badge tone="chronic">Chronic</Badge>
                      ) : null}
                      {/*
                        A clinic's own addition is marked, so a doctor can tell
                        their practice's shorthand from a standard code.
                      */}
                      {item.isOwn ? <Badge tone="neutral">This clinic</Badge> : null}
                    </span>
                    {item.category ? (
                      <span className="mt-0.5 block truncate text-2xs text-ink-faint">
                        {item.category}
                        {item.uses > 0 ? ` · recorded ${item.uses}× here` : ''}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}

            {/*
              ALWAYS PRESENT, not only when the search finds nothing.

              Shown beneath the matches rather than instead of them, because the
              commonest case is a doctor whose phrasing is close to a listed code
              but who means something more specific — "URTI with otitis" when the
              list offers both separately. Hiding this option whenever there are
              results would make the nearest wrong code the path of least
              resistance, which is exactly backwards.
            */}
            {trimmed.length >= 2 ? (
              <li className={cn(results.length > 0 && 'border-t border-line-soft')}>
                <button
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    takeAsTyped();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-surface-sunk"
                >
                  <span className="text-sm text-ink">
                    Record &ldquo;{trimmed}&rdquo; as typed
                  </span>
                  <Badge tone="info" className="ml-auto">
                    No code
                  </Badge>
                </button>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
