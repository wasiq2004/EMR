'use client';

import * as React from 'react';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { useAdjustStock, usePharmacyAlerts } from '@/features/pharmacy/api';
import { ApiError } from '@/lib/api-client';
import { formatDate, formatPaise } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { StatRow } from '@/components/ui/data-state';
import { Alert, EmptyState, SkeletonRows } from '@/components/ui/feedback';
import { PageHeader, Panel, PanelBody, PanelHeader, Stat } from '@/components/ui/surface';
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
 * The alert board — what has to be dealt with today.
 *
 * ORDERED BY WHAT IT COSTS TO IGNORE, not by category. Expired stock on the shelf is
 * a dispensing risk and comes first. Out-of-stock on a fast mover is a patient sent
 * elsewhere. Expiring-soon is money the clinic can still recover by selling or
 * returning it. Low stock is a purchasing note.
 *
 * Every row has an action. A list of problems with nothing to press is a report, and
 * this is meant to be a work list.
 */
export default function PharmacyAlertsPage() {
  const alerts = usePharmacyAlerts();
  const [writeOff, setWriteOff] = React.useState<{
    stockBatchId: string;
    productName: string;
    batchNumber: string;
    quantityOnHand: number;
    kind: 'EXPIRY_WRITE_OFF' | 'DAMAGE_WRITE_OFF' | 'ADJUSTMENT';
  } | null>(null);

  if (alerts.isLoading) return <SkeletonRows rows={8} />;

  const data = alerts.data;
  const expiredValue = (data?.expired ?? []).reduce((sum, b) => sum + b.valueAtCostPaise, 0);
  const expiringValue = (data?.expiringSoon ?? []).reduce(
    (sum, b) => sum + b.valueAtCostPaise,
    0,
  );

  const nothingWrong =
    data !== undefined &&
    data.expired.length === 0 &&
    data.outOfStock.length === 0 &&
    data.expiringSoon.length === 0 &&
    data.lowStock.length === 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Stock alerts"
        description="Everything that needs a decision, worst consequence first."
      />

      <StatRow>
        <Stat
          label="Expired on the shelf"
          value={data?.expired.length ?? 0}
          tone={(data?.expired.length ?? 0) > 0 ? 'critical' : 'neutral'}
          hint={expiredValue > 0 ? `${formatPaise(expiredValue)} at cost` : undefined}
        />
        <Stat
          label="Out of stock"
          value={data?.outOfStock.length ?? 0}
          tone={(data?.outOfStock.length ?? 0) > 0 ? 'warning' : 'neutral'}
        />
        <Stat
          label="Expiring within 90 days"
          value={data?.expiringSoon.length ?? 0}
          hint={expiringValue > 0 ? `${formatPaise(expiringValue)} recoverable` : undefined}
        />
        <Stat label="Below reorder level" value={data?.lowStock.length ?? 0} />
      </StatRow>

      {nothingWrong ? (
        <Panel>
          <PanelBody>
            <EmptyState
              icon={ShieldCheck}
              title="Nothing needs attention"
              description="No expired batches, nothing out of stock, and nothing expiring in the next ninety days."
            />
          </PanelBody>
        </Panel>
      ) : null}

      {/* ---- Expired: a dispensing risk, not an accounting one ------------- */}
      {(data?.expired.length ?? 0) > 0 ? (
        <Panel className="border-critical-line">
          <PanelHeader
            title="Expired stock still on the shelf"
            description="These batches are already excluded from dispensing. Write them off so the count matches what is physically there."
          />
          <PanelBody>
            <Alert tone="critical" title="Remove these from the shelf">
              The system will not let anyone dispense from an expired batch, but it is
              still physically present. Writing it off is what makes the recorded count
              true.
            </Alert>
            <TableScroller className="mt-3">
              <Table>
                <THead>
                  <TR>
                    <TH>Product</TH>
                    <TH>Batch</TH>
                    <TH>Expired</TH>
                    <TH align="right">Quantity</TH>
                    <TH align="right">Value at cost</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {data!.expired.map((batch) => (
                    <TR key={batch.stockBatchId}>
                      <TD>{batch.productName}</TD>
                      <TD className="token">{batch.batchNumber}</TD>
                      <TD>
                        <Badge tone="critical">{formatDate(batch.expiryDate)}</Badge>
                      </TD>
                      <TD align="right" className="tabular">
                        {batch.quantityOnHand}
                      </TD>
                      <TD align="right" className="tabular">
                        {formatPaise(batch.valueAtCostPaise)}
                      </TD>
                      <TD align="right">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            setWriteOff({ ...batch, kind: 'EXPIRY_WRITE_OFF' })
                          }
                        >
                          Write off
                        </Button>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableScroller>
          </PanelBody>
        </Panel>
      ) : null}

      {/* ---- Out of stock, busiest first ---------------------------------- */}
      {(data?.outOfStock.length ?? 0) > 0 ? (
        <Panel>
          <PanelHeader
            title="Out of stock"
            description="Busiest first — what has moved most in the last thirty days is what a patient is most likely to be sent away without."
            actions={
              <Button size="sm" variant="secondary" asChild>
                <Link href="/pharmacy/purchases">Raise an order</Link>
              </Button>
            }
          />
          <PanelBody>
            <TableScroller>
              <Table>
                <THead>
                  <TR>
                    <TH>Product</TH>
                    <TH align="right">Dispensed in 30 days</TH>
                    <TH align="right">Reorder level</TH>
                    <TH align="right">Suggested order</TH>
                  </TR>
                </THead>
                <TBody>
                  {data!.outOfStock.map((row) => (
                    <TR key={row.productId}>
                      <TD>{row.productName}</TD>
                      <TD align="right" className="tabular">
                        {row.recentMovement > 0 ? (
                          <Badge tone="warning">{row.recentMovement}</Badge>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </TD>
                      <TD align="right" className="tabular">
                        {row.reorderLevel ?? '—'}
                      </TD>
                      <TD align="right" className="tabular">
                        {row.reorderQuantity ?? '—'}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableScroller>
          </PanelBody>
        </Panel>
      ) : null}

      {/* ---- Expiring soon: still recoverable ----------------------------- */}
      {(data?.expiringSoon.length ?? 0) > 0 ? (
        <Panel>
          <PanelHeader
            title="Expiring within ninety days"
            description="Ninety days is roughly how long a supplier will still take stock back. After that it is a write-off."
          />
          <PanelBody>
            <TableScroller>
              <Table>
                <THead>
                  <TR>
                    <TH>Product</TH>
                    <TH>Batch</TH>
                    <TH>Expires</TH>
                    <TH align="right">Days left</TH>
                    <TH align="right">Quantity</TH>
                    <TH align="right">Value at cost</TH>
                  </TR>
                </THead>
                <TBody>
                  {data!.expiringSoon.map((batch) => (
                    <TR key={batch.stockBatchId}>
                      <TD>{batch.productName}</TD>
                      <TD className="token">{batch.batchNumber}</TD>
                      <TD>{formatDate(batch.expiryDate)}</TD>
                      <TD align="right" className="tabular">
                        <Badge tone={batch.daysToExpiry <= 30 ? 'critical' : 'warning'}>
                          {batch.daysToExpiry}
                        </Badge>
                      </TD>
                      <TD align="right" className="tabular">
                        {batch.quantityOnHand}
                      </TD>
                      <TD align="right" className="tabular">
                        {formatPaise(batch.valueAtCostPaise)}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableScroller>
          </PanelBody>
        </Panel>
      ) : null}

      {/* ---- Low stock ---------------------------------------------------- */}
      {(data?.lowStock.length ?? 0) > 0 ? (
        <Panel>
          <PanelHeader
            title="Below reorder level"
            description="Closest to running out first."
          />
          <PanelBody>
            <TableScroller>
              <Table>
                <THead>
                  <TR>
                    <TH>Product</TH>
                    <TH align="right">On hand</TH>
                    <TH align="right">Reorder at</TH>
                    <TH align="right">Suggested order</TH>
                  </TR>
                </THead>
                <TBody>
                  {data!.lowStock.map((row) => (
                    <TR key={row.productId}>
                      <TD>{row.productName}</TD>
                      <TD align="right" className="tabular font-semibold">
                        {row.quantityOnHand}
                      </TD>
                      <TD align="right" className="tabular text-ink-faint">
                        {row.reorderLevel}
                      </TD>
                      <TD align="right" className="tabular">
                        {row.reorderQuantity ?? '—'}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableScroller>
          </PanelBody>
        </Panel>
      ) : null}

      <WriteOffDialog target={writeOff} onClose={() => setWriteOff(null)} />
    </div>
  );
}

/**
 * Writing stock off.
 *
 * An ADJUSTMENT movement with a reason, never a deletion — the batch and its
 * history stay, and the ledger records who decided the stock was gone and why.
 * That is what makes the monthly loss figure defensible.
 */
function WriteOffDialog({
  target,
  onClose,
}: {
  target: {
    stockBatchId: string;
    productName: string;
    batchNumber: string;
    quantityOnHand: number;
    kind: 'EXPIRY_WRITE_OFF' | 'DAMAGE_WRITE_OFF' | 'ADJUSTMENT';
  } | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const adjust = useAdjustStock();
  const [quantity, setQuantity] = React.useState('');
  const [kind, setKind] = React.useState<'EXPIRY_WRITE_OFF' | 'DAMAGE_WRITE_OFF' | 'ADJUSTMENT'>(
    'EXPIRY_WRITE_OFF',
  );
  const [reason, setReason] = React.useState('');

  React.useEffect(() => {
    if (!target) return;
    setQuantity(String(target.quantityOnHand));
    setKind(target.kind);
    setReason(
      target.kind === 'EXPIRY_WRITE_OFF'
        ? `Expired batch removed from the shelf on ${formatDate(new Date().toISOString())}`
        : '',
    );
  }, [target]);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Write off {target?.productName}</DialogTitle>
        </DialogHeader>

        {target ? (
          <p className="text-xs text-ink-faint">
            Batch <span className="token">{target.batchNumber}</span> ·{' '}
            {target.quantityOnHand} on hand
          </p>
        ) : null}

        <Field label="Reason type" htmlFor="writeoff-kind" required>
          <Select
            id="writeoff-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as typeof kind)}
          >
            <option value="EXPIRY_WRITE_OFF">Expired</option>
            <option value="DAMAGE_WRITE_OFF">Damaged</option>
            <option value="ADJUSTMENT">Correction after a physical count</option>
          </Select>
        </Field>

        <Field
          label="Quantity to remove"
          htmlFor="writeoff-qty"
          required
          hint="Cannot exceed what is on hand."
        >
          <Input
            id="writeoff-qty"
            type="number"
            min={1}
            max={target?.quantityOnHand}
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
        </Field>

        <Field
          label="Reason"
          htmlFor="writeoff-reason"
          required
          hint="Recorded in the stock ledger against your name. An adjustment without an explanation is the first thing an auditor asks about."
        >
          <Input
            id="writeoff-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="critical"
            disabled={!quantity || Number(quantity) <= 0 || reason.trim().length < 8}
            loading={adjust.isPending}
            onClick={() =>
              target &&
              adjust.mutate(
                {
                  stockBatchId: target.stockBatchId,
                  // Negative: stock is leaving.
                  quantityDelta: -Math.abs(Number(quantity)),
                  movementType: kind,
                  reason,
                },
                {
                  onSuccess: () => {
                    toast.success('Stock written off');
                    onClose();
                  },
                  onError: (error) =>
                    toast.error(error instanceof ApiError ? error.message : 'That did not save'),
                },
              )
            }
          >
            Write off
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
