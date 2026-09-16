'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Banknote, Plus } from 'lucide-react';
import type { Invoice } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { useCan } from '@/lib/session';
import { formatDate, formatPaise, formatPaiseShort } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel, PanelBody, PageHeader, Stat } from '@/components/ui/surface';
import { Table, TableShell, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState, SkeletonRows } from '@/components/ui/feedback';

/**
 * Billing.
 *
 * Invoices and payment records only — no ledger, no tax filing. That boundary
 * is deliberate and belongs in the contract as well as the code, because this
 * is where scope quietly expands into accounting.
 */
export default function BillingPage() {
  const canCreate = useCan('invoice:create');

  const { data, isLoading } = useQuery({
    queryKey: qk.invoices('all'),
    queryFn: () => api.get<{ items: Invoice[] }>('/invoices'),
  });

  const invoices = data?.items ?? [];
  const outstanding = invoices.reduce((s, i) => s + (i.totalPaise - i.paidPaise), 0);
  const collected = invoices.reduce((s, i) => s + i.paidPaise, 0);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <PageHeader
        title="Billing"
        description="Invoices and payments. Not an accounting system."
        actions={
          canCreate ? (
            <Button variant="primary" asChild>
              <Link href="/billing/invoices/new">
                <Plus aria-hidden />
                New invoice
              </Link>
            </Button>
          ) : null
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Panel>
          <PanelBody>
            <Stat label="Collected" value={formatPaiseShort(collected)} />
          </PanelBody>
        </Panel>
        <Panel>
          <PanelBody>
            <Stat
              label="Outstanding"
              value={formatPaiseShort(outstanding)}
              tone={outstanding > 0 ? 'warning' : 'neutral'}
            />
          </PanelBody>
        </Panel>
        <Panel>
          <PanelBody>
            <Stat label="Invoices" value={invoices.length} />
          </PanelBody>
        </Panel>
      </div>

      <TableShell>
        {isLoading ? (
          <SkeletonRows rows={5} />
        ) : invoices.length === 0 ? (
          <EmptyState icon={Banknote} title="No invoices yet" />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Invoice</TH>
                <TH>Patient</TH>
                <TH>Date</TH>
                <TH align="right">Total</TH>
                <TH align="right">Due</TH>
                <TH>Status</TH>
              </tr>
            </THead>
            <TBody>
              {invoices.map((invoice) => {
                const due = invoice.totalPaise - invoice.paidPaise;
                return (
                  <TR key={invoice.id}>
                    <TD>
                      <Link
                        href={`/billing/invoices/${invoice.id}`}
                        className="token font-medium text-ink hover:underline"
                      >
                        {invoice.invoiceNumber}
                      </Link>
                    </TD>
                    <TD>
                      <Link
                        href={`/patients/${invoice.patientId}`}
                        className="hover:underline"
                      >
                        {invoice.patientName}
                      </Link>
                    </TD>
                    <TD>{formatDate(invoice.issuedAt ?? invoice.createdAt)}</TD>
                    <TD align="right" className="tabular">
                      {formatPaise(invoice.totalPaise)}
                    </TD>
                    <TD align="right" className="tabular">
                      {due > 0 ? formatPaise(due) : '—'}
                    </TD>
                    <TD>
                      {due > 0 ? (
                        <Badge tone="warning">Unpaid</Badge>
                      ) : (
                        <Badge tone="positive">Paid</Badge>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </TableShell>
    </div>
  );
}
