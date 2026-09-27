'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { computeSaleTotals, type PaymentMethod } from '@emr/contracts';
import {
  useDispenseQuote,
  useProducts,
  useRecordSale,
  useSales,
  useStockBatches,
} from '@/features/pharmacy/api';
import { ApiError } from '@/lib/api-client';
import { formatDate, formatDateTime, formatPaise } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { DataState, StatRow } from '@/components/ui/data-state';
import { Alert } from '@/components/ui/feedback';
import { PageHeader, Panel, PanelBody, PanelHeader, Stat } from '@/components/ui/surface';
import { Table, TBody, TD, TH, THead, TR, TableScroller } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';

/**
 * The counter till.
 *
 * SEPARATE FROM CLINIC BILLING. An invoice bills a consultation; a sale sells goods
 * with an HSN code and a GST slab. Keeping them apart matters for the tax treatment
 * and for a more important reason: a dispense is a clinical fact that must stand
 * whether or not anyone paid, so a prescription is never "undispensed" because the
 * till was not rung.
 *
 * CHARGING A DISPENSE DOES NOT MOVE STOCK AGAIN. The dispense already took it off
 * the shelf. The sale is about money, and moving the stock twice would halve the
 * inventory every time someone paid.
 */
export default function SalesPage() {
  const params = useSearchParams();
  const dispenseId = params.get('dispenseId');

  const sales = useSales();
  const today = (sales.data ?? []).filter(
    (s) => s.soldAt && s.soldAt.slice(0, 10) === new Date().toISOString().slice(0, 10),
  );
  const taken = today.reduce((sum, s) => sum + s.totalPaise, 0);
  const returned = today.filter((s) => s.isReturn).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Counter sales"
        description="Charging for medicine, whether against a prescription or over the counter."
      />

      <StatRow columns={3}>
        <Stat label="Sales today" value={today.filter((s) => !s.isReturn).length} />
        <Stat label="Taken today" value={formatPaise(taken)} />
        <Stat label="Returns today" value={returned} tone={returned > 0 ? 'warning' : 'neutral'} />
      </StatRow>

      <NewSale dispenseId={dispenseId} />

      <Panel>
        <PanelHeader title="Recent sales" />
        <PanelBody>
          <DataState
            query={sales}
            empty={{ icon: ShoppingCart, title: 'No sales recorded yet' }}
          >
            {(items) => (
              <TableScroller>
                <Table>
                  <THead>
                    <TR>
                      <TH>Number</TH>
                      <TH>Who</TH>
                      <TH>When</TH>
                      <TH align="right">Lines</TH>
                      <TH>Paid by</TH>
                      <TH align="right">Total</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {items.map((sale) => (
                      <TR key={sale.id}>
                        <TD className="token">
                          {sale.saleNumber}
                          {sale.isReturn ? (
                            <Badge tone="warning" className="ml-1.5">
                              Return
                            </Badge>
                          ) : null}
                        </TD>
                        <TD>
                          {sale.patientName ?? sale.buyerName ?? (
                            <span className="text-ink-faint">Walk-in</span>
                          )}
                          {sale.dispenseRecordId ? (
                            <Badge tone="info" className="ml-1.5">
                              Against a prescription
                            </Badge>
                          ) : null}
                        </TD>
                        <TD className="whitespace-nowrap text-ink-faint">
                          {sale.soldAt ? formatDateTime(sale.soldAt) : '—'}
                        </TD>
                        <TD align="right" className="tabular">
                          {sale.lineCount}
                        </TD>
                        <TD className="text-ink-soft">{sale.paymentMethod ?? '—'}</TD>
                        <TD
                          align="right"
                          className={
                            sale.totalPaise < 0
                              ? 'tabular font-semibold text-critical'
                              : 'tabular font-semibold'
                          }
                        >
                          {formatPaise(sale.totalPaise)}
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
    </div>
  );
}

interface Line {
  productId: string;
  stockBatchId: string;
  quantity: string;
  rupeesPrice: string;
  gstRateBps: number;
}

const METHODS: PaymentMethod[] = ['CASH', 'UPI', 'CARD', 'NETBANKING', 'CHEQUE', 'OTHER'];

function NewSale({ dispenseId }: { dispenseId: string | null }) {
  const toast = useToast();
  const record = useRecordSale();
  const products = useProducts();
  const batches = useStockBatches({});
  const quote = useDispenseQuote(dispenseId ?? '', Boolean(dispenseId));

  const [lines, setLines] = React.useState<Line[]>([
    { productId: '', stockBatchId: '', quantity: '', rupeesPrice: '', gstRateBps: 1200 },
  ]);
  const [method, setMethod] = React.useState<PaymentMethod>('CASH');
  const [buyerName, setBuyerName] = React.useState('');

  /* Charging a dispense: the lines come from what was actually handed over. */
  React.useEffect(() => {
    if (!quote.data) return;
    setLines(
      quote.data.lines.map((l) => ({
        productId: l.productId,
        stockBatchId: l.stockBatchId,
        quantity: String(l.quantity),
        rupeesPrice: String(l.unitPricePaise / 100),
        gstRateBps: l.gstRateBps,
      })),
    );
  }, [quote.data]);

  const ready = lines.filter((l) => l.stockBatchId && Number(l.quantity) > 0);
  const totals = computeSaleTotals(
    ready.map((l) => ({
      quantity: Number(l.quantity),
      unitPricePaise: Math.round(Number(l.rupeesPrice || 0) * 100),
      gstRateBps: l.gstRateBps,
    })),
  );

  const update = (index: number, patch: Partial<Line>) =>
    setLines((current) => current.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  /* Picking a batch fills the product, the price and the tax rate from it. */
  const pickBatch = (index: number, batchId: string) => {
    const batch = (batches.data ?? []).find((b) => b.id === batchId);
    const product = (products.data ?? []).find((p) => p.id === batch?.productId);
    update(index, {
      stockBatchId: batchId,
      productId: batch?.productId ?? '',
      rupeesPrice: batch?.mrpPaise ? String(batch.mrpPaise / 100) : '',
      gstRateBps: product?.gstRateBps ?? 1200,
    });
  };

  return (
    <Panel>
      <PanelHeader
        title={dispenseId ? 'Charge for this prescription' : 'New sale'}
        description={
          dispenseId
            ? 'Priced from what was dispensed. Stock has already moved — this records the money.'
            : 'Over-the-counter. Prescription-only medicines are refused here.'
        }
      />
      <PanelBody className="space-y-3">
        {dispenseId ? (
          <Alert tone="info" title="Against a prescription">
            These lines are what the counter handed over. Stock was taken off the shelf
            when it was dispensed and is not moved again.
          </Alert>
        ) : null}

        {lines.map((line, index) => {
          const batch = (batches.data ?? []).find((b) => b.id === line.stockBatchId);
          return (
            <div
              key={index}
              className="grid gap-2 rounded-md border border-line-soft p-2 sm:grid-cols-[minmax(0,2fr)_4.5rem_6rem_auto_auto]"
            >
              <Select
                aria-label="Batch"
                value={line.stockBatchId}
                disabled={Boolean(dispenseId)}
                onChange={(event) => pickBatch(index, event.target.value)}
              >
                <option value="">Product and batch…</option>
                {(batches.data ?? []).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.productName} — {b.batchNumber} — exp {formatDate(b.expiryDate)} —{' '}
                    {b.quantityOnHand} left
                  </option>
                ))}
              </Select>
              <Input
                aria-label="Quantity"
                type="number"
                min={1}
                max={batch?.quantityOnHand}
                placeholder="Qty"
                value={line.quantity}
                onChange={(event) => update(index, { quantity: event.target.value })}
              />
              <Input
                aria-label="Price each in rupees"
                type="number"
                min={0}
                step="0.01"
                placeholder="₹ each"
                value={line.rupeesPrice}
                onChange={(event) => update(index, { rupeesPrice: event.target.value })}
              />
              <span className="self-center text-xs text-ink-faint">
                {line.gstRateBps / 100}% GST
              </span>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Remove line"
                disabled={lines.length === 1 || Boolean(dispenseId)}
                onClick={() => setLines((c) => c.filter((_, i) => i !== index))}
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          );
        })}

        {!dispenseId ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setLines((c) => [
                ...c,
                { productId: '', stockBatchId: '', quantity: '', rupeesPrice: '', gstRateBps: 1200 },
              ])
            }
          >
            <Plus aria-hidden />
            Add a line
          </Button>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          {!dispenseId ? (
            <Field label="Buyer name" htmlFor="sale-buyer" hint="Optional, for a walk-in.">
              <Input
                id="sale-buyer"
                value={buyerName}
                onChange={(event) => setBuyerName(event.target.value)}
              />
            </Field>
          ) : null}
          <Field label="Paid by" htmlFor="sale-method" required>
            <Select
              id="sale-method"
              value={method}
              onChange={(event) => setMethod(event.target.value as PaymentMethod)}
            >
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {ready.length > 0 ? (
          <div className="rounded-md bg-surface-sunk px-3 py-2 text-sm">
            <div className="flex justify-between text-ink-soft">
              <span>Subtotal</span>
              <span className="tabular">{formatPaise(totals.subtotalPaise)}</span>
            </div>
            <div className="flex justify-between text-ink-soft">
              <span>GST</span>
              <span className="tabular">{formatPaise(totals.taxPaise)}</span>
            </div>
            <div className="mt-1 flex justify-between border-t border-line pt-1 text-md font-semibold text-ink">
              <span>To collect</span>
              <span className="tabular">{formatPaise(totals.totalPaise)}</span>
            </div>
          </div>
        ) : null}

        <div className="flex justify-end">
          <Button
            variant="primary"
            disabled={ready.length === 0}
            loading={record.isPending}
            onClick={() =>
              record.mutate(
                {
                  patientId: null,
                  buyerName: buyerName || null,
                  dispenseRecordId: dispenseId,
                  lines: ready.map((l) => ({
                    productId: l.productId,
                    stockBatchId: l.stockBatchId,
                    quantity: Number(l.quantity),
                    unitPricePaise: Math.round(Number(l.rupeesPrice || 0) * 100),
                    gstRateBps: l.gstRateBps,
                    discountPaise: 0,
                  })),
                  discountPaise: 0,
                  discountReason: null,
                  paymentMethod: method,
                  paidPaise: totals.totalPaise,
                },
                {
                  onSuccess: () => {
                    toast.success('Sale recorded');
                    if (!dispenseId) {
                      setLines([
                        {
                          productId: '',
                          stockBatchId: '',
                          quantity: '',
                          rupeesPrice: '',
                          gstRateBps: 1200,
                        },
                      ]);
                      setBuyerName('');
                    }
                  },
                  onError: (error) =>
                    toast.error(
                      error instanceof ApiError ? error.message : 'That did not save',
                    ),
                },
              )
            }
          >
            Take {formatPaise(totals.totalPaise)}
          </Button>
        </div>
      </PanelBody>
    </Panel>
  );
}
