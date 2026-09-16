'use client';

import { MapPin, Plus } from 'lucide-react';
import { useCan } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Panel, PanelHeader } from '@/components/ui/surface';
import { EmptyState } from '@/components/ui/feedback';

/** Locations. */
export default function LocationsSettingsPage() {
  const canEdit = useCan('clinic:update');

  return (
    <Panel>
      <PanelHeader
        title="Locations"
        description="Consulting rooms and branch sites. A growing practice adds a second one here."
        actions={
          canEdit ? (
            <Button size="sm" variant="primary">
              <Plus aria-hidden />
              Add location
            </Button>
          ) : null
        }
      />
      <EmptyState
        icon={MapPin}
        title="No extra locations"
        description="This clinic operates from a single site."
      />
    </Panel>
  );
}
