'use client';

import * as React from 'react';
import { PackagePlus, Plus, ReceiptText, Trash2 } from 'lucide-react';
import {
  GST_RATES_BPS,
  PURCHASE_ORDER_STATUS_LABEL,
  computeSaleTotals,
  type PurchaseOrder,
} from '@emr/contracts';
import {
  useCreatePurchaseOrder,
  useOrderAction,
  useProducts,
  usePurchaseOrder,
  usePurchaseOrders,
  useReceipts,
  useReceiveGoods,
  useSuppliers,
} from '@/features/pharmacy/api';
import { useSession } from '@/lib/session';
import { ApiError, idempotencyKey } from '@/lib/api-client';
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
 * Purchasing.
 *
 * RAISING AN ORDER AND AUTHORISING THE SPEND ARE SEPARATE, and the UI shows it: a
 * pharmacist sees "Send for approval", an owner sees "Approve and place". Whoever
 * holds both permissions sees both buttons, which is the small-clinic case and a
 * legitimate configuration rather than a loophole.
 *
 * RECEIVING IS WHERE BATCH AND EXPIRY ARE CAPTURED, and it is the only thing in the
 * product that creates stock. An order never carries a batch number, because nobody
 * knows it until the box arrives.
 */
export default function PurchasesPage() {
  const session = useSession();
  const [newOrder, setNewOrder] = React.useState(false);
  const [receiveFor, setReceiveFor] = React.useState<string | null>(null);
  const [viewing, setViewing] = React.useState<string | null>(null);

  const orders = usePurchaseOrders();
  const receipts = useReceipts();
  const canApprove = session.role === 'OWNER_ADMIN';

  return (
    <div className="space-y-5">
      <PageHeader
        title="Purchasing"
        description="Orders to suppliers, and the deliveries that come back."
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setReceiveFor('')}>
              <PackagePlus aria-hidden />
              Receive a delivery
            </Button>
            <Button variant="primary" onClick={() => setNewOrder(true)}>
              <Plus aria-hidden />
              New order
            </Button>
          </div>
        }
      />

      <Panel>
        <PanelHeader title="Purchase orders" />
        <PanelBody>
          <DataState
            query={orders}
            empty={{
              icon: ReceiptText,
              title: 'No orders yet',
              description:
                'Raise one from the alert board, or start from scratch. A delivery can also be received without an order.',
            }}
          >
            {(items) => (
              <TableScroller>
                <Table>
                  <THead>
                    <TR>
                      <TH>Order</TH>
                      <TH>Supplier</TH>
                      <TH>Status</TH>
                      <TH>Expected</TH>
                      <TH align="right">Lines</TH>
                      <TH align="right">Total</TH>
                      <TH />
                    </TR>
                  </THead>
                  <TBody>
                    {items.map((order) => (
                      <TR key={order.id}>
                        <TD className="token">{order.orderNumber}</TD>
                        <TD>{order.supplierName}</TD>
                        <TD>
                          <Badge tone={toneFor(order.status)}>
                            {PURCHASE_ORDER_STATUS_LABEL[order.status]}
                          </Badge>
                        </TD>
                        <TD>{order.expectedAt ? formatDate(order.expectedAt) : '—'}</TD>
                        <TD align="right" className="tabular">
                          {order.lineCount}
                        </TD>
                        <TD align="right" className="tabular">
                          {formatPaise(order.totalPaise)}
                        </TD>
                        <TD align="right">
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="ghost" onClick={() => setViewing(order.id)}>
                              Open
                            </Button>
                            {order.status === 'PLACED' ||
                            order.status === 'PARTIALLY_RECEIVED' ? (
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => setReceiveFor(order.id)}
                              >
                                Receive
                              </Button>
                            ) : null}
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

      <Panel>
        <PanelHeader
          title="Deliveries received"
          description="Each one created or topped up a batch, with its expiry."
        />
        <PanelBody>
          <DataState
            query={receipts}
            empty={{ icon: PackagePlus, title: 'No deliveries recorded yet' }}
            skeletonRows={3}
          >
            {(items) => (
              <TableScroller>
                <Table>
                  <THead>
                    <TR>
                      <TH>Receipt</TH>
                      <TH>Supplier</TH>
                      <TH>Their invoice</TH>
                      <TH>Against order</TH>
                      <TH>Received</TH>
                      <TH align="right">Lines</TH>
                      <TH align="right">Total</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {items.map((receipt) => (
                      <TR key={receipt.id}>
                        <TD className="token">{receipt.receiptNumber}</TD>
                        <TD>{receipt.supplierName}</TD>
                        <TD className="token text-xs">
                          {receipt.supplierInvoiceNumber ?? '—'}
                        </TD>
                        <TD className="token text-xs">
                          {receipt.purchaseOrderNumber ?? (
                            <span className="font-sans text-ink-faint">direct purchase</span>
                          )}
                        </TD>
                        <TD className="whitespace-nowrap text-ink-faint">
                          {formatDateTime(receipt.receivedAt)}
                        </TD>
                        <TD align="right" className="tabular">
                          {receipt.lineCount}
                        </TD>
                        <TD align="right" className="tabular">
                          {formatPaise(receipt.totalPaise)}
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

      <NewOrderDialog open={newOrder} onOpenChange={setNewOrder} />
      <ReceiveDialog
        purchaseOrderId={receiveFor}
        onClose={() => setReceiveFor(null)}
      />
      <OrderDialog id={viewing} onClose={() => setViewing(null)} canApprove={canApprove} />
    </div>
  );
}

function toneFor(status: PurchaseOrder['status']) {
  if (status === 'RECEIVED') return 'positive' as const;
  if (status === 'CANCELLED') return 'neutral' as const;
  if (status === 'PARTIALLY_RECEIVED') return 'info' as const;
  if (status === 'AWAITING_APPROVAL') return 'warning' as const;
  return 'neutral' as const;
}

interface DraftLine {
  productId: string;
  quantityOrdered: string;
  rupeesCost: string;
  gstRateBps: number;
}

function NewOrderDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const create = useCreatePurchaseOrder();
  const suppliers = useSuppliers();
  const products = useProducts();

  const [supplierId, setSupplierId] = React.useState('');
  const [expectedAt, setExpectedAt] = React.useState('');
  const [lines, setLines] = React.useState<DraftLine[]>([
    { productId: '', quantityOrdered: '', rupeesCost: '', gstRateBps: 1200 },
  ]);

  const ready = lines.filter((l) => l.productId && Number(l.quantityOrdered) > 0);

  /* The same totals function the server uses, so the two cannot disagree. */
  const totals = computeSaleTotals(
    ready.map((l) => ({
      quantity: Number(l.quantityOrdered),
      unitPricePaise: Math.round(Number(l.rupeesCost || 0) * 100),
      gstRateBps: l.gstRateBps,
    })),
  );

  const update = (index: number, patch: Partial<DraftLine>) =>
    setLines((current) => current.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>New purchase order</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Supplier" htmlFor="order-supplier" required>
            <Select
              id="order-supplier"
              value={supplierId}
              onChange={(event) => setSupplierId(event.target.value)}
            >
              <option value="">Choose a supplier…</option>
              {(suppliers.data ?? []).map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Expected by" htmlFor="order-expected">
            <Input
              id="order-expected"
              type="date"
              value={expectedAt}
              onChange={(event) => setExpectedAt(event.target.value)}
            />
          </Field>
        </div>

        <div className="space-y-2">
          {lines.map((line, index) => (
            <div
              key={index}
              className="grid gap-2 rounded-md border border-line-soft p-2 sm:grid-cols-[minmax(0,2fr)_5rem_6rem_5rem_auto]"
            >
              <Select
                aria-label="Product"
                value={line.productId}
                onChange={(event) => update(index, { productId: event.target.value })}
              >
                <option value="">Product…</option>
                {(products.data ?? []).map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                    {product.strength ? ` ${product.strength}` : ''}
                  </option>
                ))}
              </Select>
              <Input
                aria-label="Quantity"
                type="number"
                min={1}
                placeholder="Qty"
                value={line.quantityOrdered}
                onChange={(event) => update(index, { quantityOrdered: event.target.value })}
              />
              <Input
                aria-label="Cost each in rupees"
                type="number"
                min={0}
                step="0.01"
                placeholder="₹ each"
                value={line.rupeesCost}
                onChange={(event) => update(index, { rupeesCost: event.target.value })}
              />
              <Select
                aria-label="GST rate"
                value={String(line.gstRateBps)}
                onChange={(event) => update(index, { gstRateBps: Number(event.target.value) })}
              >
                {GST_RATES_BPS.map((bps) => (
                  <option key={bps} value={bps}>
                    {bps / 100}%
                  </option>
                ))}
              </Select>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Remove line"
                disabled={lines.length === 1}
                onClick={() => setLines((c) => c.filter((_, i) => i !== index))}
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setLines((c) => [
                ...c,
                { productId: '', quantityOrdered: '', rupeesCost: '', gstRateBps: 1200 },
              ])
            }
          >
            <Plus aria-hidden />
            Add a line
          </Button>
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
            <div className="mt-1 flex justify-between border-t border-line pt-1 font-semibold text-ink">
              <span>Total</span>
              <span className="tabular">{formatPaise(totals.totalPaise)}</span>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!supplierId || ready.length === 0}
            loading={create.isPending}
            onClick={() =>
              create.mutate(
                {
                  supplierId,
                  expectedAt: expectedAt || null,
                  notes: null,
                  lines: ready.map((l) => ({
                    productId: l.productId,
                    quantityOrdered: Number(l.quantityOrdered),
                    unitCostPaise: Math.round(Number(l.rupeesCost || 0) * 100),
                    gstRateBps: l.gstRateBps,
                  })),
                },
                {
                  onSuccess: () => {
                    toast.success('Order saved as a draft');
                    setLines([
                      { productId: '', quantityOrdered: '', rupeesCost: '', gstRateBps: 1200 },
                    ]);
                    setSupplierId('');
                    onOpenChange(false);
                  },
                  onError: (error) =>
                    toast.error(
                      error instanceof ApiError ? error.message : 'That did not save',
                    ),
                },
              )
            }
          >
            Save draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OrderDialog({
  id,
  onClose,
  canApprove,
}: {
  id: string | null;
  onClose: () => void;
  canApprove: boolean;
}) {
  const toast = useToast();
  const order = usePurchaseOrder(id ?? '');
  const act = useOrderAction();

  const run = (action: 'submit' | 'approve' | 'cancel', reason?: string) =>
    id &&
    act.mutate(
      { id, action, reason },
      {
        onSuccess: () => {
          toast.success(
            action === 'approve' ? 'Order placed' : action === 'submit' ? 'Sent for approval' : 'Order cancelled',
          );
          onClose();
        },
        onError: (error) =>
          toast.error(error instanceof ApiError ? error.message : 'That did not save'),
      },
    );

  const data = order.data;

  return (
    <Dialog open={id !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {data ? `${data.orderNumber} · ${data.supplierName}` : 'Purchase order'}
          </DialogTitle>
        </DialogHeader>

        {data ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
              <Badge tone={toneFor(data.status)}>
                {PURCHASE_ORDER_STATUS_LABEL[data.status]}
              </Badge>
              {data.placedByName ? <span>raised by {data.placedByName}</span> : null}
              {data.approvedByName ? <span>· approved by {data.approvedByName}</span> : null}
            </div>

            <TableScroller>
              <Table>
                <THead>
                  <TR>
                    <TH>Product</TH>
                    <TH align="right">Ordered</TH>
                    <TH align="right">Received</TH>
                    <TH align="right">Cost each</TH>
                    <TH align="right">Line total</TH>
                  </TR>
                </THead>
                <TBody>
                  {data.lines.map((line) => (
                    <TR key={line.id ?? line.productId}>
                      <TD>{line.productName ?? '—'}</TD>
                      <TD align="right" className="tabular">
                        {line.quantityOrdered}
                      </TD>
                      <TD align="right" className="tabular">
                        {(line.quantityReceived ?? 0) >= line.quantityOrdered ? (
                          <Badge tone="positive">{line.quantityReceived}</Badge>
                        ) : (
                          <span>{line.quantityReceived ?? 0}</span>
                        )}
                      </TD>
                      <TD align="right" className="tabular">
                        {formatPaise(line.unitCostPaise)}
                      </TD>
                      <TD align="right" className="tabular">
                        {formatPaise(line.lineTotalPaise ?? 0)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableScroller>

            <div className="rounded-md bg-surface-sunk px-3 py-2 text-sm">
              <div className="flex justify-between font-semibold text-ink">
                <span>Total</span>
                <span className="tabular">{formatPaise(data.totalPaise)}</span>
              </div>
            </div>

            {data.status === 'DRAFT' || data.status === 'AWAITING_APPROVAL' ? (
              <Alert tone="info" title="Raising and authorising are separate">
                {canApprove
                  ? 'You hold approval, so you can place this order directly.'
                  : 'Send it for approval. Someone with spending authority places it.'}
              </Alert>
            ) : null}
          </>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {data?.status === 'DRAFT' ? (
            <Button variant="secondary" loading={act.isPending} onClick={() => run('submit')}>
              Send for approval
            </Button>
          ) : null}
          {(data?.status === 'DRAFT' || data?.status === 'AWAITING_APPROVAL') && canApprove ? (
            <Button variant="primary" loading={act.isPending} onClick={() => run('approve')}>
              Approve and place
            </Button>
          ) : null}
          {data && data.status !== 'RECEIVED' && data.status !== 'CANCELLED' ? (
            <Button
              variant="critical"
              loading={act.isPending}
              onClick={() => run('cancel', 'Cancelled from the purchasing screen')}
            >
              Cancel order
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ReceiveLine {
  productId: string;
  batchNumber: string;
  expiryDate: string;
  quantity: string;
  rupeesCost: string;
  rupeesMrp: string;
  gstRateBps: number;
}

function ReceiveDialog({
  purchaseOrderId,
  onClose,
}: {
  purchaseOrderId: string | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const receive = useReceiveGoods();

  /*
   * One key per delivery the user is entering, not one per attempt.
   *
   * Held in a ref and replaced only after it lands. A key minted inside the
   * mutation is new on every retry, so the server sees a second distinct
   * delivery and performs it — which is the exact failure the key prevents.
   */
  const submitKey = React.useRef(idempotencyKey());
  const suppliers = useSuppliers();
  const products = useProducts();
  const order = usePurchaseOrder(purchaseOrderId || '');

  const [supplierId, setSupplierId] = React.useState('');
  const [invoiceNumber, setInvoiceNumber] = React.useState('');
  const [lines, setLines] = React.useState<ReceiveLine[]>([]);

  const blankLine: ReceiveLine = {
    productId: '',
    batchNumber: '',
    expiryDate: '',
    quantity: '',
    rupeesCost: '',
    rupeesMrp: '',
    gstRateBps: 1200,
  };

  /*
   * Pre-filled from the order's OUTSTANDING quantities when receiving against one.
   * Retyping what was ordered is the exact re-entry this module exists to remove,
   * and it is also where the wrong quantity gets typed.
   */
  React.useEffect(() => {
    if (purchaseOrderId === null) return;
    if (!purchaseOrderId) {
      setLines([blankLine]);
      setSupplierId('');
      return;
    }
    if (!order.data) return;
    setSupplierId(order.data.supplierId);
    setLines(
      order.data.lines
        .filter((l) => (l.quantityReceived ?? 0) < l.quantityOrdered)
        .map((l) => ({
          productId: l.productId,
          batchNumber: '',
          expiryDate: '',
          quantity: String(l.quantityOrdered - (l.quantityReceived ?? 0)),
          rupeesCost: String(l.unitCostPaise / 100),
          rupeesMrp: '',
          gstRateBps: l.gstRateBps,
        })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purchaseOrderId, order.data]);

  const update = (index: number, patch: Partial<ReceiveLine>) =>
    setLines((current) => current.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  const complete = lines.filter(
    (l) => l.productId && l.batchNumber && l.expiryDate && Number(l.quantity) > 0,
  );

  return (
    <Dialog
      open={purchaseOrderId !== null}
      onOpenChange={(open) => (open ? undefined : onClose())}
    >
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {purchaseOrderId
              ? `Receive against ${order.data?.orderNumber ?? 'order'}`
              : 'Receive a delivery'}
          </DialogTitle>
        </DialogHeader>

        <Alert tone="info" title="Batch number and expiry are required">
          They are what connect this stock to a recall notice. Without them a recall
          means disposing of the whole shelf.
        </Alert>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Supplier" htmlFor="receive-supplier" required>
            <Select
              id="receive-supplier"
              value={supplierId}
              disabled={Boolean(purchaseOrderId)}
              onChange={(event) => setSupplierId(event.target.value)}
            >
              <option value="">Choose a supplier…</option>
              {(suppliers.data ?? []).map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Their invoice number" htmlFor="receive-invoice">
            <Input
              id="receive-invoice"
              value={invoiceNumber}
              onChange={(event) => setInvoiceNumber(event.target.value)}
            />
          </Field>
        </div>

        <div className="space-y-2">
          {lines.map((line, index) => (
            <div
              key={index}
              className="grid gap-2 rounded-md border border-line-soft p-2 sm:grid-cols-[minmax(0,2fr)_6rem_8rem_4.5rem_5.5rem_5.5rem_auto]"
            >
              <Select
                aria-label="Product"
                value={line.productId}
                onChange={(event) => update(index, { productId: event.target.value })}
              >
                <option value="">Product…</option>
                {(products.data ?? []).map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                    {product.strength ? ` ${product.strength}` : ''}
                  </option>
                ))}
              </Select>
              <Input
                aria-label="Batch number"
                placeholder="Batch"
                value={line.batchNumber}
                onChange={(event) => update(index, { batchNumber: event.target.value })}
              />
              <Input
                aria-label="Expiry date"
                type="date"
                value={line.expiryDate}
                onChange={(event) => update(index, { expiryDate: event.target.value })}
              />
              <Input
                aria-label="Quantity"
                type="number"
                min={1}
                placeholder="Qty"
                value={line.quantity}
                onChange={(event) => update(index, { quantity: event.target.value })}
              />
              <Input
                aria-label="Cost each in rupees"
                type="number"
                min={0}
                step="0.01"
                placeholder="₹ cost"
                value={line.rupeesCost}
                onChange={(event) => update(index, { rupeesCost: event.target.value })}
              />
              <Input
                aria-label="MRP each in rupees"
                type="number"
                min={0}
                step="0.01"
                placeholder="₹ MRP"
                value={line.rupeesMrp}
                onChange={(event) => update(index, { rupeesMrp: event.target.value })}
              />
              <Button
                size="icon"
                variant="ghost"
                aria-label="Remove line"
                onClick={() => setLines((c) => c.filter((_, i) => i !== index))}
              >
                <Trash2 aria-hidden />
              </Button>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setLines((c) => [...c, blankLine])}>
            <Plus aria-hidden />
            Add a line
          </Button>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!supplierId || complete.length === 0}
            loading={receive.isPending}
            onClick={() =>
              receive.mutate(
                {
                  purchaseOrderId: purchaseOrderId || null,
                  supplierId,
                  supplierInvoiceNumber: invoiceNumber || null,
                  supplierInvoiceDate: null,
                  notes: null,
                  idempotencyKey: submitKey.current,
                  lines: complete.map((l) => ({
                    productId: l.productId,
                    batchNumber: l.batchNumber,
                    expiryDate: l.expiryDate,
                    quantity: Number(l.quantity),
                    unitCostPaise: Math.round(Number(l.rupeesCost || 0) * 100),
                    mrpPaise: l.rupeesMrp ? Math.round(Number(l.rupeesMrp) * 100) : null,
                    gstRateBps: l.gstRateBps,
                  })),
                },
                {
                  onSuccess: () => {
                    submitKey.current = idempotencyKey();
                    toast.success('Delivery received — stock updated');
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
            Receive {complete.length} line{complete.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
