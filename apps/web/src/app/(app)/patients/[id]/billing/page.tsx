'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Banknote, Plus } from 'lucide-react';
import type { Invoice } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { formatDate, formatPaise } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatRow } from '@/components/ui/data-state';
import { Panel, PanelHeader, Stat } from '@/components/ui/surface';
import { useCan } from '@/lib/session';
import { EmptyState, SkeletonRows } from '@/components/ui/feedback';

/** Invoices and payments for one patient. Amounts are stored in paise. */
export default function PatientBillingPage() {
  const params = useParams<{ id: string }>();
  const canBill = useCan('invoice:create');
  const { data, isLoading } = useQuery({
    queryKey: qk.patientInvoices(params.id),
    queryFn: () =>
      api.get<{ items: Invoice[] }>('/invoices', { query: { patientId: params.id } }),
  });

  const invoices = (data?.items ?? []).filter((i) => i.patientId === params.id);

  /*
   * A cancelled invoice is not a debt and not revenue.
   *
   * Summing every row would show a patient owing money for a bill that was
   * voided — which is the figure somebody would then try to collect.
   */
  const live = invoices.filter((i) => i.status !== 'CANCELLED');
  const billed = live.reduce((sum, i) => sum + i.totalPaise, 0);
  const paid = live.reduce((sum, i) => sum + i.paidPaise, 0);
  const outstanding = Math.max(billed - paid, 0);

  return (
    <div className="flex flex-col gap-4">
      <StatRow columns={3}>
        <Stat label="Billed" value={formatPaise(billed)} hint={`${live.length} invoices`} />
        <Stat label="Paid" value={formatPaise(paid)} tone="positive" />
        <Stat
          label="Outstanding"
          value={formatPaise(outstanding)}
          tone={outstanding > 0 ? 'warning' : 'neutral'}
        />
      </StatRow>

      <Panel>
      <PanelHeader
        title="Invoices"
        description={
          outstanding > 0
            ? formatPaise(outstanding) + ' outstanding'
            : 'Nothing outstanding'
        }
        actions={
          canBill ? (
            <Button size="sm" variant="primary" asChild>
              <Link href={`/billing/invoices/new?patientId=${params.id}`}>
                <Plus aria-hidden />
                New invoice
              </Link>
            </Button>
          ) : null
        }
      />
      {isLoading ? (
        <SkeletonRows rows={3} />
      ) : invoices.length === 0 ? (
        <EmptyState icon={Banknote} title="No invoices for this patient" />
      ) : (
        <ul className="divide-y divide-line-soft">
          {invoices.map((invoice) => {
            const due = invoice.totalPaise - invoice.paidPaise;
            return (
              <li key={invoice.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/billing/invoices/${invoice.id}`}
                    className="token text-sm font-medium text-ink hover:underline"
                  >
                    {invoice.invoiceNumber}
                  </Link>
                  <p className="mt-0.5 text-2xs text-ink-faint">
                    {formatDate(invoice.issuedAt ?? invoice.createdAt)} ·{' '}
                    {invoice.lineItems.map((l) => l.description).join(', ')}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-medium tabular text-ink">
                    {formatPaise(invoice.totalPaise)}
                  </p>
                  {invoice.status === 'CANCELLED' ? (
                    <Badge>Cancelled</Badge>
                  ) : due > 0 ? (
                    <Badge tone="warning">{formatPaise(due)} due</Badge>
                  ) : (
                    <Badge tone="positive">Paid</Badge>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      </Panel>
    </div>
  );
}
