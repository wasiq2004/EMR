'use client';

import * as React from 'react';
import { Plus, Truck } from 'lucide-react';
import type { Supplier } from '@emr/contracts';
import { useSaveSupplier, useSuppliers } from '@/features/pharmacy/api';
import { ApiError } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { DataState } from '@/components/ui/data-state';
import { PageHeader, Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Table, TBody, TD, TH, THead, TR, TableScroller } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Suppliers.
 *
 * Never deleted, only deactivated: last year's goods receipt has to still name who
 * it came from, and a clinic that stops using a distributor still needs its
 * purchase history to read correctly.
 *
 * GSTIN is optional on purpose. A clinic buying from an unregistered local
 * distributor has none to give, and refusing the supplier over it would mean the
 * purchase is recorded nowhere — which is worse than an incomplete record.
 */
export default function SuppliersPage() {
  const [editing, setEditing] = React.useState<Supplier | 'new' | null>(null);
  const suppliers = useSuppliers(true);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Suppliers"
        description="Who the pharmacy buys from."
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus aria-hidden />
            New supplier
          </Button>
        }
      />

      <Panel>
        <PanelHeader title="All suppliers" />
        <PanelBody>
          <DataState
            query={suppliers}
            empty={{
              icon: Truck,
              title: 'No suppliers yet',
              description: 'Add one before raising a purchase order.',
              action: (
                <Button variant="primary" onClick={() => setEditing('new')}>
                  New supplier
                </Button>
              ),
            }}
          >
            {(items) => (
              <TableScroller>
                <Table>
                  <THead>
                    <TR>
                      <TH>Name</TH>
                      <TH>Contact</TH>
                      <TH>GSTIN</TH>
                      <TH>Where</TH>
                      <TH align="right">Terms</TH>
                      <TH align="right">Open orders</TH>
                      <TH />
                    </TR>
                  </THead>
                  <TBody>
                    {items.map((supplier) => (
                      <TR key={supplier.id} className={supplier.isActive ? undefined : 'opacity-60'}>
                        <TD>
                          <span className="font-medium text-ink">{supplier.name}</span>
                          {!supplier.isActive ? (
                            <Badge className="ml-1.5">Inactive</Badge>
                          ) : null}
                          {supplier.drugLicenceNumber ? (
                            <span className="block text-2xs text-ink-faint">
                              Licence {supplier.drugLicenceNumber}
                            </span>
                          ) : null}
                        </TD>
                        <TD className="text-ink-soft">
                          {supplier.contactPerson ?? '—'}
                          {supplier.phoneE164 ? (
                            <span className="token block text-2xs text-ink-faint">
                              {supplier.phoneE164}
                            </span>
                          ) : null}
                        </TD>
                        <TD className="token text-xs">{supplier.gstin ?? '—'}</TD>
                        <TD className="text-ink-soft">
                          {[supplier.city, supplier.state].filter(Boolean).join(', ') || '—'}
                        </TD>
                        <TD align="right" className="tabular">
                          {supplier.paymentTermsDays === null
                            ? '—'
                            : `${supplier.paymentTermsDays}d`}
                        </TD>
                        <TD align="right" className="tabular">
                          {supplier.openOrderCount ? (
                            <Badge tone="info">{supplier.openOrderCount}</Badge>
                          ) : (
                            <span className="text-ink-faint">—</span>
                          )}
                        </TD>
                        <TD align="right">
                          <Button size="sm" variant="ghost" onClick={() => setEditing(supplier)}>
                            Edit
                          </Button>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableScroller>
            )}
          </DataState>
        </PanelBody>
      </Panel>

      <SupplierDialog supplier={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function SupplierDialog({
  supplier,
  onClose,
}: {
  supplier: Supplier | 'new' | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const save = useSaveSupplier();
  const existing = supplier !== 'new' && supplier !== null ? supplier : null;

  const blank = {
    name: '',
    gstin: '',
    drugLicenceNumber: '',
    contactPerson: '',
    phoneE164: '',
    email: '',
    addressLine1: '',
    city: '',
    state: '',
    pincode: '',
    paymentTermsDays: '',
    notes: '',
    isActive: true,
  };
  const [form, setForm] = React.useState(blank);

  React.useEffect(() => {
    if (!supplier) return;
    if (supplier === 'new') {
      setForm(blank);
      return;
    }
    setForm({
      name: supplier.name,
      gstin: supplier.gstin ?? '',
      drugLicenceNumber: supplier.drugLicenceNumber ?? '',
      contactPerson: supplier.contactPerson ?? '',
      phoneE164: supplier.phoneE164 ?? '',
      email: supplier.email ?? '',
      addressLine1: supplier.addressLine1 ?? '',
      city: supplier.city ?? '',
      state: supplier.state ?? '',
      pincode: supplier.pincode ?? '',
      paymentTermsDays:
        supplier.paymentTermsDays === null ? '' : String(supplier.paymentTermsDays),
      notes: supplier.notes ?? '',
      isActive: supplier.isActive,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplier]);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <Dialog open={supplier !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? `Edit ${existing.name}` : 'New supplier'}</DialogTitle>
        </DialogHeader>

        <Field label="Name" htmlFor="supplier-name" required>
          <Input
            id="supplier-name"
            value={form.name}
            onChange={(event) => set({ name: event.target.value })}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="GSTIN"
            htmlFor="supplier-gstin"
            hint="Fifteen characters. Leave blank for an unregistered distributor."
          >
            <Input
              id="supplier-gstin"
              value={form.gstin}
              onChange={(event) => set({ gstin: event.target.value.toUpperCase() })}
            />
          </Field>
          <Field label="Drug licence number" htmlFor="supplier-licence">
            <Input
              id="supplier-licence"
              value={form.drugLicenceNumber}
              onChange={(event) => set({ drugLicenceNumber: event.target.value })}
            />
          </Field>
          <Field label="Contact person" htmlFor="supplier-contact">
            <Input
              id="supplier-contact"
              value={form.contactPerson}
              onChange={(event) => set({ contactPerson: event.target.value })}
            />
          </Field>
          <Field label="Phone" htmlFor="supplier-phone">
            <Input
              id="supplier-phone"
              value={form.phoneE164}
              onChange={(event) => set({ phoneE164: event.target.value })}
              placeholder="+919876543210"
            />
          </Field>
          <Field label="Email" htmlFor="supplier-email">
            <Input
              id="supplier-email"
              type="email"
              value={form.email}
              onChange={(event) => set({ email: event.target.value })}
            />
          </Field>
          <Field
            label="Payment terms (days)"
            htmlFor="supplier-terms"
            hint="Shown on the order. Drives nothing automatically."
          >
            <Input
              id="supplier-terms"
              type="number"
              min={0}
              value={form.paymentTermsDays}
              onChange={(event) => set({ paymentTermsDays: event.target.value })}
            />
          </Field>
        </div>

        <Field label="Address" htmlFor="supplier-address">
          <Input
            id="supplier-address"
            value={form.addressLine1}
            onChange={(event) => set({ addressLine1: event.target.value })}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="City" htmlFor="supplier-city">
            <Input
              id="supplier-city"
              value={form.city}
              onChange={(event) => set({ city: event.target.value })}
            />
          </Field>
          <Field label="State" htmlFor="supplier-state">
            <Input
              id="supplier-state"
              value={form.state}
              onChange={(event) => set({ state: event.target.value })}
            />
          </Field>
          <Field label="PIN code" htmlFor="supplier-pin">
            <Input
              id="supplier-pin"
              value={form.pincode}
              onChange={(event) => set({ pincode: event.target.value })}
            />
          </Field>
        </div>

        {existing ? (
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(event) => set({ isActive: event.target.checked })}
            />
            Still buying from this supplier
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
              save.mutate(
                {
                  id: existing?.id,
                  name: form.name,
                  gstin: form.gstin || null,
                  drugLicenceNumber: form.drugLicenceNumber || null,
                  contactPerson: form.contactPerson || null,
                  phoneE164: form.phoneE164 || null,
                  email: form.email || null,
                  addressLine1: form.addressLine1 || null,
                  city: form.city || null,
                  state: form.state || null,
                  pincode: form.pincode || null,
                  paymentTermsDays: form.paymentTermsDays
                    ? Number(form.paymentTermsDays)
                    : null,
                  notes: form.notes || null,
                  isActive: form.isActive,
                },
                {
                  onSuccess: () => {
                    toast.success('Supplier saved');
                    onClose();
                  },
                  onError: (error) =>
                    toast.error(
                      error instanceof ApiError ? error.message : 'That did not save',
                    ),
                },
              )
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
