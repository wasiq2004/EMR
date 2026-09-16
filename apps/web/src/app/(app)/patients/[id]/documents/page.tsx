'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { FileText, Share2, ShieldAlert, Upload } from 'lucide-react';
import type { ClinicalDocument } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { ShareDocumentDialog } from '@/features/documents/share-dialog';
import { useCan } from '@/lib/session';
import { formatBytes, formatDate } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel, PanelHeader } from '@/components/ui/surface';
import { EmptyState, SkeletonRows } from '@/components/ui/feedback';

/**
 * A patient's documents.
 *
 * A patient-supplied upload that has not passed scanning cannot be opened or
 * shared. The control fails closed: anything other than a confirmed clean scan
 * blocks sharing, rather than a missing status being treated as fine.
 */
export default function PatientDocumentsPage() {
  const params = useParams<{ id: string }>();
  const patientId = params.id;
  const canShare = useCan('document:share');
  const canUpload = useCan('document:create');

  const [sharing, setSharing] = React.useState<ClinicalDocument | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: qk.patientDocuments(patientId),
    queryFn: () =>
      api.get<{ items: ClinicalDocument[] }>('/documents', {
        query: { patientId },
      }),
  });

  const documents = data?.items ?? [];

  return (
    <>
      <Panel>
        <PanelHeader
          title="Documents"
          description={`${documents.length} on file`}
          actions={
            canUpload ? (
              <Button size="sm" variant="secondary">
                <Upload aria-hidden />
                Upload
              </Button>
            ) : null
          }
        />
        {isLoading ? (
          <SkeletonRows rows={4} />
        ) : documents.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No documents yet"
            description="Prescriptions are added here automatically once signed."
          />
        ) : (
          <ul className="divide-y divide-line-soft">
            {documents.map((document) => {
              const blocked =
                document.virusScanStatus !== null &&
                document.virusScanStatus !== 'CLEAN';

              return (
                <li
                  key={document.id}
                  className="flex flex-wrap items-center gap-3 px-4 py-3"
                >
                  <FileText className="size-4 shrink-0 text-ink-faint" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-ink">
                        {document.title}
                      </span>
                      <Badge tone="neutral">
                        {document.documentType.replace(/_/g, ' ').toLowerCase()}
                      </Badge>
                      {document.signedAt ? (
                        <Badge tone="positive">Signed</Badge>
                      ) : null}
                      {blocked ? (
                        <Badge tone="critical">
                          <ShieldAlert aria-hidden />
                          {document.virusScanStatus === 'PENDING'
                            ? 'Being scanned'
                            : 'Failed scan'}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-2xs text-ink-faint">
                      {formatDate(document.createdAt)} ·{' '}
                      {formatBytes(document.sizeBytes)}
                      {document.signedByName ? ` · ${document.signedByName}` : ''}
                    </p>
                  </div>

                  {canShare ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={blocked}
                      title={
                        blocked
                          ? 'This file cannot be shared until scanning confirms it is clean'
                          : undefined
                      }
                      onClick={() => setSharing(document)}
                    >
                      <Share2 aria-hidden />
                      Share
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {sharing ? (
        <ShareDocumentDialog
          open
          onOpenChange={(next) => !next && setSharing(null)}
          documentId={sharing.id}
          documentType={sharing.documentType}
          documentTitle={sharing.title}
          patientName={sharing.patientName}
        />
      ) : null}
    </>
  );
}
