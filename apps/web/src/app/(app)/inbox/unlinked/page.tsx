'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Link2, MessageSquare } from 'lucide-react';
import type { PatientSummary } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { useConversations, useLinkConversation } from '@/features/inbox/api';
import { ageGender, formatPhone, relativeTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Panel, PanelHeader, PageHeader } from '@/components/ui/surface';
import { Alert, EmptyState, SkeletonRows } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';

/**
 * The unlinked queue.
 *
 * This is a first-class feature, not an error log. One mobile number routinely
 * serves an entire family in this market, so an inbound message matching
 * SEVERAL patients is as common as one matching none. Staff pick the right
 * person in one click, and that choice is recorded.
 *
 * These conversations carry health information about someone who may not yet be
 * a patient of record, which is the weakest position in the system — hence the
 * retention note below.
 */
export default function UnlinkedPage() {
  const { data, isLoading } = useConversations('unlinked');
  const conversations = data?.items ?? [];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Link
        href="/inbox"
        className="inline-flex w-fit items-center gap-1.5 text-xs text-ink-faint hover:text-ink"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Inbox
      </Link>

      <PageHeader
        title="Messages not matched to a patient"
        description="Usually because a number is shared by a family. Pick the right person."
      />

      <Alert tone="info" title="These are held for 30 days">
        A message that is never linked to a patient is deleted after 30 days,
        because it holds health information about someone who is not a patient of
        record here.
      </Alert>

      {isLoading ? (
        <SkeletonRows rows={3} />
      ) : conversations.length === 0 ? (
        <Panel>
          <EmptyState
            icon={MessageSquare}
            title="Nothing waiting"
            description="Every conversation is matched to a patient."
          />
        </Panel>
      ) : (
        conversations.map((conversation) => (
          <UnlinkedCard
            key={conversation.id}
            conversationId={conversation.id}
            counterparty={conversation.counterpartyE164}
            preview={conversation.lastMessagePreview}
            receivedAt={conversation.lastInboundAt}
            candidateIds={conversation.candidatePatientIds}
          />
        ))
      )}
    </div>
  );
}

function UnlinkedCard({
  conversationId,
  counterparty,
  preview,
  receivedAt,
  candidateIds,
}: {
  conversationId: string;
  counterparty: string;
  preview: string | null;
  receivedAt: string | null;
  candidateIds: string[];
}) {
  const link = useLinkConversation(conversationId);
  const toast = useToast();

  const { data } = useQuery({
    queryKey: qk.patients(counterparty),
    queryFn: () =>
      api.get<{ items: PatientSummary[] }>('/patients/search', {
        query: { q: counterparty },
      }),
  });

  const candidates = (data?.items ?? []).filter(
    (patient) => candidateIds.length === 0 || candidateIds.includes(patient.id),
  );

  const choose = async (patient: PatientSummary) => {
    await link.mutateAsync(patient.id);
    toast.success(`Linked to ${patient.fullName}`);
  };

  return (
    <Panel>
      <PanelHeader
        title={formatPhone(counterparty)}
        description={receivedAt ? `Received ${relativeTime(receivedAt)}` : undefined}
      />
      <div className="border-b border-line-soft px-4 py-3">
        <p className="rounded-md bg-surface-sunk px-3 py-2 text-sm text-ink">
          {preview ?? 'No message content'}
        </p>
      </div>

      <div className="px-4 py-3">
        <p className="text-2xs uppercase tracking-wide text-ink-faint">
          Who sent this?
        </p>
        {candidates.length === 0 ? (
          <p className="mt-2 text-xs text-ink-faint">
            No patient is registered on this number.{' '}
            <Link href="/patients/new" className="font-medium text-accent underline">
              Register them
            </Link>
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {candidates.map((patient) => (
              <li key={patient.id}>
                <button
                  type="button"
                  onClick={() => choose(patient)}
                  className="flex w-full items-center gap-3 rounded-md border border-line px-3 py-2 text-left hover:border-accent hover:bg-accent-soft/40"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-ink">
                      {patient.fullName}
                    </span>
                    <span className="block text-2xs text-ink-faint">
                      {ageGender(patient)} · <span className="token">{patient.mrn}</span>
                    </span>
                  </span>
                  <Link2 className="size-4 shrink-0 text-accent" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
