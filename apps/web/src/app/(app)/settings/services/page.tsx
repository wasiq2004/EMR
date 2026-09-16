'use client';

import { Banknote, Plus } from 'lucide-react';
import { useCan } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Panel, PanelHeader } from '@/components/ui/surface';
import { EmptyState } from '@/components/ui/feedback';

/** Services and fees. */
export default function ServicesSettingsPage() {
  const canEdit = useCan('clinic:update');

  return (
    <Panel>
      <PanelHeader
        title="Services and fees"
        description="Billable items, their default fee, and how long a slot they book."
        actions={
          canEdit ? (
            <Button size="sm" variant="primary">
              <Plus aria-hidden />
              Add service
            </Button>
          ) : null
        }
      />
      <EmptyState
        icon={Banknote}
        title="No services defined"
        description="Add the consultation types this clinic charges for."
      />
    </Panel>
  );
}
