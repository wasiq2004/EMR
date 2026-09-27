'use client';

import * as React from 'react';
import { BookOpen, EyeOff } from 'lucide-react';
import { useDictionary } from '@/features/research/api';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/field';
import { DataState } from '@/components/ui/data-state';
import { Alert } from '@/components/ui/feedback';
import { PageHeader, Panel, PanelBody, PanelHeader } from '@/components/ui/surface';

/**
 * The data dictionary.
 *
 * Served from the API rather than kept in a document, because a dictionary that lives
 * elsewhere describes last year's schema.
 *
 * FIELDS THE ANALYST CANNOT REACH ARE LISTED ANYWAY, marked as such. Being told plainly
 * that `full_name` exists and is not reachable is more useful than a list with a hole in
 * it, which invites someone to go looking for the endpoint.
 *
 * `absenceMeaning` is the most valuable column and the one most dictionaries omit. Why a
 * field is empty usually matters more than its type: "no follow-up was requested" and "a
 * follow-up was requested and missed" are different facts a null cannot tell apart.
 */
export default function DictionaryPage() {
  const [search, setSearch] = React.useState('');
  const dictionary = useDictionary();

  const filtered = React.useMemo(() => {
    const items = dictionary.data ?? [];
    if (!search.trim()) return items;
    const needle = search.trim().toLowerCase();
    return items.filter((entry) =>
      [entry.entity, entry.field, entry.definition].join(' ').toLowerCase().includes(needle),
    );
  }, [dictionary.data, search]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Data dictionary"
        description="What each field means, where it comes from, and what its absence means."
        actions={
          <Input
            aria-label="Search the dictionary"
            placeholder="Search…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-56"
          />
        }
      />

      <Alert tone="info" title="Read this before building a cohort">
        Two fields catch people out. <span className="token">age_years</span> is an estimate
        captured at registration and is not recomputed as a patient ages, and a coded
        diagnosis filter cannot see conditions recorded as free text.
      </Alert>

      <Panel>
        <PanelHeader title="Fields" />
        <PanelBody>
          <DataState
            query={{ ...dictionary, data: filtered }}
            empty={{
              icon: BookOpen,
              title: search ? 'Nothing matches that' : 'The dictionary is empty',
            }}
          >
            {(items) => (
              <div className="space-y-2">
                {items.map((entry) => (
                  <div
                    key={`${entry.entity}.${entry.field}`}
                    className="rounded-md border border-line px-3 py-2.5"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-2xs uppercase tracking-wide text-ink-faint">
                        {entry.entity}
                      </span>
                      <span className="token text-sm font-semibold text-ink">{entry.field}</span>
                      <Badge>{entry.type}</Badge>
                      {entry.unit ? <Badge tone="info">{entry.unit}</Badge> : null}
                      {entry.codingSystem ? (
                        <Badge tone="chronic">{entry.codingSystem}</Badge>
                      ) : null}
                      {entry.availableToAnalyst ? null : (
                        <Badge tone="critical">
                          <EyeOff className="size-3" aria-hidden />
                          Not reachable from this panel
                        </Badge>
                      )}
                    </div>

                    <p className="mt-1 text-sm text-ink-soft">{entry.definition}</p>

                    {entry.absenceMeaning ? (
                      <p className="mt-1 text-xs text-ink-faint">
                        <span className="font-medium text-ink-soft">When empty: </span>
                        {entry.absenceMeaning}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </DataState>
        </PanelBody>
      </Panel>
    </div>
  );
}
