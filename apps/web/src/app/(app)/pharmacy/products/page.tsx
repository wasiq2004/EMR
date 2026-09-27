'use client';

import * as React from 'react';
import { ClipboardCheck, Plus } from 'lucide-react';
import { GST_RATES_BPS, type PharmacyProduct } from '@emr/contracts';
import {
  useProducts,
  useRetireProduct,
  useSaveProduct,
  useUnstockedCatalogue,
} from '@/features/pharmacy/api';
import { ApiError } from '@/lib/api-client';
import { formatDate, formatPaise } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { DataState } from '@/components/ui/data-state';
import { Alert } from '@/components/ui/feedback';
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
 * What the pharmacy sells.
 *
 * A product is not the same thing as a drug-catalogue entry: the catalogue is what a
 * doctor prescribes from (a molecule, a strength, a form), and a product is what the
 * counter sells (a pack of a particular brand, with an MRP and a GST rate). One
 * prescription can be filled from any of several products.
 *
 * ADDING FROM THE CATALOGUE is the answer to the setup burden the blueprint's risk
 * register names. A clinic already prescribing forty molecules should be able to
 * stock them without retyping any of it.
 */
export default function ProductsPage() {
  const [search, setSearch] = React.useState('');
  const [editing, setEditing] = React.useState<PharmacyProduct | 'new' | null>(null);
  const [fromCatalogue, setFromCatalogue] = React.useState(false);

  const products = useProducts({ search: search || undefined, includeInactive: true });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Products"
        description="What the counter sells, mapped to what doctors prescribe."
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setFromCatalogue(true)}>
              Add from drug catalogue
            </Button>
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus aria-hidden />
              New product
            </Button>
          </div>
        }
      />

      <Panel>
        <PanelHeader
          title="Catalogue"
          actions={
            <Input
              aria-label="Search products"
              placeholder="Search…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="w-48"
            />
          }
        />
        <PanelBody>
          <DataState
            query={products}
            empty={{
              icon: ClipboardCheck,
              title: search ? 'Nothing matches that' : 'No products yet',
              description: search
                ? undefined
                : 'Add what the counter stocks. Pulling from the drug catalogue is the quickest way in.',
              action: search ? undefined : (
                <Button variant="primary" onClick={() => setFromCatalogue(true)}>
                  Add from drug catalogue
                </Button>
              ),
            }}
          >
            {(items) => (
              <TableScroller>
                <Table>
                  <THead>
                    <TR>
                      <TH>Product</TH>
                      <TH>Molecule</TH>
                      <TH align="right">On hand</TH>
                      <TH>Earliest expiry</TH>
                      <TH align="right">MRP</TH>
                      <TH align="right">GST</TH>
                      <TH>Flags</TH>
                      <TH />
                    </TR>
                  </THead>
                  <TBody>
                    {items.map((product) => (
                      <TR key={product.id} className={product.isActive ? undefined : 'opacity-60'}>
                        <TD>
                          <span className="font-medium text-ink">{product.name}</span>
                          {product.strength ? (
                            <span className="token ml-1.5 text-2xs text-ink-soft">
                              {product.strength}
                            </span>
                          ) : null}
                          {product.dosageForm ? (
                            <span className="block text-2xs text-ink-faint">
                              {product.dosageForm}
                              {product.packSize > 1
                                ? ` · pack of ${product.packSize} ${product.packUnit}`
                                : ''}
                            </span>
                          ) : null}
                        </TD>
                        <TD className="text-ink-soft">{product.moleculeName ?? '—'}</TD>
                        <TD align="right" className="tabular font-semibold">
                          {product.quantityOnHand ?? 0}
                          {product.reorderLevel !== null &&
                          (product.quantityOnHand ?? 0) <= product.reorderLevel ? (
                            <Badge tone="warning" className="ml-1.5">
                              low
                            </Badge>
                          ) : null}
                        </TD>
                        <TD>
                          {product.earliestExpiry ? formatDate(product.earliestExpiry) : '—'}
                        </TD>
                        <TD align="right" className="tabular">
                          {product.mrpPaise === null ? '—' : formatPaise(product.mrpPaise)}
                        </TD>
                        <TD align="right" className="tabular text-ink-faint">
                          {product.gstRateBps / 100}%
                        </TD>
                        <TD>
                          <div className="flex flex-wrap gap-1">
                            {product.requiresPrescription ? (
                              <Badge tone="warning">Rx only</Badge>
                            ) : null}
                            {product.drugSchedule ? (
                              <Badge tone="critical">Sch {product.drugSchedule}</Badge>
                            ) : null}
                            {!product.isActive ? <Badge>Retired</Badge> : null}
                          </div>
                        </TD>
                        <TD align="right">
                          <Button size="sm" variant="ghost" onClick={() => setEditing(product)}>
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

      <ProductDialog product={editing} onClose={() => setEditing(null)} />
      <FromCatalogueDialog
        open={fromCatalogue}
        onOpenChange={setFromCatalogue}
        onPicked={(seed) => {
          setFromCatalogue(false);
          setEditing(seed);
        }}
      />
    </div>
  );
}

function ProductDialog({
  product,
  onClose,
}: {
  product: PharmacyProduct | 'new' | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const save = useSaveProduct();
  const retire = useRetireProduct();

  const existing = product !== 'new' && product !== null ? product : null;

  const [form, setForm] = React.useState({
    name: '',
    brandName: '',
    moleculeName: '',
    manufacturer: '',
    strength: '',
    dosageForm: '',
    hsnCode: '',
    gstRateBps: 1200,
    packSize: 1,
    packUnit: 'unit',
    rupeesMrp: '',
    reorderLevel: '',
    reorderQuantity: '',
    drugSchedule: '',
    requiresPrescription: false,
    catalogueItemId: null as string | null,
  });

  React.useEffect(() => {
    if (!product) return;
    if (product === 'new') {
      setForm({
        name: '',
        brandName: '',
        moleculeName: '',
        manufacturer: '',
        strength: '',
        dosageForm: '',
        hsnCode: '',
        gstRateBps: 1200,
        packSize: 1,
        packUnit: 'unit',
        rupeesMrp: '',
        reorderLevel: '',
        reorderQuantity: '',
        drugSchedule: '',
        requiresPrescription: false,
        catalogueItemId: null,
      });
      return;
    }
    setForm({
      name: product.name,
      brandName: product.brandName ?? '',
      moleculeName: product.moleculeName ?? '',
      manufacturer: product.manufacturer ?? '',
      strength: product.strength ?? '',
      dosageForm: product.dosageForm ?? '',
      hsnCode: product.hsnCode ?? '',
      gstRateBps: product.gstRateBps,
      packSize: product.packSize,
      packUnit: product.packUnit,
      rupeesMrp: product.mrpPaise === null ? '' : String(product.mrpPaise / 100),
      reorderLevel: product.reorderLevel === null ? '' : String(product.reorderLevel),
      reorderQuantity:
        product.reorderQuantity === null ? '' : String(product.reorderQuantity),
      drugSchedule: product.drugSchedule ?? '',
      requiresPrescription: product.requiresPrescription,
      catalogueItemId: product.catalogueItemId,
    });
  }, [product]);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <Dialog open={product !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? `Edit ${existing.name}` : 'New product'}</DialogTitle>
        </DialogHeader>

        <Field
          label="Name as printed on the box"
          htmlFor="product-name"
          required
          hint="What a pharmacist will search for."
        >
          <Input
            id="product-name"
            value={form.name}
            onChange={(event) => set({ name: event.target.value })}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Brand" htmlFor="product-brand">
            <Input
              id="product-brand"
              value={form.brandName}
              onChange={(event) => set({ brandName: event.target.value })}
            />
          </Field>
          <Field
            label="Molecule"
            htmlFor="product-molecule"
            hint="What makes this fillable against a prescription. Leave blank for a non-drug item."
          >
            <Input
              id="product-molecule"
              value={form.moleculeName}
              onChange={(event) => set({ moleculeName: event.target.value })}
            />
          </Field>
          <Field label="Strength" htmlFor="product-strength">
            <Input
              id="product-strength"
              value={form.strength}
              onChange={(event) => set({ strength: event.target.value })}
              placeholder="500 mg"
            />
          </Field>
          <Field label="Form" htmlFor="product-form">
            <Input
              id="product-form"
              value={form.dosageForm}
              onChange={(event) => set({ dosageForm: event.target.value })}
              placeholder="Tablet"
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Pack size" htmlFor="product-pack" required>
            <Input
              id="product-pack"
              type="number"
              min={1}
              value={form.packSize}
              onChange={(event) => set({ packSize: Number(event.target.value) })}
            />
          </Field>
          <Field label="Unit" htmlFor="product-unit" hint="tablet, ml, strip">
            <Input
              id="product-unit"
              value={form.packUnit}
              onChange={(event) => set({ packUnit: event.target.value })}
            />
          </Field>
          <Field label="MRP (₹)" htmlFor="product-mrp" hint="The ceiling a sale may charge.">
            <Input
              id="product-mrp"
              type="number"
              min={0}
              step="0.01"
              value={form.rupeesMrp}
              onChange={(event) => set({ rupeesMrp: event.target.value })}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="GST rate" htmlFor="product-gst" required>
            <Select
              id="product-gst"
              value={String(form.gstRateBps)}
              onChange={(event) => set({ gstRateBps: Number(event.target.value) })}
            >
              {GST_RATES_BPS.map((bps) => (
                <option key={bps} value={bps}>
                  {bps / 100}%
                </option>
              ))}
            </Select>
          </Field>
          <Field label="HSN code" htmlFor="product-hsn" hint="Needed on a GST invoice.">
            <Input
              id="product-hsn"
              value={form.hsnCode}
              onChange={(event) => set({ hsnCode: event.target.value })}
            />
          </Field>
          <Field
            label="Drug schedule"
            htmlFor="product-schedule"
            hint="H, H1 or X. Setting it forces prescription-only."
          >
            <Input
              id="product-schedule"
              value={form.drugSchedule}
              onChange={(event) => set({ drugSchedule: event.target.value })}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Reorder level"
            htmlFor="product-reorder-level"
            hint="Below this, it appears on the alert board."
          >
            <Input
              id="product-reorder-level"
              type="number"
              min={0}
              value={form.reorderLevel}
              onChange={(event) => set({ reorderLevel: event.target.value })}
            />
          </Field>
          <Field label="Reorder quantity" htmlFor="product-reorder-qty">
            <Input
              id="product-reorder-qty"
              type="number"
              min={1}
              value={form.reorderQuantity}
              onChange={(event) => set({ reorderQuantity: event.target.value })}
            />
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={form.requiresPrescription || Boolean(form.drugSchedule)}
            disabled={Boolean(form.drugSchedule)}
            onChange={(event) => set({ requiresPrescription: event.target.checked })}
          />
          Cannot be sold over the counter
        </label>

        {form.drugSchedule ? (
          <Alert tone="warning" title="Scheduled drugs are always prescription-only">
            A schedule is set, so this is enforced whether or not the box above is
            ticked. The counter will refuse an over-the-counter sale of it.
          </Alert>
        ) : null}

        <DialogFooter>
          {existing ? (
            <Button
              variant="ghost"
              loading={retire.isPending}
              onClick={() =>
                retire.mutate(existing.id, {
                  onSuccess: () => {
                    toast.success('Product retired');
                    onClose();
                  },
                  onError: (error) =>
                    toast.error(
                      error instanceof ApiError ? error.message : 'That did not save',
                    ),
                })
              }
            >
              Retire
            </Button>
          ) : null}
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
                  catalogueItemId: form.catalogueItemId,
                  name: form.name,
                  brandName: form.brandName || null,
                  moleculeName: form.moleculeName || null,
                  manufacturer: form.manufacturer || null,
                  strength: form.strength || null,
                  dosageForm: form.dosageForm || null,
                  hsnCode: form.hsnCode || null,
                  gstRateBps: form.gstRateBps,
                  packSize: form.packSize,
                  packUnit: form.packUnit,
                  mrpPaise: form.rupeesMrp ? Math.round(Number(form.rupeesMrp) * 100) : null,
                  reorderLevel: form.reorderLevel ? Number(form.reorderLevel) : null,
                  reorderQuantity: form.reorderQuantity
                    ? Number(form.reorderQuantity)
                    : null,
                  drugSchedule: form.drugSchedule || null,
                  requiresPrescription: form.requiresPrescription,
                  isNarcotic: false,
                  isActive: existing ? existing.isActive : true,
                },
                {
                  onSuccess: () => {
                    toast.success('Product saved');
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

/** Drug-catalogue entries not yet stocked, so nothing is retyped. */
function FromCatalogueDialog({
  open,
  onOpenChange,
  onPicked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPicked: (seed: PharmacyProduct) => void;
}) {
  const [search, setSearch] = React.useState('');
  const catalogue = useUnstockedCatalogue(search, open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add from the drug catalogue</DialogTitle>
        </DialogHeader>

        <Alert tone="info" title="Only what is not already stocked">
          These are molecules your doctors can prescribe and the counter does not yet
          stock. Picking one carries its molecule, strength and form across.
        </Alert>

        <Field label="Search" htmlFor="catalogue-search">
          <Input
            id="catalogue-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="amoxicillin"
          />
        </Field>

        <DataState
          query={catalogue}
          empty={{ title: 'Nothing left to add', description: 'Every catalogue entry is stocked.' }}
          skeletonRows={4}
        >
          {(items) => (
            <div className="max-h-72 space-y-1.5 overflow-y-auto scroll-thin">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="w-full rounded-md border border-line bg-surface px-2.5 py-2 text-left hover:bg-surface-sunk"
                  onClick={() =>
                    onPicked({
                      id: '',
                      catalogueItemId: item.id,
                      name: [item.brandName ?? item.moleculeName, item.strength]
                        .filter(Boolean)
                        .join(' '),
                      brandName: item.brandName,
                      moleculeName: item.moleculeName,
                      manufacturer: item.manufacturer,
                      strength: item.strength,
                      dosageForm: item.dosageForm,
                      hsnCode: null,
                      gstRateBps: 1200,
                      packSize: 1,
                      packUnit: 'unit',
                      mrpPaise: null,
                      reorderLevel: null,
                      reorderQuantity: null,
                      drugSchedule: item.drugSchedule,
                      requiresPrescription: Boolean(item.drugSchedule),
                      isNarcotic: false,
                      isActive: true,
                    } as PharmacyProduct)
                  }
                >
                  <span className="text-sm font-medium text-ink">
                    {item.brandName ?? item.moleculeName}
                  </span>
                  <span className="block text-2xs text-ink-faint">
                    {[item.moleculeName, item.strength, item.dosageForm, item.manufacturer]
                      .filter(Boolean)
                      .join(' · ')}
                    {item.drugSchedule ? ` · Schedule ${item.drugSchedule}` : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
        </DataState>
      </DialogContent>
    </Dialog>
  );
}
