'use client';

import { Pill, Plus } from 'lucide-react';
import { useCan } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Panel, PanelHeader } from '@/components/ui/surface';
import { EmptyState } from '@/components/ui/feedback';

/** Prescription sets. */
export default function PrescriptionTemplatesSettingsPage() {
  const canEdit = useCan('prescription:create');

  return (
    <Panel>
      <PanelHeader
        title="Prescription sets"
        description="Common medicine combinations. Applying one re-runs every safety check against that patient."
        actions={
          canEdit ? (
            <Button size="sm" variant="primary">
              <Plus aria-hidden />
              New set
            </Button>
          ) : null
        }
      />
      <EmptyState
        icon={Pill}
        title="No prescription sets yet"
        description="A set never bypasses an allergy check — it only saves typing."
      />
    </Panel>
  );
}
