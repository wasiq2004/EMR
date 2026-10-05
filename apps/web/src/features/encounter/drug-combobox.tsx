'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Plus, Search, Star } from 'lucide-react';
import type { Allergy, DrugCatalogueItem } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { checkPrescription } from '@/lib/safety';
import { cn } from '@/lib/cn';
import { Input } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';

/**
 * Drug search.
 *
 * Three things matter here and all three are load-bearing for adoption:
 *
 *   - Results in under 200ms, because this runs while the doctor types, several
 *     times per prescription.
 *   - Clinic favourites rank first. A GP prescribes from perhaps 150 drugs, and
 *     surfacing those first is the difference between 20 seconds and 5 per line
 *     — which compounds across a 40-patient day.
 *   - Allergy matches are flagged INLINE, before selection. Catching it here is
 *     better than catching it in the modal, because the doctor never has to
 *     back out of a choice they already made.
 *
 * Free-text entry is always available. A doctor must be able to prescribe a
 * compounded preparation or a newly launched brand that is not in the
 * catalogue; refusing to save an uncatalogued prescription is the fastest route
 * to abandonment.
 */
export function DrugCombobox({
  allergies,
  onSelect,
  onFreeText,
  onAddToCatalogue,
}: {
  allergies: Allergy[];
  onSelect: (drug: DrugCatalogueItem) => void;
  onFreeText: (name: string) => void;
  /**
   * Opens the add-to-catalogue dialog, where the role allows it.
   *
   * Undefined for a doctor without `clinic:update` — prescribing an uncatalogued
   * drug is clinical work anybody can do, but adding to the clinic's list
   * changes what everybody is offered from then on, which is configuration.
   */
  onAddToCatalogue?: (typed: string) => void;
}) {
  const [term, setTerm] = React.useState('');
  const [highlight, setHighlight] = React.useState(0);
  const [focused, setFocused] = React.useState(false);

  const trimmed = term.trim();
  const { data } = useQuery({
    queryKey: qk.drugSearch(trimmed),
    queryFn: () =>
      api.get<{ items: DrugCatalogueItem[] }>('/drugs/search', {
        query: { q: trimmed },
      }),
    enabled: focused,
    staleTime: 60_000,
  });

  const results = data?.items ?? [];
  React.useEffect(() => setHighlight(0), [trimmed]);

  const choose = (drug: DrugCatalogueItem) => {
    onSelect(drug);
    setTerm('');
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
        choose(target);
      } else if (trimmed.length >= 2) {
        // Nothing matched — take it as typed rather than blocking the doctor.
        onFreeText(trimmed);
        setTerm('');
      }
    } else if (event.key === 'Escape') {
      setTerm('');
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
          placeholder="Search a medicine, or type any name"
          aria-label="Search the drug catalogue"
          aria-autocomplete="list"
          aria-expanded={open}
          className="h-9 border-0 px-0 focus-visible:ring-0"
        />
      </div>

      {open ? (
        <div className="absolute z-40 mt-1 max-h-72 w-full overflow-y-auto scroll-thin rounded-md border border-line bg-surface-raised shadow-pop">
          {
            <ul role="listbox" aria-label="Medicines">
              {results.map((drug, index) => {
                const warnings = checkPrescription(
                  {
                    drugDisplayName: drug.brandName ?? drug.moleculeName,
                    moleculeName: drug.moleculeName,
                    drugSchedule: drug.drugSchedule,
                  },
                  { allergies, existingLines: [] },
                );
                const allergyHit = warnings.find(
                  (w) => w.kind === 'ALLERGY_EXACT' || w.kind === 'ALLERGY_CLASS',
                );

                return (
                  <li key={drug.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === highlight}
                      onMouseEnter={() => setHighlight(index)}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        choose(drug);
                      }}
                      className={cn(
                        'flex w-full items-start gap-2 px-3 py-2 text-left',
                        index === highlight && 'bg-surface-sunk',
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          {drug.isFavourite ? (
                            <Star
                              className="size-3 shrink-0 fill-warning text-warning"
                              aria-label="Frequently prescribed here"
                            />
                          ) : null}
                          <span className="text-sm font-medium text-ink">
                            {drug.brandName ?? drug.moleculeName}
                          </span>
                          {drug.strength ? (
                            <span className="token text-xs text-ink-soft">
                              {drug.strength}
                            </span>
                          ) : null}
                          {drug.drugSchedule === 'X' ? (
                            <Badge tone="critical">Schedule X</Badge>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block truncate text-2xs text-ink-faint">
                          {drug.moleculeName}
                          {drug.dosageForm ? ` · ${drug.dosageForm}` : ''}
                        </span>
                      </span>

                      {/* Flagged before selection, not after. */}
                      {allergyHit ? (
                        <Badge tone="alarm" className="mt-0.5 shrink-0">
                          <AlertTriangle aria-hidden />
                          Allergy
                        </Badge>
                      ) : null}
                    </button>
                  </li>
                );
              })}

              {/*
                BOTH fallbacks, and always present rather than only when the
                search finds nothing.

                They are different acts. "Prescribe as typed" writes this one
                prescription and is what a doctor mid-consultation wants.
                "Add to the clinic's list" keeps it, so the next doctor finds it
                by searching and the allergy check has a molecule to reason
                about — which needs a molecule typed in, and is therefore a
                decision, not a keystroke. Showing them only on an empty result
                set hid the second one entirely: a drug missing from the
                catalogue almost always has near-matches.
              */}
              {trimmed.length >= 2 ? (
                <li className={cn(results.length > 0 && 'border-t border-line-soft')}>
                  <button
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      onFreeText(trimmed);
                      setTerm('');
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-surface-sunk"
                  >
                    <span className="text-sm text-ink">
                      Prescribe &ldquo;{trimmed}&rdquo; as typed
                    </span>
                    <Badge tone="info" className="ml-auto">
                      Just this once
                    </Badge>
                  </button>
                </li>
              ) : null}

              {trimmed.length >= 2 && onAddToCatalogue ? (
                <li className="border-t border-line-soft">
                  <button
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      onAddToCatalogue(trimmed);
                      setTerm('');
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-surface-sunk"
                  >
                    <Plus className="size-3.5 shrink-0 text-accent" aria-hidden />
                    <span className="text-sm text-ink">
                      Add &ldquo;{trimmed}&rdquo; to the clinic&rsquo;s list
                    </span>
                    <Badge tone="neutral" className="ml-auto">
                      Keeps it
                    </Badge>
                  </button>
                </li>
              ) : null}
            </ul>
          }
        </div>
      ) : null}
    </div>
  );
}
