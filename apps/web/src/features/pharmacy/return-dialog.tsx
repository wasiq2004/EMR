'use client';

import * as React from 'react';
import { computeSaleTotals } from '@emr/contracts';
import { useReturnSale, useSale } from '@/features/pharmacy/api';
import { ApiError } from '@/lib/api-client';
import { formatDate, formatPaise } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { Table, TBody, TD, TH, THead, TR, TableScroller } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Taking medicine back over the counter.
 *
 * `POST /pharmacy/sales/:id/return` has been implemented, audited and
 * unreachable since the module shipped. A customer bringing back the wrong
 * strength had to be dealt with by adjusting stock by hand and settling the
 * money off the books, which is precisely what a till is supposed to prevent.
 *
 * THE RETURN IS PER BATCH, NOT PER PRODUCT, and that is the whole reason this
 * screen lists lines rather than offering a product search. The stock goes back
 * on the batch it came off: a strip sold from a batch expiring next month must
 * return to THAT batch, or the clinic will dispense it in March believing it has
 * until December. The batch number and the expiry are on every row because the
 * person at the counter is holding the box and can read them off it.
 *
 * THE PRICE IS NOT EDITABLE. The contract would accept any figure, and the
 * original line price is the only defensible one — refunding at today's price
 * for goods bought at last month's turns the till into a way to move money
 * without a reason anyone can audit. A genuine price dispute is a different
 * conversation and belongs in the reason field.
 */
export function ReturnSaleDialog({
  saleId,
  onOpenChange,
}: {
  /** Null keeps it closed; the id both opens it and says which sale. */
  saleId: string | null;
  onOpenChange: (saleId: string | null) => void;
}) {
  const toast = useToast();
  const sale = useSale(saleId);
  const record = useReturnSale();

  /** Keyed by sale-line id, so two lines on the same batch stay distinct. */
  const [quantities, setQuantities] = React.useState<Record<string, string>>({});
  const [reason, setReason] = React.useState('');

  // A fresh dialog each time. Carrying the previous sale's quantities over would
  // put numbers against a different person's goods.
  React.useEffect(() => {
    if (saleId) {
      setQuantities({});
      setReason('');
    }
  }, [saleId]);

  const lines = sale.data?.lines ?? [];
  const returnable = lines.filter((line) => line.returnableQuantity > 0);

  const chosen = returnable
    .map((line) => ({ line, quantity: Number(quantities[line.id] ?? '') }))
    .filter(
      ({ line, quantity }) =>
        Number.isInteger(quantity) && quantity > 0 && quantity <= line.returnableQuantity,
    );

  // Same arithmetic the server runs, so the figure on the button is the figure
  // that lands in the ledger.
  const refund = computeSaleTotals(
    chosen.map(({ line, quantity }) => ({
      quantity,
      unitPricePaise: line.unitPricePaise,
      gstRateBps: line.gstRateBps,
    })),
  );

  const invalid = returnable.some((line) => {
    const raw = quantities[line.id];
    if (!raw) return false;
    const quantity = Number(raw);
    return !Number.isInteger(quantity) || quantity < 0 || quantity > line.returnableQuantity;
  });

  const submit = () => {
    if (!saleId || chosen.length === 0) return;
    record.mutate(
      {
        id: saleId,
        input: {
          returnReason: reason.trim(),
          lines: chosen.map(({ line, quantity }) => ({
            productId: line.productId,
            stockBatchId: line.stockBatchId,
            quantity,
            unitPricePaise: line.unitPricePaise,
            gstRateBps: line.gstRateBps,
          })),
        },
      },
      {
        onSuccess: (result) => {
          toast.success(
            `Returned — ${result.saleNumber}`,
            `${formatPaise(result.refundedPaise)} to refund. The stock is back on its batch.`,
          );
          onOpenChange(null);
        },
        onError: (error) =>
          toast.error(
            'Could not record the return',
            error instanceof ApiError ? error.message : undefined,
          ),
      },
    );
  };

  return (
    <Dialog open={Boolean(saleId)} onOpenChange={(open) => !open && onOpenChange(null)}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Take goods back</DialogTitle>
          <DialogDescription>
            {sale.data
              ? `Against ${sale.data.saleNumber} — ${
                  sale.data.patientName ?? sale.data.buyerName ?? 'walk-in'
                }${sale.data.soldAt ? `, sold ${formatDate(sale.data.soldAt)}` : ''}.`
              : 'Loading the original sale.'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {sale.isPending ? (
            <Skeleton className="h-40" />
          ) : sale.isError ? (
            <Alert tone="critical" title="Could not load that sale">
              {sale.error instanceof ApiError
                ? sale.error.message
                : 'Try again in a moment.'}
            </Alert>
          ) : returnable.length === 0 ? (
            <Alert tone="info" title="Nothing left to return">
              {/*
                Two different states, said differently. "Everything has already
                come back" is a fact about this sale; a return document having no
                returnable lines is a category error the list should not have
                offered in the first place.
              */}
              {sale.data?.isReturn
                ? 'This is itself a return. Take goods back against the original sale.'
                : 'Every item on this sale has already been returned.'}
            </Alert>
          ) : (
            <>
              <TableScroller className="rounded-lg border border-line">
                <Table>
                  <THead>
                    <TR>
                      <TH>Item</TH>
                      <TH>Batch</TH>
                      <TH align="right">Sold</TH>
                      <TH align="right">Can return</TH>
                      <TH align="right">Price</TH>
                      <TH align="right">Taking back</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {returnable.map((line) => (
                      <TR key={line.id}>
                        <TD className="text-ink">
                          {line.productName ?? 'Product no longer on file'}
                          {line.packUnit ? (
                            <span className="ml-1 text-xs text-ink-faint">
                              per {line.packUnit}
                            </span>
                          ) : null}
                        </TD>
                        <TD className="whitespace-nowrap">
                          <span className="token">{line.batchNumber ?? '—'}</span>
                          {line.expiryDate ? (
                            <span className="ml-1.5 text-2xs text-ink-faint">
                              exp {formatDate(line.expiryDate)}
                            </span>
                          ) : null}
                        </TD>
                        <TD align="right" className="tabular">
                          {line.quantity}
                        </TD>
                        <TD align="right" className="tabular">
                          {line.returnableQuantity}
                          {line.alreadyReturned > 0 ? (
                            <Badge tone="warning" className="ml-1.5">
                              {line.alreadyReturned} back
                            </Badge>
                          ) : null}
                        </TD>
                        <TD align="right" className="tabular text-ink-soft">
                          {formatPaise(line.unitPricePaise)}
                        </TD>
                        <TD align="right">
                          <Input
                            type="number"
                            inputMode="numeric"
                            min={0}
                            max={line.returnableQuantity}
                            className="w-20 text-right tabular"
                            aria-label={`Quantity returned of ${
                              line.productName ?? 'this item'
                            }`}
                            value={quantities[line.id] ?? ''}
                            onChange={(event) =>
                              setQuantities((current) => ({
                                ...current,
                                [line.id]: event.target.value,
                              }))
                            }
                          />
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableScroller>

              {invalid ? (
                <Alert tone="warning" title="Check the quantities">
                  You cannot take back more than was sold, or part of a packet.
                </Alert>
              ) : null}

              <Field
                label="Why has it come back?"
                htmlFor="return-reason"
                hint="Kept on the return and on the stock movement. Wrong strength, a reaction, or an unopened box the patient no longer needs are all different things to a stock audit."
              >
                <Input
                  id="return-reason"
                  placeholder="Wrong strength dispensed — exchanged for 250mg"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>

              {/*
                Said before pressing, not after. A return puts the goods back on
                the shelf to be sold again, and a strip that came back from a
                patient's bag is not always fit for that — the judgement belongs
                to the pharmacist, who should be making it knowingly.
              */}
              {chosen.length > 0 ? (
                <Alert
                  tone="info"
                  title={`${formatPaise(refund.totalPaise)} to refund, ${chosen.reduce(
                    (sum, { quantity }) => sum + quantity,
                    0,
                  )} back on the shelf`}
                >
                  Including {formatPaise(refund.taxPaise)} GST. The stock returns to
                  the batch it was sold from and can be dispensed again — set it
                  aside instead if it is not fit to sell.
                </Alert>
              ) : null}
            </>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(null)}>
            Cancel
          </Button>
          <Button
            variant="critical"
            disabled={chosen.length === 0 || invalid || reason.trim().length < 5}
            loading={record.isPending}
            onClick={submit}
          >
            Record the return
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
