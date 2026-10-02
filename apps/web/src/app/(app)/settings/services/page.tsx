'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, Plus } from 'lucide-react';
import type { SaveServiceItem, ServiceItem } from '@emr/contracts';
import { ApiError, api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { useCan } from '@/lib/session';
import { formatPaise } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { DataState } from '@/components/ui/data-state';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Services and fees.
 *
 * What a clinic charges for, what it costs, and how long a slot it books. The
 * duration is the part people forget: it is what makes a new consultation take a
 * twenty-minute slot and a follow-up take ten, so the appointment book stops
 * pretending every visit is the same length.
 *
 * Services are RETIRED, never deleted. Invoices raised last year reference them
 * by id and have to keep resolving to a name.
 */
const GST_RATES = [0, 500, 1200, 1800] as const;

export default function ServicesSettingsPage() {
  const canEdit = useCan('clinic:update');
  const [editing, setEditing] = React.useState<ServiceItem | 'new' | null>(null);

  const services = useQuery({
    queryKey: qk.services,
    queryFn: () => api.get<{ items: ServiceItem[] }>('/services'),
    select: (data) => data.items,
  });

  return (
    <>
      <Panel>
        <PanelHeader
          title="Services and fees"
          description="Billable items, their default fee, and how long a slot they book."
          actions={
            canEdit ? (
              <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
                <Plus aria-hidden />
                Add service
              </Button>
            ) : null
          }
        />
        <PanelBody>
          <DataState
            query={services}
            empty={{
              icon: Banknote,
              title: 'No services defined',
              description:
                'Add the consultation types this clinic charges for. Reception picks from this list when raising an invoice.',
              action: canEdit ? (
                <Button variant="primary" onClick={() => setEditing('new')}>
                  Add service
                </Button>
              ) : undefined,
            }}
          >
            {(items) => (
              <ul className="divide-y divide-line-soft">
                {items.map((service) => (
                  <li
                    key={service.id}
                    className="flex flex-wrap items-center gap-3 py-2.5 first:pt-0 last:pb-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-ink">{service.name}</span>
                        {service.code ? (
                          <span className="token text-2xs text-ink-faint">{service.code}</span>
                        ) : null}
                        {service.defaultDurationMinutes ? (
                          <Badge tone="info">{service.defaultDurationMinutes} min</Badge>
                        ) : null}
                        {!service.isActive ? <Badge>Retired</Badge> : null}
                      </div>
                      {service.description ? (
                        <p className="mt-0.5 text-2xs text-ink-faint">{service.description}</p>
                      ) : null}
                    </div>

                    <div className="text-right">
                      <p className="tabular text-sm font-semibold text-ink">
                        {formatPaise(service.defaultFeePaise)}
                      </p>
                      <p className="text-2xs text-ink-faint">
                        {service.taxRateBps > 0 ? `+${service.taxRateBps / 100}% tax` : 'no tax'}
                      </p>
                    </div>

                    {canEdit ? (
                      <Button size="sm" variant="secondary" onClick={() => setEditing(service)}>
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

      <ServiceDialog service={editing} onClose={() => setEditing(null)} />
    </>
  );
}

function ServiceDialog({
  service,
  onClose,
}: {
  service: ServiceItem | 'new' | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const existing = service !== 'new' && service !== null ? service : null;

  const save = useMutation({
    mutationFn: (input: SaveServiceItem) => api.post('/services', input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.services });
      toast.success('Service saved');
      onClose();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'That did not save'),
  });

  const blank = {
    name: '',
    code: '',
    description: '',
    rupees: '',
    hsnSacCode: '',
    taxRateBps: 0,
    defaultDurationMinutes: '',
    isActive: true,
    displayOrder: '0',
  };

  const [form, setForm] = React.useState(blank);

  React.useEffect(() => {
    if (!service) return;
    if (service === 'new') {
      setForm(blank);
      return;
    }
    setForm({
      name: service.name,
      code: service.code ?? '',
      description: service.description ?? '',
      rupees: String(service.defaultFeePaise / 100),
      hsnSacCode: service.hsnSacCode ?? '',
      taxRateBps: service.taxRateBps,
      defaultDurationMinutes:
        service.defaultDurationMinutes === null ? '' : String(service.defaultDurationMinutes),
      isActive: service.isActive,
      displayOrder: String(service.displayOrder),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service]);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <Dialog open={service !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? `Edit ${existing.name}` : 'New service'}</DialogTitle>
        </DialogHeader>

        <Field
          label="Name"
          htmlFor="svc-name"
          required
          hint="As it should read on an invoice."
        >
          <Input
            id="svc-name"
            value={form.name}
            onChange={(event) => set({ name: event.target.value })}
            placeholder="New consultation"
          />
        </Field>

        <Field label="Description" htmlFor="svc-desc">
          <Input
            id="svc-desc"
            value={form.description}
            onChange={(event) => set({ description: event.target.value })}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Fee (₹)" htmlFor="svc-fee" required>
            <Input
              id="svc-fee"
              type="number"
              min={0}
              step="0.01"
              value={form.rupees}
              onChange={(event) => set({ rupees: event.target.value })}
            />
          </Field>
          <Field label="Tax rate" htmlFor="svc-tax">
            <Select
              id="svc-tax"
              value={String(form.taxRateBps)}
              onChange={(event) => set({ taxRateBps: Number(event.target.value) })}
            >
              {GST_RATES.map((bps) => (
                <option key={bps} value={bps}>
                  {bps / 100}%
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Slot length (min)"
            htmlFor="svc-duration"
            hint="Blank uses the clinic default."
          >
            <Input
              id="svc-duration"
              type="number"
              min={1}
              max={480}
              value={form.defaultDurationMinutes}
              onChange={(event) => set({ defaultDurationMinutes: event.target.value })}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Code" htmlFor="svc-code" hint="Your own reference.">
            <Input
              id="svc-code"
              value={form.code}
              onChange={(event) => set({ code: event.target.value })}
            />
          </Field>
          <Field label="HSN / SAC" htmlFor="svc-hsn" hint="Needed on a GST invoice.">
            <Input
              id="svc-hsn"
              value={form.hsnSacCode}
              onChange={(event) => set({ hsnSacCode: event.target.value })}
            />
          </Field>
          <Field label="Order" htmlFor="svc-order" hint="Lower appears first.">
            <Input
              id="svc-order"
              type="number"
              min={0}
              value={form.displayOrder}
              onChange={(event) => set({ displayOrder: event.target.value })}
            />
          </Field>
        </div>

        {existing ? (
          <label className="flex items-start gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.isActive}
              onChange={(event) => set({ isActive: event.target.checked })}
            />
            <span>
              Still offered
              <span className="block text-2xs text-ink-faint">
                Unticking retires it. Past invoices keep naming it — that is why it is
                retired rather than deleted.
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
            disabled={form.name.trim().length < 2 || form.rupees === ''}
            loading={save.isPending}
            onClick={() =>
              save.mutate({
                id: existing?.id,
                name: form.name.trim(),
                code: form.code || null,
                description: form.description || null,
                // Entered in rupees, stored in paise. Money is never a float.
                defaultFeePaise: Math.round(Number(form.rupees) * 100),
                hsnSacCode: form.hsnSacCode || null,
                taxRateBps: form.taxRateBps,
                defaultDurationMinutes: form.defaultDurationMinutes
                  ? Number(form.defaultDurationMinutes)
                  : null,
                practitionerId: null,
                isActive: form.isActive,
                displayOrder: Number(form.displayOrder || 0),
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
