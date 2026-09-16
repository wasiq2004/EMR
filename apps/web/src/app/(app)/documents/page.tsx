'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { FileText, ShieldAlert } from 'lucide-react';
import type { ClinicalDocument } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { formatBytes, formatDate } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/surface';
import { Table, TableShell, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { EmptyState, SkeletonRows } from '@/components/ui/feedback';

/** Every document in the clinic, filtered by type. */
export default function DocumentsPage() {
  const [term, setTerm] = React.useState('');

  const { data, isLoading } = useQuery({
    queryKey: qk.documents(term),
    queryFn: () =>
      api.get<{ items: ClinicalDocument[] }>('/documents', { query: { q: term } }),
  });

  const documents = data?.items ?? [];

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <PageHeader title="Documents" description="Prescriptions, reports and uploads." />

      <Input
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        placeholder="Search by title or patient"
        aria-label="Search documents"
        className="max-w-sm"
      />

      <TableShell footer={<span>{documents.length} documents</span>}>
        {isLoading ? (
          <SkeletonRows rows={5} />
        ) : documents.length === 0 ? (
          <EmptyState icon={FileText} title="No documents" />
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>Title</TH>
                <TH>Patient</TH>
                <TH>Type</TH>
                <TH>Added</TH>
                <TH align="right">Size</TH>
              </tr>
            </THead>
            <TBody>
              {documents.map((document) => {
                const blocked =
                  document.virusScanStatus !== null &&
                  document.virusScanStatus !== 'CLEAN';
                return (
                  <TR key={document.id}>
                    <TD>
                      <Link
                        href={`/documents/${document.id}`}
                        className="font-medium text-ink hover:underline"
                      >
                        {document.title}
                      </Link>
                      {blocked ? (
                        <Badge tone="critical" className="ml-2">
                          <ShieldAlert aria-hidden />
                          Not scanned
                        </Badge>
                      ) : null}
                    </TD>
                    <TD>
                      <Link
                        href={`/patients/${document.patientId}`}
                        className="hover:underline"
                      >
                        {document.patientName}
                      </Link>
                    </TD>
                    <TD>{document.documentType.replace(/_/g, ' ').toLowerCase()}</TD>
                    <TD>{formatDate(document.createdAt)}</TD>
                    <TD align="right">{formatBytes(document.sizeBytes)}</TD>
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
