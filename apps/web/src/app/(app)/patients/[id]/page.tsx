'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  Activity,
  ChevronDown,
  FileText,
  Pill,
  Stethoscope,
  Thermometer,
} from 'lucide-react';
import type { Observation } from '@emr/contracts';
import { usePatientSnapshot } from '@/features/patients/api';
import { AllergyBanner } from '@/features/patients/allergy-banner';
import { RecordAllergyDialog } from '@/features/patients/record-allergy-dialog';
import { RecordVitalsDialog } from '@/features/patients/record-vitals-dialog';
import { VitalsGrid } from '@/features/patients/vitals-grid';
import { useStartConsultation } from '@/features/queue/api';
import { useCan, useSession } from '@/lib/session';
import { formatDate, formatPaiseShort, relativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Alert, EmptyState, ErrorState, Skeleton } from '@/components/ui/feedback';

/**
 * ============================ THE PATIENT SNAPSHOT ==========================
 *
 * This screen and the consultation screen are the two the pilot acceptance gate
 * turns on. Three constraints shape everything below, and none of them is a
 * preference:
 *
 *   1. ALLERGIES ARE VISIBLE WITHOUT SCROLLING and look unlike anything else.
 *      Five of five doctors must name the allergy unprompted.
 *   2. THE WHOLE THING RENDERS IN UNDER A SECOND. One aggregate request, not
 *      six. Below a second, doctors stop opening it at all.
 *   3. NOBODY SHOULD HAVE TO NAVIGATE AWAY AND BACK. Recent visits expand in
 *      place; current medicines and vitals are on the same screen.
 *
 * There is exactly one primary action: start the consultation.
 * ===========================================================================
 */
export default function PatientSnapshotPage() {
  const params = useParams<{ id: string }>();
  const patientId = params.id;
  const router = useRouter();
  const session = useSession();

  const { data, isLoading, isError, refetch } = usePatientSnapshot(patientId);
  const startConsultation = useStartConsultation();

  const canStartConsultation = useCan('encounter:create');
  const canRecordAllergy = useCan('allergy:create');
  const canRecordVitals = useCan('observation:create');
  const canSeeClinical = useCan('encounterClinicalContent:read');

  const [allergyOpen, setAllergyOpen] = React.useState(false);
  const [vitalsOpen, setVitalsOpen] = React.useState(false);

  const start = async () => {
    const encounter = await startConsultation.mutateAsync({ patientId });
    router.push(`/encounters/${encounter.id}`);
  };

  if (isError) {
    return <ErrorState description="The patient summary did not load." onRetry={() => void refetch()} />;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Allergies first. Always. */}
      {isLoading || !data ? (
        <Skeleton className="h-20 w-full" />
      ) : (
        <AllergyBanner
          allergies={data.allergies}
          canAdd={canRecordAllergy}
          onAdd={() => setAllergyOpen(true)}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {canStartConsultation ? (
          <Button
            variant="primary"
            size="lg"
            onClick={start}
            loading={startConsultation.isPending}
          >
            <Stethoscope aria-hidden />
            Start consultation
          </Button>
        ) : null}
        {canRecordVitals ? (
          <Button variant="secondary" onClick={() => setVitalsOpen(true)}>
            <Thermometer aria-hidden />
            Record vitals
          </Button>
        ) : null}
        <Button variant="secondary" asChild>
          <Link href={`/patients/${patientId}/edit`}>Edit details</Link>
        </Button>
        {data && data.outstandingPaise > 0 ? (
          <Badge tone="warning" className="ml-auto">
            {formatPaiseShort(data.outstandingPaise)} outstanding
          </Badge>
        ) : null}
      </div>

      {/*
        Reception sees the identity header, documents and billing, but not the
        clinical body of this screen. That is why encounter:read and
        encounterClinicalContent:read are separate permissions.
      */}
      {!canSeeClinical ? (
        <Alert tone="info" title="Clinical details are not shown for your role">
          You can see appointments, documents and billing for this patient. The
          consultation record is visible to clinicians only.
        </Alert>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
          <div className="flex min-w-0 flex-col gap-4">
            <RecentVisits
              loading={isLoading}
              visits={data?.recentEncounters ?? []}
              patientId={patientId}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <CurrentMedicines
              loading={isLoading}
              medicines={data?.activeMedications ?? []}
            />
            <Problems loading={isLoading} conditions={data?.conditions ?? []} />
            <LatestVitals loading={isLoading} vitals={data?.latestVitals ?? []} />
            <RecentDocuments
              loading={isLoading}
              documents={data?.recentDocuments ?? []}
              patientId={patientId}
            />
          </div>
        </div>
      )}

      <RecordAllergyDialog
        patientId={patientId}
        open={allergyOpen}
        onOpenChange={setAllergyOpen}
      />
      <RecordVitalsDialog
        patientId={patientId}
        open={vitalsOpen}
        onOpenChange={setVitalsOpen}
        recordedByName={session.fullName}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * Recent visits — expandable in place, never a navigation
 * ------------------------------------------------------------------------- */

function RecentVisits({
  loading,
  visits,
  patientId,
}: {
  loading: boolean;
  visits: {
    id: string;
    startedAt: string;
    practitionerName: string;
    chiefComplaint: string | null;
    diagnoses: string[];
    isFinalized: boolean;
  }[];
  patientId: string;
}) {
  const [expanded, setExpanded] = React.useState<string | null>(visits[0]?.id ?? null);

  React.useEffect(() => {
    if (expanded === null && visits[0]) setExpanded(visits[0].id);
  }, [visits, expanded]);

  return (
    <Panel>
      <PanelHeader
        title="Recent visits"
        description="Most recent first"
        actions={
          <Button size="sm" variant="ghost" asChild>
            <Link href={`/patients/${patientId}/visits`}>All visits</Link>
          </Button>
        }
      />
      {loading ? (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : visits.length === 0 ? (
        <EmptyState
          icon={Stethoscope}
          title="No previous visits"
          description="This is the patient's first consultation at this clinic."
        />
      ) : (
        <ul className="divide-y divide-line-soft">
          {visits.map((visit) => {
            const open = expanded === visit.id;
            return (
              <li key={visit.id}>
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : visit.id)}
                  aria-expanded={open}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-sunk"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium text-ink">
                        {formatDate(visit.startedAt)}
                      </span>
                      <span className="text-2xs text-ink-faint">
                        {relativeTime(visit.startedAt)} · {visit.practitionerName}
                      </span>
                      {!visit.isFinalized ? (
                        <Badge tone="warning">Draft</Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 truncate text-sm text-ink-soft">
                      {visit.chiefComplaint ?? 'No presenting complaint recorded'}
                    </p>
                    {visit.diagnoses.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {visit.diagnoses.map((diagnosis) => (
                          <Badge key={diagnosis} tone="neutral">
                            {diagnosis}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <ChevronDown
                    className={cn(
                      'mt-1 size-4 shrink-0 text-ink-faint transition-transform',
                      open && 'rotate-180',
                    )}
                    aria-hidden
                  />
                </button>

                {open ? (
                  <div className="border-t border-line-soft bg-surface-sunk/40 px-4 py-3">
                    <Button size="sm" variant="secondary" asChild>
                      <Link href={`/encounters/${visit.id}`}>Open this consultation</Link>
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------------- *
 * Current medicines
 * ------------------------------------------------------------------------- */

function CurrentMedicines({
  loading,
  medicines,
}: {
  loading: boolean;
  medicines: {
    id: string;
    drugDisplayName: string;
    strength: string | null;
    frequency: string;
    authoredAt: string;
  }[];
}) {
  return (
    <Panel>
      <PanelHeader title="Current medicines" description={`${medicines.length} active`} />
      {loading ? (
        <div className="p-4">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : medicines.length === 0 ? (
        <EmptyState icon={Pill} title="No current medicines" />
      ) : (
        <ul className="divide-y divide-line-soft">
          {medicines.map((medicine) => (
            <li key={medicine.id} className="px-4 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium text-ink">
                  {medicine.drugDisplayName}
                </span>
                <span className="token shrink-0 text-xs text-ink-soft">
                  {medicine.frequency}
                </span>
              </div>
              <p className="text-2xs text-ink-faint">
                {medicine.strength ? `${medicine.strength} · ` : ''}
                since {formatDate(medicine.authoredAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------------- *
 * Problems — chronic pinned first
 * ------------------------------------------------------------------------- */

function Problems({
  loading,
  conditions,
}: {
  loading: boolean;
  conditions: { id: string; displayText: string; isChronic: boolean; code: string | null }[];
}) {
  return (
    <Panel>
      <PanelHeader title="Problems" description="Active diagnoses, chronic first" />
      {loading ? (
        <div className="p-4">
          <Skeleton className="h-12 w-full" />
        </div>
      ) : conditions.length === 0 ? (
        <EmptyState icon={Activity} title="No active problems recorded" />
      ) : (
        <PanelBody className="flex flex-wrap gap-1.5">
          {conditions.map((condition) => (
            <Badge key={condition.id} tone={condition.isChronic ? 'chronic' : 'neutral'}>
              {condition.displayText}
              {condition.isChronic ? ' · chronic' : ''}
            </Badge>
          ))}
        </PanelBody>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------------- *
 * Latest vitals — out-of-range values marked, never colour alone
 * ------------------------------------------------------------------------- */

function LatestVitals({ loading, vitals }: { loading: boolean; vitals: Observation[] }) {
  return (
    <Panel>
      <PanelHeader title="Latest vitals" />
      {loading ? (
        <div className="p-4">
          <Skeleton className="h-12 w-full" />
        </div>
      ) : vitals.length === 0 ? (
        <EmptyState icon={Thermometer} title="No vitals recorded" />
      ) : (
        <PanelBody>
          {/*
            The shared grid. This was a near-copy of the consultation screen's
            panel that had drifted: it rendered CRITICAL as "Below range", which
            describes the loudest reading in the system with the wrong word.
          */}
          <VitalsGrid vitals={vitals} />
        </PanelBody>
      )}
    </Panel>
  );
}

function RecentDocuments({
  loading,
  documents,
  patientId,
}: {
  loading: boolean;
  documents: { id: string; title: string; documentType: string; createdAt: string }[];
  patientId: string;
}) {
  return (
    <Panel>
      <PanelHeader
        title="Documents"
        actions={
          <Button size="sm" variant="ghost" asChild>
            <Link href={`/patients/${patientId}/documents`}>All</Link>
          </Button>
        }
      />
      {loading ? (
        <div className="p-4">
          <Skeleton className="h-10 w-full" />
        </div>
      ) : documents.length === 0 ? (
        <EmptyState icon={FileText} title="No documents yet" />
      ) : (
        <ul className="divide-y divide-line-soft">
          {documents.slice(0, 4).map((document) => (
            <li key={document.id} className="px-4 py-2">
              <Link
                href={`/documents/${document.id}`}
                className="text-sm text-ink hover:underline"
              >
                {document.title}
              </Link>
              <p className="text-2xs text-ink-faint">{formatDate(document.createdAt)}</p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
