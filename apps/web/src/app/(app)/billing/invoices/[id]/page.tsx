'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import type { Invoice } from '@emr/contracts';
import { api, idempotencyKey } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { useCan } from '@/lib/session';
import { formatDate, formatDateTime, formatPaise, rupeesToPaise } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Panel, PanelBody, PanelHeader, PageHeader } from '@/components/ui/surface';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';

/**
 * One invoice.
 *
 * Partial and mixed-tender payments are routine at a front desk — part cash,
 * part UPI — so payments are separate records rather than a single paid flag.
 * An issued invoice is immutable; a correction is a credit note.
 */
export default function InvoicePage() {
  const params = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const toast = useToast();
  const canTakePayment = useCan('payment:create');

  const { data, isLoading } = useQuery({
    queryKey: qk.invoice(params.id),
    queryFn: () => api.get<Invoice>(`/invoices/${params.id}`),
  });

  const [amount, setAmount] = React.useState('');
  const [method, setMethod] = React.useState('CASH');
  const [reference, setReference] = React.useState('');

  const pay = useMutation({
    mutationFn: () =>
      api.post(
        `/invoices/${params.id}/payments`,
        {
          amountPaise: rupeesToPaise(amount),
          method,
          referenceNumber: reference.trim() || null,
        },
        { idempotencyKey: idempotencyKey() },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.invoice(params.id) });
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      setAmount('');
      setReference('');
      toast.success('Payment recorded');
    },
  });

  if (isLoading || !data) return <Skeleton className="h-96 w-full" />;

  const due = data.totalPaise - data.paidPaise;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Link
        href="/billing"
        className="inline-flex w-fit items-center gap-1.5 text-xs text-ink-faint hover:text-ink print:hidden"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Billing
      </Link>

      <PageHeader
        title={data.invoiceNumber}
        description={
          <Link href={`/patients/${data.patientId}`} className="hover:underline">
            {data.patientName}
          </Link>
        }
        actions={
          <Button variant="secondary" onClick={() => globalThis.print()}>
            <Printer aria-hidden />
            Print receipt
          </Button>
        }
        className="print:hidden"
      />

      <Panel>
        <PanelHeader
          title="Charges"
          description={formatDate(data.issuedAt ?? data.createdAt)}
          actions={
            due > 0 ? (
              <Badge tone="warning">{formatPaise(due)} due</Badge>
            ) : (
              <Badge tone="positive">Paid in full</Badge>
            )
          }
        />
        <PanelBody>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-2xs uppercase tracking-wide text-ink-faint">
                <th className="py-1.5 text-left font-semibold">Description</th>
                <th className="py-1.5 text-right font-semibold">Qty</th>
                <th className="py-1.5 text-right font-semibold">Rate</th>
                <th className="py-1.5 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.lineItems.map((line, index) => (
                <tr key={index} className="border-b border-line-soft">
                  <td className="py-2 text-ink">{line.description}</td>
                  <td className="py-2 text-right tabular">{line.quantity}</td>
                  <td className="py-2 text-right tabular">
                    {formatPaise(line.unitPricePaise)}
                  </td>
                  <td className="py-2 text-right tabular">
                    {formatPaise(line.amountPaise)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <dl className="ml-auto mt-3 w-56 text-sm">
            <div className="flex justify-between py-0.5">
              <dt className="text-ink-faint">Subtotal</dt>
              <dd className="tabular">{formatPaise(data.subtotalPaise)}</dd>
            </div>
            {data.discountPaise > 0 ? (
              <div className="flex justify-between py-0.5">
                <dt className="text-ink-faint">
                  Discount{data.discountReason ? ` (${data.discountReason})` : ''}
                </dt>
                <dd className="tabular">−{formatPaise(data.discountPaise)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between border-t border-line py-1 font-semibold">
              <dt>Total</dt>
              <dd className="tabular">{formatPaise(data.totalPaise)}</dd>
            </div>
            <div className="flex justify-between py-0.5">
              <dt className="text-ink-faint">Paid</dt>
              <dd className="tabular">{formatPaise(data.paidPaise)}</dd>
            </div>
          </dl>
        </PanelBody>
      </Panel>

      {data.payments.length > 0 ? (
        <Panel>
          <PanelHeader title="Payments" />
          <ul className="divide-y divide-line-soft">
            {data.payments.map((payment) => (
              <li key={payment.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="text-sm text-ink">
                    {formatPaise(payment.amountPaise)} by {payment.method.toLowerCase()}
                  </span>
                  <span className="mt-0.5 block text-2xs text-ink-faint">
                    {formatDateTime(payment.receivedAt)} · {payment.receivedByName}
                    {payment.referenceNumber
                      ? ` · ref ${payment.referenceNumber}`
                      : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {due > 0 && canTakePayment ? (
        <Panel className="print:hidden">
          <PanelHeader title="Record a payment" />
          <PanelBody>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                pay.mutate();
              }}
              className="flex flex-wrap items-end gap-3"
            >
              <Field label="Amount" htmlFor="pay-amount" className="w-36" required>
                <Input
                  id="pay-amount"
                  inputMode="decimal"
                  className="token"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder={String(due / 100)}
                />
              </Field>
              <Field label="Method" htmlFor="pay-method" className="w-36">
                <Select
                  id="pay-method"
                  value={method}
                  onChange={(event) => setMethod(event.target.value)}
                >
                  <option value="CASH">Cash</option>
                  <option value="UPI">UPI</option>
                  <option value="CARD">Card</option>
                  <option value="NETBANKING">Net banking</option>
                  <option value="CHEQUE">Cheque</option>
                </Select>
              </Field>
              <Field label="Reference" htmlFor="pay-ref" className="min-w-40 flex-1">
                <Input
                  id="pay-ref"
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  placeholder="UPI reference or cheque number"
                />
              </Field>
              <Button type="submit" variant="primary" loading={pay.isPending}>
                Record
              </Button>
            </form>
          </PanelBody>
        </Panel>
      ) : null}

      {data.isFinalized ? (
        <Alert tone="info" title="This invoice is issued and cannot be edited">
          A correction is recorded as a credit note rather than by changing the
          original.
        </Alert>
      ) : null}
    </div>
  );
}
