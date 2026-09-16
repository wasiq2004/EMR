'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Lock, Stethoscope } from 'lucide-react';
import { usePatientVisits } from '@/features/patients/api';
import { formatDate, relativeTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel, PanelHeader } from '@/components/ui/surface';
import { EmptyState, SkeletonRows } from '@/components/ui/feedback';

/**
 * Visit history.
 *
 * Amendments are shown as linked records rather than replacing what they
 * correct, so the history reads in the order it actually happened.
 */
export default function PatientVisitsPage() {
  const params = useParams<{ id: string }>();
  const { data, isLoading } = usePatientVisits(params.id);
  const visits = data ?? [];

  return (
    <Panel>
      <PanelHeader title="All visits" description={`${visits.length} recorded`} />
      {isLoading ? (
        <SkeletonRows rows={5} />
      ) : visits.length === 0 ? (
        <EmptyState
          icon={Stethoscope}
          title="No visits recorded"
          description="Consultations will appear here once the first one is completed."
        />
      ) : (
        <ul className="divide-y divide-line-soft">
          {visits.map((visit) => (
            <li key={visit.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink">
                    {formatDate(visit.startedAt)}
                  </span>
                  <span className="text-2xs text-ink-faint">
                    {relativeTime(visit.startedAt)}
                  </span>
                  {visit.isFinalized ? (
                    <Badge tone="positive">
                      <Lock aria-hidden />
                      Signed
                    </Badge>
                  ) : (
                    <Badge tone="warning">Draft</Badge>
                  )}
                  {visit.amendsEncounterId ? (
                    <Badge tone="info">Amendment</Badge>
                  ) : null}
                </div>

                <p className="mt-1 text-sm text-ink-soft">
                  {visit.chiefComplaint ?? 'No presenting complaint recorded'}
                </p>
                {visit.assessmentNotes ? (
                  <p className="mt-0.5 text-xs text-ink-faint">{visit.assessmentNotes}</p>
                ) : null}
                {visit.amendmentReason ? (
                  <p className="mt-1 text-xs text-info">
                    Corrects an earlier record: {visit.amendmentReason}
                  </p>
                ) : null}
              </div>

              <Button size="sm" variant="secondary" asChild>
                <Link href={`/encounters/${visit.id}`}>Open</Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
