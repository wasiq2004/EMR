'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { LogOut, Receipt } from 'lucide-react';
import type { QueueEntry } from '@emr/contracts';
import { useCheckOut, useVisitBilling } from './api';
import { ApiError } from '@/lib/api-client';
import { useCan } from '@/lib/session';
import { formatPaise } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { DataList } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Closing a visit.
 *
 * THE MONEY IS SHOWN BEFORE THE BUTTON, not after. Checking out a patient who
 * still owes for the consultation is legitimate — clinics extend credit to people
 * they have known for twenty years — but it has to be a decision somebody makes
 * rather than something that happens because the dialog did not mention it.
 *
 * So three states, each with a different primary action:
 *
 *   nothing billed    → offer to raise the invoice, and allow closing without
 *   billed and paid   → close, nothing to discuss
 *   billed and owed   → say the figure plainly, make "collect" the obvious path,
 *                       and let them close anyway with the amount on screen
 *
 * The billing figure is read fresh when the dialog opens rather than carried from
 * the queue row, because a colleague may have taken payment at the counter in the
 * meantime and a stale "₹500 outstanding" would send this patient to pay twice.
 */
export function CheckOutDialog({
  entry,
  onClose,
}: {
  entry: QueueEntry | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const checkOut = useCheckOut();
  const canBill = useCan('invoice:create');

  const appointmentId = entry?.appointment.id ?? '';
  const billing = useVisitBilling(appointmentId, entry !== null);

  const position = billing.data;
  const nothingBilled = position !== undefined && position.invoiceId === null;
  const owes = (position?.outstandingPaise ?? 0) > 0;

  const close = () =>
    entry &&
    checkOut.mutate(appointmentId, {
      onSuccess: (result) => {
        toast.success(
          `${entry.patient.fullName} checked out`,
          result.billing.outstandingPaise > 0
            ? `${formatPaise(result.billing.outstandingPaise)} still outstanding.`
            : undefined,
        );
        onClose();
      },
      onError: (error) =>
        toast.error(error instanceof ApiError ? error.message : 'That did not save'),
    });

  return (
    <Dialog open={entry !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Check out {entry?.patient.fullName}</DialogTitle>
        </DialogHeader>

        {billing.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : nothingBilled ? (
          <Alert tone="warning" title="Nothing has been billed for this visit">
            The consultation is signed but no invoice was raised. You can still
            close the visit — but if this one is chargeable, it is about to walk
            out of the door.
          </Alert>
        ) : owes ? (
          <Alert
            tone="warning"
            title={`${formatPaise(position!.outstandingPaise)} still outstanding`}
          >
            <DataList
              columns={1}
              items={[
                { label: 'Invoice', value: position!.invoiceNumber ?? '—' },
                { label: 'Total', value: formatPaise(position!.totalPaise) },
                { label: 'Paid', value: formatPaise(position!.paidPaise) },
              ]}
            />
            <p className="mt-2 text-xs">
              Closing the visit does not cancel the debt — the invoice stays open
              and appears in the outstanding report.
            </p>
          </Alert>
        ) : (
          <Alert tone="positive" title="Paid in full">
            Invoice {position?.invoiceNumber} · {formatPaise(position?.totalPaise ?? 0)}{' '}
            settled. Nothing outstanding.
          </Alert>
        )}

        <p className="text-xs text-ink-faint">
          Checking out records that the patient has left. It is the last step of the
          visit and cannot be undone — a correction afterwards is a credit note.
        </p>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Not yet
          </Button>

          {/*
            The money button comes first when money is owed, because that is the
            action that should happen. Closing stays available beside it rather
            than behind it — a patient who cannot pay today still has to be let
            out of the clinic.
          */}
          {canBill && (nothingBilled || owes) ? (
            <Button
              variant="secondary"
              onClick={() => {
                onClose();
                router.push(
                  nothingBilled
                    ? `/billing/invoices/new?patientId=${entry?.patient.id}`
                    : `/billing/invoices/${position?.invoiceId}`,
                );
              }}
            >
              <Receipt aria-hidden />
              {nothingBilled ? 'Raise an invoice' : 'Collect payment'}
            </Button>
          ) : null}

          <Button
            variant={owes || nothingBilled ? 'critical' : 'primary'}
            loading={checkOut.isPending}
            onClick={close}
          >
            <LogOut aria-hidden />
            {owes ? 'Check out anyway' : 'Check out'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
