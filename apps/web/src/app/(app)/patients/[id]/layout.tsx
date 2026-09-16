'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Phone } from 'lucide-react';
import { usePatient } from '@/features/patients/api';
import { ageDetail, ageGender, formatPhone } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { RouteTabs } from '@/components/ui/tabs';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { useCan } from '@/lib/session';

/**
 * The patient record shell: an identity header that never scrolls out of
 * context, plus route-backed tabs.
 *
 * Tabs are real routes rather than local state so a tab can be linked, opened
 * in a second window and survives a reload — all three happen constantly at a
 * front desk where one person is on the phone and another is at the counter.
 */
export default function PatientLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id: string }>();
  const patientId = params.id;
  const { data: patient, isLoading, isError } = usePatient(patientId);
  const canSeeClinical = useCan('encounterClinicalContent:read');
  const canSeeBilling = useCan('invoice:read');

  const tabs = [
    { label: 'Summary', href: `/patients/${patientId}`, exact: true },
    ...(canSeeClinical
      ? [{ label: 'Visits', href: `/patients/${patientId}/visits` }]
      : []),
    { label: 'Documents', href: `/patients/${patientId}/documents` },
    ...(canSeeBilling
      ? [{ label: 'Billing', href: `/patients/${patientId}/billing` }]
      : []),
    { label: 'Consent', href: `/patients/${patientId}/consents` },
  ];

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <Link
        href="/patients"
        className="inline-flex w-fit items-center gap-1.5 text-xs text-ink-faint hover:text-ink"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        All patients
      </Link>

      {isError ? (
        <Alert tone="critical" title="That patient record could not be opened">
          It may have been merged into another record, or you may not have access to it.
        </Alert>
      ) : isLoading || !patient ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-96" />
        </div>
      ) : (
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="text-2xl font-semibold tracking-tight text-ink">
              {patient.fullName}
            </h1>
            <span className="text-md text-ink-soft">{ageGender(patient)}</span>
            <span className="token rounded-sm bg-surface-sunk px-1.5 py-0.5 text-2xs text-ink-soft">
              {patient.mrn}
            </span>
            {patient.tags.map((tag) => (
              <Badge key={tag} tone="neutral">
                {tag}
              </Badge>
            ))}
            {patient.mergedIntoPatientId ? (
              <Badge tone="warning">Merged into another record</Badge>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-faint">
            <span className="inline-flex items-center gap-1.5">
              <Phone className="size-3.5" aria-hidden />
              <span className="token">{formatPhone(patient.mobileE164)}</span>
              {patient.mobileBelongsToRelative ? (
                <Badge tone="info">Relative&rsquo;s number</Badge>
              ) : null}
            </span>
            <span>{ageDetail(patient)}</span>
            {patient.city ? <span>{patient.city}</span> : null}
          </div>

          {/*
            A clinical alert is free text the clinic chose to pin to this
            patient. It sits above the tabs so it is visible on every tab, not
            only the summary.
          */}
          {patient.clinicalAlert ? (
            <Alert tone="warning" title={patient.clinicalAlert} />
          ) : null}
        </header>
      )}

      <RouteTabs items={tabs} />

      <div className="min-w-0">{children}</div>
    </div>
  );
}
