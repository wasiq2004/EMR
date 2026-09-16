'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Banknote } from 'lucide-react';
import type { Invoice } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { formatDate, formatPaise } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Panel, PanelHeader } from '@/components/ui/surface';
import { EmptyState, SkeletonRows } from '@/components/ui/feedback';

/** Invoices and payments for one patient. Amounts are stored in paise. */
export default function PatientBillingPage() {
  const params = useParams<{ id: string }>();
  const { data, isLoading } = useQuery({
    queryKey: qk.patientInvoices(params.id),
    queryFn: () =>
      api.get<{ items: Invoice[] }>('/invoices', { query: { patientId: params.id } }),
  });

  const invoices = (data?.items ?? []).filter((i) => i.patientId === params.id);
  const outstanding = invoices.reduce((sum, i) => sum + (i.totalPaise - i.paidPaise), 0);

  return (
    <Panel>
      <PanelHeader
        title="Billing"
        description={
          outstanding > 0
            ? formatPaise(outstanding) + ' outstanding'
            : 'Nothing outstanding'
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
                  {due > 0 ? (
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
  );
}
