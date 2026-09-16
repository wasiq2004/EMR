'use client';

import { ClipboardList, Plus } from 'lucide-react';
import { useCan } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Panel, PanelHeader } from '@/components/ui/surface';
import { EmptyState } from '@/components/ui/feedback';

/** Consultation templates. */
export default function EncounterTemplatesSettingsPage() {
  const canEdit = useCan('encounter:create');

  return (
    <Panel>
      <PanelHeader
        title="Consultation templates"
        description="Pre-filled note structures. A doctor who retypes the same examination forty times a day will go back to paper."
        actions={
          canEdit ? (
            <Button size="sm" variant="primary">
              <Plus aria-hidden />
              New template
            </Button>
          ) : null
        }
      />
      <EmptyState
        icon={ClipboardList}
        title="No templates yet"
        description="Templates turn typing into confirming, which is the single biggest saving in a consultation."
      />
    </Panel>
  );
}
