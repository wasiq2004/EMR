'use client';

import { useQuery } from '@tanstack/react-query';
import { Pill } from 'lucide-react';
import type { PrescriptionTemplate } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Alert, EmptyState, SkeletonRows } from '@/components/ui/feedback';

/**
 * Prescription sets.
 *
 * Same correction as the consultation templates: this rendered an unconditional
 * "No prescription sets yet" with no read path at all, above a "New set" button
 * with no handler. A clinic with sets in the database saw a page telling them
 * they had none.
 *
 * `GET /prescription-templates` has existed since the prescribing module
 * shipped. Creating and editing them has no API, so the page says so rather than
 * offering a control that cannot work.
 */
export default function PrescriptionTemplatesSettingsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['prescription-templates'],
    queryFn: () =>
      api
        .get<{ items: PrescriptionTemplate[] }>('/prescription-templates')
        .catch(() => ({ items: [] })),
    select: (result) => result.items,
  });

  const templates = data ?? [];

  return (
    <Panel>
      <PanelHeader
        title="Prescription sets"
        description="Combinations a doctor reaches for repeatedly, saved once and applied in a keystroke."
      />

      <PanelBody className="pb-0">
        <Alert tone="info" title="Read-only for now">
          Sets can be applied in a consultation but not yet created or edited
          here — there is no write API behind this screen.
        </Alert>
      </PanelBody>

      {isLoading ? (
        <SkeletonRows rows={3} />
      ) : templates.length === 0 ? (
        <EmptyState
          icon={Pill}
          title="No prescription sets yet"
          description="A set is a combination the doctor prescribes together — and applying one is a keystroke rather than four searches."
        />
      ) : (
        <ul className="divide-y divide-line-soft">
          {templates.map((template) => (
            <li key={template.id} className="px-4 py-3">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                {template.name}
                <Badge tone="neutral">
                  {template.lineItems.length} medicine
                  {template.lineItems.length === 1 ? '' : 's'}
                </Badge>
              </p>
              <p className="mt-0.5 truncate text-2xs text-ink-faint">
                {template.usageCount > 0 ? `Used ${template.usageCount}×` : 'Never used'}
                {template.indication ? ` · for ${template.indication}` : ''}
              </p>
              {/*
                The medicines themselves, because "Fever pack" tells an
                administrator nothing about whether it is still the right pack.
              */}
              {template.lineItems.length > 0 ? (
                <p className="mt-0.5 truncate text-2xs text-ink-soft">
                  {template.lineItems.map((line) => line.drugDisplayName).join(', ')}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
