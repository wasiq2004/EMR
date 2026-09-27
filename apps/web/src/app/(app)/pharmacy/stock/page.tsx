'use client';

import * as React from 'react';
import { Boxes, History, Plus } from 'lucide-react';
import { STOCK_MOVEMENT_LABEL, type StockBatch } from '@emr/contracts';
import {
  useAdjustStock,
  useOpeningBalance,
  useProducts,
  useStockBatches,
  useStockMovements,
} from '@/features/pharmacy/api';
import { ApiError } from '@/lib/api-client';
import { formatDate, formatDateTime, formatPaise } from '@/lib/format';
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
 * Inventory, by batch.
 *
 * BATCH LEVEL, NOT PRODUCT LEVEL, because expiry belongs to the batch and expiry is
 * what makes pharmacy stock different from any other inventory — the value goes to
 * zero on a known date.
 *
 * Nearest expiry first, always. It is the order stock should leave the shelf in, and
 * sorting alphabetically would hide the batch that is about to become a write-off.
 *
 * Every row opens its own ledger. "Why is the count wrong" is answerable only if
 * every movement is visible, and `stock_movement` is append-only precisely so that
 * this history cannot be tidied up after the fact.
 */
export default function StockPage() {
  const [search, setSearch] = React.useState('');
  const [includeEmpty, setIncludeEmpty] = React.useState(false);
  const [ledgerFor, setLedgerFor] = React.useState<StockBatch | null>(null);
  const [openingOpen, setOpeningOpen] = React.useState(false);
  const [adjustFor, setAdjustFor] = React.useState<StockBatch | null>(null);

  const batches = useStockBatches({ search: search || undefined, includeEmpty });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Inventory"
        description="Nearest expiry first — the order stock should leave the shelf in."
        actions={
          <Button variant="secondary" onClick={() => setOpeningOpen(true)}>
            <Plus aria-hidden />
            Record opening stock
          </Button>
        }
      />

      <Panel>
        <PanelHeader
          title="Batches"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="Search products"
                placeholder="Search a product…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="w-48"
              />
              <label className="flex items-center gap-1.5 text-xs text-ink-soft">
                <input
                  type="checkbox"
                  checked={includeEmpty}
                  onChange={(event) => setIncludeEmpty(event.target.checked)}
                />
                Include empty
              </label>
            </div>
          }
        />
        <PanelBody>
          <DataState
            query={batches}
            empty={{
              icon: Boxes,
              title: search ? 'Nothing matches that' : 'No stock recorded yet',
              description: search
                ? undefined
                : 'Receive a delivery, or record what is already on the shelf as opening stock.',
              action: search ? undefined : (
                <Button variant="primary" onClick={() => setOpeningOpen(true)}>
                  Record opening stock
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
                      <TH>Batch</TH>
                      <TH>Expires</TH>
                      <TH align="right">On hand</TH>
                      <TH align="right">Cost</TH>
                      <TH align="right">MRP</TH>
                      <TH>Supplier</TH>
                      <TH />
                    </TR>
                  </THead>
                  <TBody>
                    {items.map((batch) => (
                      <TR key={batch.id}>
                        <TD>{batch.productName}</TD>
                        <TD className="token">{batch.batchNumber}</TD>
                        <TD>
                          {batch.isExpired ? (
                            <Badge tone="critical">Expired {formatDate(batch.expiryDate)}</Badge>
                          ) : batch.daysToExpiry <= 90 ? (
                            <Badge tone="warning">
                              {formatDate(batch.expiryDate)} · {batch.daysToExpiry}d
                            </Badge>
                          ) : (
                            formatDate(batch.expiryDate)
                          )}
                        </TD>
                        <TD align="right" className="tabular font-semibold">
                          {batch.quantityOnHand}
                        </TD>
                        <TD align="right" className="tabular text-ink-faint">
                          {formatPaise(batch.unitCostPaise)}
                        </TD>
                        <TD align="right" className="tabular">
                          {batch.mrpPaise === null ? '—' : formatPaise(batch.mrpPaise)}
                        </TD>
                        <TD className="text-ink-faint">{batch.supplierName ?? '—'}</TD>
                        <TD align="right">
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setLedgerFor(batch)}
                              aria-label={`Movement history for ${batch.batchNumber}`}
                            >
                              <History aria-hidden />
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setAdjustFor(batch)}>
                              Adjust
                            </Button>
                          </div>
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

      <LedgerDialog batch={ledgerFor} onClose={() => setLedgerFor(null)} />
      <AdjustDialog batch={adjustFor} onClose={() => setAdjustFor(null)} />
      <OpeningDialog open={openingOpen} onOpenChange={setOpeningOpen} />
    </div>
  );
}

/** The append-only history for one batch. */
function LedgerDialog({ batch, onClose }: { batch: StockBatch | null; onClose: () => void }) {
  const movements = useStockMovements({ stockBatchId: batch?.id });

  return (
    <Dialog open={batch !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {batch?.productName} · batch {batch?.batchNumber}
          </DialogTitle>
        </DialogHeader>

        <Alert tone="info" title="This history cannot be edited">
          Every movement is appended and never changed. A correction is a new
          adjustment with a reason, so the count on the shelf and the history of how
          it got there are both recoverable.
        </Alert>

        <DataState
          query={movements}
          empty={{ title: 'No movements recorded' }}
          skeletonRows={4}
        >
          {(items) => (
            <TableScroller className="max-h-80">
              <Table>
                <THead>
                  <TR>
                    <TH>When</TH>
                    <TH>What</TH>
                    <TH align="right">Change</TH>
                    <TH align="right">Balance</TH>
                    <TH>Who</TH>
                  </TR>
                </THead>
                <TBody>
                  {items.map((move) => (
                    <TR key={move.id}>
                      <TD className="whitespace-nowrap text-ink-faint">
                        {formatDateTime(move.occurredAt)}
                      </TD>
                      <TD>
                        {STOCK_MOVEMENT_LABEL[move.movementType]}
                        {move.reason ? (
                          <span className="block text-2xs text-ink-faint">{move.reason}</span>
                        ) : null}
                      </TD>
                      <TD
                        align="right"
                        className={
                          move.quantityDelta > 0
                            ? 'tabular font-semibold text-positive'
                            : 'tabular font-semibold text-critical'
                        }
                      >
                        {move.quantityDelta > 0 ? '+' : ''}
                        {move.quantityDelta}
                      </TD>
                      <TD align="right" className="tabular">
                        {move.balanceAfter}
                      </TD>
                      <TD className="text-ink-faint">{move.actorName ?? '—'}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableScroller>
          )}
        </DataState>
      </DialogContent>
    </Dialog>
  );
}

function AdjustDialog({ batch, onClose }: { batch: StockBatch | null; onClose: () => void }) {
  const toast = useToast();
  const adjust = useAdjustStock();
  const [counted, setCounted] = React.useState('');
  const [reason, setReason] = React.useState('');

  React.useEffect(() => {
    if (batch) {
      setCounted(String(batch.quantityOnHand));
      setReason('');
    }
  }, [batch]);

  /*
   * The pharmacist enters WHAT THEY COUNTED, not a delta.
   *
   * Asking for a difference makes people do arithmetic at a counter, which is where
   * the mistakes come from. The delta is derived, and it is the delta that goes in
   * the ledger.
   */
  const delta = batch ? Number(counted) - batch.quantityOnHand : 0;

  return (
    <Dialog open={batch !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Correct the count for {batch?.productName}</DialogTitle>
        </DialogHeader>

        <p className="text-xs text-ink-faint">
          Batch <span className="token">{batch?.batchNumber}</span> · system says{' '}
          <span className="tabular font-semibold text-ink">{batch?.quantityOnHand}</span>
        </p>

        <Field
          label="What you counted"
          htmlFor="counted"
          required
          hint="Enter the physical count. The difference is worked out for you."
        >
          <Input
            id="counted"
            type="number"
            min={0}
            value={counted}
            onChange={(event) => setCounted(event.target.value)}
          />
        </Field>

        {delta !== 0 ? (
          <Alert tone={delta < 0 ? 'warning' : 'info'} title={`That is a change of ${delta > 0 ? '+' : ''}${delta}`}>
            {delta < 0
              ? 'Stock will be removed. This appears in the monthly loss figure.'
              : 'Stock will be added. Check it is not an unrecorded delivery — receive that as goods instead, so the cost and supplier are captured.'}
          </Alert>
        ) : null}

        <Field
          label="Reason"
          htmlFor="adjust-reason"
          required
          hint="Say what was counted and when. Recorded in the ledger against your name."
        >
          <Input
            id="adjust-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Month-end physical count, 3 strips short"
          />
        </Field>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={delta === 0 || reason.trim().length < 8}
            loading={adjust.isPending}
            onClick={() =>
              batch &&
              adjust.mutate(
                {
                  stockBatchId: batch.id,
                  quantityDelta: delta,
                  movementType: 'ADJUSTMENT',
                  reason,
                },
                {
                  onSuccess: () => {
                    toast.success('Count corrected');
                    onClose();
                  },
                  onError: (error) =>
                    toast.error(error instanceof ApiError ? error.message : 'That did not save'),
                },
              )
            }
          >
            Record correction
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Stock already on the shelf when the module was switched on. */
function OpeningDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const opening = useOpeningBalance();
  const products = useProducts();
  const [form, setForm] = React.useState({
    productId: '',
    batchNumber: '',
    expiryDate: '',
    quantity: '',
    rupeesCost: '',
    rupeesMrp: '',
  });

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record opening stock</DialogTitle>
        </DialogHeader>

        <Alert tone="info" title="For stock that was already on the shelf">
          Recorded as an opening balance rather than a delivery, so the first month’s
          purchase figures are not inflated by stock the clinic did not buy in that
          month.
        </Alert>

        <Field label="Product" htmlFor="opening-product" required>
          <Select
            id="opening-product"
            value={form.productId}
            onChange={(event) => set({ productId: event.target.value })}
          >
            <option value="">Choose a product…</option>
            {(products.data ?? []).map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
                {product.strength ? ` ${product.strength}` : ''}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Batch number"
            htmlFor="opening-batch"
            required
            hint="From the pack. It is what connects this stock to a recall."
          >
            <Input
              id="opening-batch"
              value={form.batchNumber}
              onChange={(event) => set({ batchNumber: event.target.value })}
            />
          </Field>
          <Field label="Expiry" htmlFor="opening-expiry" required>
            <Input
              id="opening-expiry"
              type="date"
              value={form.expiryDate}
              onChange={(event) => set({ expiryDate: event.target.value })}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Quantity" htmlFor="opening-qty" required>
            <Input
              id="opening-qty"
              type="number"
              min={1}
              value={form.quantity}
              onChange={(event) => set({ quantity: event.target.value })}
            />
          </Field>
          <Field label="Cost each (₹)" htmlFor="opening-cost">
            <Input
              id="opening-cost"
              type="number"
              min={0}
              step="0.01"
              value={form.rupeesCost}
              onChange={(event) => set({ rupeesCost: event.target.value })}
            />
          </Field>
          <Field label="MRP each (₹)" htmlFor="opening-mrp">
            <Input
              id="opening-mrp"
              type="number"
              min={0}
              step="0.01"
              value={form.rupeesMrp}
              onChange={(event) => set({ rupeesMrp: event.target.value })}
            />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={opening.isPending}
            disabled={
              !form.productId || !form.batchNumber || !form.expiryDate || !form.quantity
            }
            onClick={() =>
              opening.mutate(
                {
                  productId: form.productId,
                  batchNumber: form.batchNumber,
                  expiryDate: form.expiryDate,
                  quantity: Number(form.quantity),
                  // Entered in rupees, stored in paise. Money is never a float.
                  unitCostPaise: Math.round(Number(form.rupeesCost || 0) * 100),
                  mrpPaise: form.rupeesMrp
                    ? Math.round(Number(form.rupeesMrp) * 100)
                    : null,
                },
                {
                  onSuccess: () => {
                    toast.success('Opening stock recorded');
                    setForm({
                      productId: '',
                      batchNumber: '',
                      expiryDate: '',
                      quantity: '',
                      rupeesCost: '',
                      rupeesMrp: '',
                    });
                    onOpenChange(false);
                  },
                  onError: (error) =>
                    toast.error(error instanceof ApiError ? error.message : 'That did not save'),
                },
              )
            }
          >
            Record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
