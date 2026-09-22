'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Conversation, PatientSummary } from '@emr/contracts';
import { api, ApiError } from '@/lib/api-client';
import { formatPhone } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useLinkConversation } from './api';

/**
 * Attaching an unlinked conversation to a patient.
 *
 * THE UNLINKED QUEUE IS AN EXPECTED PATH, NOT AN ERROR LOG. One mobile number
 * routinely serves a whole family in this market, so an inbound message
 * matching several patients is as common as one matching none. That is why the
 * dialog opens on the candidates the number already matched rather than on an
 * empty search box — the usual answer is "it is one of these three".
 *
 * Linking is not reversible from here on purpose. It moves every message
 * already received into that patient's clinical record, and a control that
 * quietly moves messages between records is worse than one that makes you go
 * and undo it deliberately.
 */
export function LinkConversationDialog({
  conversation,
  onClose,
  onLinked,
}: {
  conversation: Conversation | null;
  onClose: () => void;
  onLinked: () => void;
}) {
  const toast = useToast();
  const [term, setTerm] = React.useState('');
  const [chosen, setChosen] = React.useState<string | null>(null);

  const link = useLinkConversation(conversation?.id ?? '');

  React.useEffect(() => {
    // The number itself is the best first search: if the family is already
    // registered, this finds them without anyone typing a name.
    setTerm(conversation?.counterpartyE164?.replace(/\D/g, '').slice(-10) ?? '');
    setChosen(null);
  }, [conversation]);

  const results = useQuery({
    queryKey: ['inbox', 'link-search', term],
    queryFn: () =>
      api.get<{ items: PatientSummary[] }>('/patients/search', {
        query: { q: term.trim(), limit: 8 },
      }),
    enabled: Boolean(conversation) && term.trim().length >= 3,
  });

  const submit = async () => {
    if (!chosen || !conversation) return;
    try {
      await link.mutateAsync(chosen);
      toast.success('Conversation linked');
      onLinked();
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'That conversation could not be linked',
      );
    }
  };

  return (
    <Dialog open={Boolean(conversation)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link this conversation to a patient</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-ink-soft">
          Messages from{' '}
          <span className="token">
            {conversation ? formatPhone(conversation.counterpartyE164) : ''}
          </span>
          . One number often serves a family, so check which member this is.
        </p>

        <Alert tone="warning" title="This moves the messages into that record">
          Everything already received on this number becomes part of the chosen
          patient&rsquo;s clinical record. Undoing it means moving them back by
          hand.
        </Alert>

        <label htmlFor="link-search" className="sr-only">
          Search patients
        </label>
        <Input
          id="link-search"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Name, mobile number or MRN"
          autoComplete="off"
        />

        <div className="max-h-64 overflow-y-auto scroll-thin">
          {results.data?.items.length === 0 ? (
            <p className="py-4 text-center text-sm text-ink-faint">
              No patient matches that. Register them first, then link.
            </p>
          ) : null}

          <ul className="flex flex-col gap-1">
            {(results.data?.items ?? []).map((patient) => (
              <li key={patient.id}>
                <button
                  type="button"
                  onClick={() => setChosen(patient.id)}
                  aria-pressed={chosen === patient.id}
                  className={
                    chosen === patient.id
                      ? 'w-full rounded-md border border-accent bg-accent-soft px-3 py-2 text-left'
                      : 'w-full rounded-md border border-line-soft px-3 py-2 text-left hover:bg-surface-sunk'
                  }
                >
                  <p className="text-sm font-medium text-ink">{patient.fullName}</p>
                  <p className="text-2xs text-ink-faint">
                    <span className="token">{patient.mrn}</span>
                    {patient.mobileE164 ? (
                      <>
                        {' · '}
                        <span className="token">{formatPhone(patient.mobileE164)}</span>
                      </>
                    ) : null}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!chosen}
            loading={link.isPending}
            onClick={submit}
          >
            Link conversation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
