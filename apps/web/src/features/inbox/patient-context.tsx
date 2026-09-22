'use client';

import * as React from 'react';
import Link from 'next/link';
import { ExternalLink, Link2Off, TriangleAlert } from 'lucide-react';
import type { Conversation } from '@emr/contracts';
import { usePatient, usePatientSnapshot } from '@/features/patients/api';
import { formatDate, formatPhone } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/feedback';

/**
 * Who this conversation is with.
 *
 * This panel is the reason the inbox is part of an EMR rather than a chat app
 * bolted onto one. Someone answering "is my report ready?" needs the allergy,
 * the last visit and what they are on — in the same glance, not a tab away —
 * because the reply they are about to type is a clinical act whether or not
 * anyone calls it one.
 *
 * It is READ ONLY. Nothing clinical is edited from the inbox: the record is
 * changed in the record, where the audit trail expects it and where the person
 * changing it can see everything around it.
 */
export function PatientContextPanel({
  conversation,
  onLinkRequested,
}: {
  conversation: Conversation;
  onLinkRequested: () => void;
}) {
  const patientId = conversation.patientId;

  // Two queries rather than one, because the snapshot is an aggregate keyed by
  // patient id and does not carry the patient's own name or MRN — which is the
  // first thing this panel has to show.
  const patient = usePatient(patientId ?? '');
  const snapshot = usePatientSnapshot(patientId ?? '');

  return (
    <aside
      className="hidden w-72 shrink-0 flex-col border-l border-line bg-surface xl:flex"
      aria-label="Patient details"
    >
      {!patientId ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
          <Link2Off className="size-6 text-ink-faint" aria-hidden />
          <p className="text-sm text-ink-soft">
            This conversation is not linked to a patient, so there is no record
            to show.
          </p>
          <Button size="sm" variant="secondary" onClick={onLinkRequested}>
            Link to a patient
          </Button>
        </div>
      ) : snapshot.isLoading ? (
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : snapshot.data ? (
        <div className="scroll-thin flex-1 overflow-y-auto">
          <div className="border-b border-line-soft p-4">
            <p className="text-sm font-semibold text-ink">
              {patient.data?.fullName ?? conversation.patientName ?? 'Patient'}
            </p>
            <p className="mt-0.5 text-2xs text-ink-faint">
              <span className="token">{patient.data?.mrn ?? ''}</span>
              {' · '}
              <span className="token">
                {formatPhone(conversation.counterpartyE164)}
              </span>
            </p>

            <Button size="sm" variant="secondary" asChild className="mt-3 w-full">
              <Link href={`/patients/${patientId}`}>
                Open the record
                <ExternalLink aria-hidden />
              </Link>
            </Button>
          </div>

          {/*
            Allergies first and unmissable, exactly as on the Snapshot. The one
            place this panel must not be quieter than the record is the one
            thing that makes a wrong reply dangerous.
          */}
          {snapshot.data.allergies.length > 0 ? (
            <Section title="Allergies">
              <div className="flex flex-col gap-1.5">
                {snapshot.data.allergies.map((allergy) => (
                  <div
                    key={allergy.id}
                    className="rounded-md border border-critical-line bg-critical-soft px-2.5 py-1.5"
                  >
                    <p className="flex items-center gap-1.5 text-xs font-semibold text-critical">
                      <TriangleAlert className="size-3" aria-hidden />
                      {allergy.substanceText}
                    </p>
                    {allergy.criticality === 'HIGH' ? (
                      <Badge tone="critical" className="mt-1">
                        High risk
                      </Badge>
                    ) : null}
                  </div>
                ))}
              </div>
            </Section>
          ) : null}

          {snapshot.data.activeMedications.length > 0 ? (
            <Section title="Current medicines">
              <ul className="flex flex-col gap-1">
                {snapshot.data.activeMedications.slice(0, 6).map((medication) => (
                  <li key={medication.id} className="text-xs text-ink-soft">
                    <span className="font-medium text-ink">
                      {medication.drugDisplayName}
                    </span>
                    {medication.frequency ? ` · ${medication.frequency}` : ''}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {snapshot.data.recentEncounters.length > 0 ? (
            <Section title="Last visits">
              <ul className="flex flex-col gap-1.5">
                {snapshot.data.recentEncounters.slice(0, 3).map((encounter) => (
                  <li key={encounter.id} className="text-xs">
                    <p className="text-ink">{formatDate(encounter.startedAt)}</p>
                    <p className="text-ink-faint">
                      {encounter.chiefComplaint ?? 'No presenting complaint recorded'}
                    </p>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>
      ) : (
        <p className="p-4 text-sm text-ink-faint">
          That patient record could not be loaded.
        </p>
      )}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line-soft p-4">
      <h3 className="mb-2 text-2xs font-medium uppercase tracking-wide text-ink-faint">
        {title}
      </h3>
      {children}
    </section>
  );
}
