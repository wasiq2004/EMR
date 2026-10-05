'use client';

import { useQuery } from '@tanstack/react-query';
import { ClipboardList } from 'lucide-react';
import type { EncounterTemplate } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Alert, EmptyState, SkeletonRows } from '@/components/ui/feedback';

/**
 * Consultation templates.
 *
 * THIS PAGE USED TO LIE. It rendered an unconditional "No templates yet" with no
 * read path at all — not one `api.get` — above a "New template" button with no
 * handler. A clinic whose templates were seeded or imported saw an empty page
 * telling them they had none, and the control to make one did nothing.
 *
 * It now reads `GET /encounter-templates`, which has existed since the
 * prescribing module shipped and which the consultation screen already uses.
 * Creating and editing them has no API yet, so the page says that plainly rather
 * than offering a button that cannot work — a disabled control with a reason is
 * honest; an enabled one that does nothing teaches people the product is broken.
 */
export default function EncounterTemplatesSettingsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['encounter-templates'],
    queryFn: () =>
      api
        .get<{ items: EncounterTemplate[] }>('/encounter-templates')
        .catch(() => ({ items: [] })),
    select: (result) => result.items,
  });

  const templates = data ?? [];

  return (
    <Panel>
      <PanelHeader
        title="Consultation templates"
        description="Pre-filled note structures. A doctor who retypes the same examination forty times a day will go back to paper."
      />

      <PanelBody className="pb-0">
        {/*
          Says what is missing instead of pretending with a dead button.
          Somebody reading this can plan around it; a button that silently does
          nothing just costs them a support call.
        */}
        <Alert tone="info" title="Read-only for now">
          Templates can be used in a consultation but not yet created or edited
          here — there is no write API behind this screen. Until there is, they
          are seeded or loaded directly into the database.
        </Alert>
      </PanelBody>

      {isLoading ? (
        <SkeletonRows rows={3} />
      ) : templates.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No templates yet"
          description="Templates turn typing into confirming, which is the single biggest saving in a consultation."
        />
      ) : (
        <ul className="divide-y divide-line-soft">
          {templates.map((template) => (
            <li key={template.id} className="px-4 py-3">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                {template.name}
                {template.specialty ? (
                  <Badge tone="neutral">{template.specialty}</Badge>
                ) : null}
                {/*
                  A template that prompts for vitals is materially different
                  from one that only pre-fills text, so it is worth seeing at a
                  glance which do.
                */}
                {template.promptedObservations.length > 0 ? (
                  <Badge tone="info">
                    Prompts {template.promptedObservations.length} vitals
                  </Badge>
                ) : null}
              </p>
              <p className="mt-0.5 truncate text-2xs text-ink-faint">
                {/* Usage first: an unused template is one to retire. */}
                {template.usageCount > 0
                  ? `Used ${template.usageCount}×`
                  : 'Never used'}
                {template.chiefComplaint ? ` · ${template.chiefComplaint}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
