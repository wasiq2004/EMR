'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import type { LabTestCatalogueItem } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import { useLabOrders, useOrderLabTest } from './api';

/**
 * Ordering tests from the consultation.
 *
 * Same shape and keystrokes as the drug and diagnosis comboboxes, because they
 * sit on the same screen under the same fingers and a picker that behaves
 * differently from its neighbours is one people stop trusting.
 *
 * FREE TEXT IS A FIRST-CLASS PATH. The catalogue is roughly sixty tests — what a
 * small Indian OPD writes on a slip, not a pathology lab's price list — so plenty
 * of real orders are not in it, and a doctor who cannot find one must write it
 * down rather than pick the nearest wrong test. Ordering the wrong investigation
 * is a worse outcome than an uncoded order.
 *
 * ONE ROW PER TEST, which is why this adds to a list rather than building a
 * requisition. A CBC and a fasting glucose come back at different times and are
 * acted on separately; one order containing both would be "pending" until the
 * slowest arrived.
 */
export function OrderTestPanel({
  patientId,
  encounterId,
  readOnly,
}: {
  patientId: string;
  encounterId: string;
  readOnly: boolean;
}) {
  const toast = useToast();
  const order = useOrderLabTest();
  const existing = useLabOrders({ patientId });

  const [term, setTerm] = React.useState('');
  const [highlight, setHighlight] = React.useState(0);
  const [focused, setFocused] = React.useState(false);
  const [urgent, setUrgent] = React.useState(false);
  const [note, setNote] = React.useState('');

  const trimmed = term.trim();

  const { data } = useQuery({
    queryKey: ['lab', 'tests', trimmed],
    queryFn: () =>
      api.get<{ items: LabTestCatalogueItem[] }>('/lab/tests/search', {
        query: { q: trimmed },
      }),
    enabled: focused,
    staleTime: 60_000,
  });

  const results = data?.items ?? [];
  React.useEffect(() => setHighlight(0), [trimmed]);

  /* Orders from THIS consultation, so the doctor can see what they just added. */
  const fromHere = (existing.data ?? []).filter(
    (row) => row.encounterId === encounterId && row.status !== 'CANCELLED',
  );

  const place = (testName: string, catalogueItemId: string | null) => {
    order.mutate(
      {
        patientId,
        encounterId,
        catalogueItemId,
        testName,
        clinicalNote: note.trim() || null,
        isUrgent: urgent,
      },
      {
        onSuccess: () => {
          toast.success(`${testName} ordered`);
          setTerm('');
          setNote('');
          setUrgent(false);
        },
        onError: () => toast.error('Could not order that test', 'Try again in a moment.'),
      },
    );
  };

  const takeAsTyped = () => {
    if (trimmed.length < 2) return;
    place(trimmed, null);
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
      if (target) place(target.name, target.id);
      else takeAsTyped();
    } else if (event.key === 'Escape') {
      setTerm('');
    }
  };

  const open = focused && trimmed.length >= 1;

  return (
    <Panel>
      <PanelHeader
        title="Lab tests"
        description="Search, or type any test. One row per test."
      />
      <PanelBody className="flex flex-col gap-3">
        {fromHere.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {fromHere.map((row) => (
              <li key={row.id} className="flex items-center gap-1.5 text-xs">
                <span className="min-w-0 truncate text-ink">{row.testName}</span>
                {row.isUrgent ? <Badge tone="warning">Urgent</Badge> : null}
                {row.result ? (
                  <span className="tabular text-ink-soft">
                    {row.result.valueNumeric ?? row.result.valueText}
                  </span>
                ) : (
                  <span className="text-2xs text-ink-faint">awaiting result</span>
                )}
              </li>
            ))}
          </ul>
        ) : null}

        {!readOnly ? (
          <>
            <div className="relative">
              <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
                <Search className="size-4 shrink-0 text-ink-faint" aria-hidden />
                <Input
                  value={term}
                  onChange={(event) => setTerm(event.target.value)}
                  onFocus={() => setFocused(true)}
                  onBlur={() => globalThis.setTimeout(() => setFocused(false), 150)}
                  onKeyDown={onKeyDown}
                  placeholder="CBC, haemoglobin, TSH…"
                  aria-label="Search lab tests, or type one as free text"
                  aria-autocomplete="list"
                  aria-expanded={open}
                  className="h-9 border-0 px-0 focus-visible:ring-0"
                />
              </div>

              {open ? (
                <div className="absolute z-40 mt-1 max-h-64 w-full overflow-y-auto scroll-thin rounded-md border border-line bg-surface-raised shadow-pop">
                  <ul role="listbox" aria-label="Lab tests">
                    {results.map((test, index) => (
                      <li key={test.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={index === highlight}
                          onMouseEnter={() => setHighlight(index)}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            place(test.name, test.id);
                          }}
                          className={cn(
                            'flex w-full items-start gap-2 px-3 py-2 text-left',
                            index === highlight && 'bg-surface-sunk',
                          )}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-ink">
                              {test.name}
                            </span>
                            <span className="block truncate text-2xs text-ink-faint">
                              {test.category ?? 'Uncategorised'}
                              {test.unit ? ` · ${test.unit}` : ''}
                              {test.referenceLow !== null && test.referenceHigh !== null
                                ? ` · ref ${test.referenceLow}–${test.referenceHigh}`
                                : ''}
                            </span>
                          </span>
                          {test.isOwn ? <Badge tone="neutral">This clinic</Badge> : null}
                        </button>
                      </li>
                    ))}

                    {/* Always offered, not only when the search finds nothing. */}
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
                            Order &ldquo;{trimmed}&rdquo; as typed
                          </span>
                          <Badge tone="info" className="ml-auto">
                            Not in catalogue
                          </Badge>
                        </button>
                      </li>
                    ) : null}
                  </ul>
                </div>
              ) : null}
            </div>

            <Input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Why — e.g. rule out anaemia (optional)"
              aria-label="Why the test is being ordered"
              className="text-xs"
            />

            <label className="flex items-center gap-2 text-2xs text-ink-soft">
              <input
                type="checkbox"
                checked={urgent}
                onChange={(event) => setUrgent(event.target.checked)}
                className="size-3.5 accent-accent"
              />
              Urgent — sorts to the top of the review list
            </label>

            {order.isPending ? (
              <Button variant="ghost" size="sm" loading disabled>
                Ordering…
              </Button>
            ) : null}
          </>
        ) : null}
      </PanelBody>
    </Panel>
  );
}
