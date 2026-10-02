'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus } from 'lucide-react';
import type { SaveLocation } from '@emr/contracts';
import { ApiError, api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { useCan } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { DataState } from '@/components/ui/data-state';
import { Alert } from '@/components/ui/feedback';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface ClinicLocation {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  pincode: string | null;
  isPrimary: boolean;
  isActive: boolean;
}

/**
 * Locations.
 *
 * A location is a name and where it is — nothing more. The street address and the
 * phone number belong to the clinic itself; duplicating them per location would
 * give a clinic two addresses that can disagree, and nothing downstream would know
 * which one to print on a prescription.
 *
 * EXACTLY ONE IS PRIMARY. Promoting one demotes the rest, in the same transaction
 * server-side, because two primaries is a state nothing knows how to read.
 */
export default function LocationsSettingsPage() {
  const canEdit = useCan('clinic:update');
  const [editing, setEditing] = React.useState<ClinicLocation | 'new' | null>(null);

  const locations = useQuery({
    queryKey: qk.locations,
    queryFn: () => api.get<{ items: ClinicLocation[] }>('/locations'),
    select: (data) => data.items,
  });

  const active = (locations.data ?? []).filter((l) => l.isActive);
  const noPrimary = active.length > 0 && !active.some((l) => l.isPrimary);

  return (
    <div className="flex flex-col gap-4">
      {noPrimary ? (
        <Alert tone="warning" title="No primary location">
          One location should be marked primary — it is the one used where a single
          address is needed, such as the letterhead on a printed prescription.
        </Alert>
      ) : null}

      <Panel>
        <PanelHeader
          title="Locations"
          description="Where this clinic operates. Most clinics have one."
          actions={
            canEdit ? (
              <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
                <Plus aria-hidden />
                Add location
              </Button>
            ) : null
          }
        />
        <PanelBody>
          <DataState
            query={locations}
            empty={{
              icon: Building2,
              title: 'No locations yet',
              description:
                'Add at least one. Appointments and consultations are recorded against a location.',
              action: canEdit ? (
                <Button variant="primary" onClick={() => setEditing('new')}>
                  Add location
                </Button>
              ) : undefined,
            }}
          >
            {(items) => (
              <ul className="divide-y divide-line-soft">
                {items.map((location) => (
                  <li
                    key={location.id}
                    className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-ink">{location.name}</span>
                        {location.isPrimary ? <Badge tone="accent">Primary</Badge> : null}
                        {!location.isActive ? <Badge>Closed</Badge> : null}
                      </div>
                      <p className="mt-0.5 text-2xs text-ink-faint">
                        {[location.city, location.state, location.pincode]
                          .filter(Boolean)
                          .join(', ') || 'No address recorded'}
                      </p>
                    </div>

                    {canEdit ? (
                      <Button size="sm" variant="secondary" onClick={() => setEditing(location)}>
                        Edit
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </DataState>
        </PanelBody>
      </Panel>

      <LocationDialog
        location={editing}
        onClose={() => setEditing(null)}
        isOnlyActive={active.length === 1}
      />
    </div>
  );
}

function LocationDialog({
  location,
  onClose,
  isOnlyActive,
}: {
  location: ClinicLocation | 'new' | null;
  onClose: () => void;
  isOnlyActive: boolean;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const existing = location !== 'new' && location !== null ? location : null;

  const save = useMutation({
    mutationFn: (input: SaveLocation) => api.post('/locations', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.locations });
      toast.success('Location saved');
      onClose();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'That did not save'),
  });

  const blank = {
    name: '',
    city: '',
    state: '',
    pincode: '',
    isPrimary: false,
    isActive: true,
  };
  const [form, setForm] = React.useState(blank);

  React.useEffect(() => {
    if (!location) return;
    if (location === 'new') {
      setForm(blank);
      return;
    }
    setForm({
      name: location.name,
      city: location.city ?? '',
      state: location.state ?? '',
      pincode: location.pincode ?? '',
      isPrimary: location.isPrimary,
      isActive: location.isActive,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <Dialog open={location !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? `Edit ${existing.name}` : 'New location'}</DialogTitle>
        </DialogHeader>

        <Field
          label="Name"
          htmlFor="loc-name"
          required
          hint="What staff call it — Main Branch, Kothrud, and so on."
        >
          <Input
            id="loc-name"
            value={form.name}
            onChange={(event) => set({ name: event.target.value })}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="City" htmlFor="loc-city">
            <Input
              id="loc-city"
              value={form.city}
              onChange={(event) => set({ city: event.target.value })}
            />
          </Field>
          <Field label="State" htmlFor="loc-state">
            <Input
              id="loc-state"
              value={form.state}
              onChange={(event) => set({ state: event.target.value })}
            />
          </Field>
          <Field label="PIN code" htmlFor="loc-pin">
            <Input
              id="loc-pin"
              value={form.pincode}
              onChange={(event) => set({ pincode: event.target.value })}
            />
          </Field>
        </div>

        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.isPrimary}
            onChange={(event) => set({ isPrimary: event.target.checked })}
          />
          <span>
            Primary location
            <span className="block text-2xs text-ink-faint">
              Used where a single address is needed. Setting this unsets it on the
              others.
            </span>
          </span>
        </label>

        {existing ? (
          <label className="flex items-start gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.isActive}
              disabled={isOnlyActive && form.isActive}
              onChange={(event) => set({ isActive: event.target.checked })}
            />
            <span>
              Open
              <span className="block text-2xs text-ink-faint">
                {isOnlyActive && form.isActive
                  ? 'This is the only open location, so it cannot be closed.'
                  : 'Closing it keeps its history but stops new appointments there.'}
              </span>
            </span>
          </label>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={form.name.trim().length < 2}
            loading={save.isPending}
            onClick={() =>
              save.mutate({
                id: existing?.id,
                name: form.name.trim(),
                city: form.city || null,
                state: form.state || null,
                pincode: form.pincode || null,
                isPrimary: form.isPrimary,
                isActive: form.isActive,
              })
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
