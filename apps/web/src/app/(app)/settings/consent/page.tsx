'use client';

import { FileText, Plus } from 'lucide-react';
import { useCan } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Panel, PanelHeader } from '@/components/ui/surface';
import { EmptyState } from '@/components/ui/feedback';

/** Consent text. */
export default function ConsentSettingsPage() {
  const canEdit = useCan('consent:update');

  return (
    <Panel>
      <PanelHeader
        title="Consent text"
        description="The notices patients are shown, by purpose and language. Each version is recorded against the consent it was used for."
        actions={
          canEdit ? (
            <Button size="sm" variant="primary">
              <Plus aria-hidden />
              Add notice
            </Button>
          ) : null
        }
      />
      <EmptyState
        icon={FileText}
        title="No notice text uploaded"
        description="Approved wording is supplied by the clinic's legal advisor."
      />
    </Panel>
  );
}
