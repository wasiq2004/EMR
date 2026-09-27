'use client';

import * as React from 'react';
import Link from 'next/link';
import { MessageCircleQuestion } from 'lucide-react';
import {
  RESOLUTION_ACTION_LABEL,
  type ClarificationRow,
  type ResolutionAction,
} from '@emr/contracts';
import {
  useAnswerClarification,
  useClarifications,
  useWithdrawClarification,
} from '@/features/pharmacy/api';
import { useSession } from '@/lib/session';
import { ApiError } from '@/lib/api-client';
import { formatMinutes, relativeTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { DataState } from '@/components/ui/data-state';
import { Alert } from '@/components/ui/feedback';
import { PageHeader, Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * The clarification loop, from both ends.
 *
 * ONE SCREEN, TWO AUDIENCES, and which one you are is decided by your permissions
 * rather than by a toggle. A pharmacist sees what they are waiting on and can
 * withdraw a question they no longer need answered. A doctor sees what they must
 * answer and cannot withdraw anything — withdrawing is the asker's prerogative.
 *
 * This is the blueprint's competitive point made concrete: everywhere else this
 * conversation happens on the phone, so the reason a prescription was changed
 * survives only in someone's memory.
 */
export default function ClarificationsPage() {
  const session = useSession();
  const [status, setStatus] = React.useState<'OPEN' | 'ANSWERED'>('OPEN');

  const canAnswer = session.role === 'DOCTOR';
  const query = useClarifications(
    // A doctor's list is their own prescriptions; nobody else's queries are theirs
    // to answer, and showing them would be noise they cannot act on.
    canAnswer && status === 'OPEN' ? { mine: true } : { status },
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title={canAnswer ? 'Questions for you' : 'Clarifications'}
        description={
          canAnswer
            ? 'The pharmacy counter has asked about these prescriptions. Your answer is attached to the record.'
            : 'Questions raised at the counter, and what the prescriber said.'
        }
      />

      {/* A two-way filter, so segmented buttons rather than routed tabs — the
          state is not worth a URL and a back button that cycles a filter is
          worse than one that leaves the page. */}
      <div
        className="inline-flex rounded-md border border-line bg-surface p-0.5"
        role="group"
        aria-label="Filter by status"
      >
        {(['OPEN', 'ANSWERED'] as const).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={status === value ? 'secondary' : 'ghost'}
            aria-pressed={status === value}
            className={status === value ? 'bg-accent-soft text-accent-ink' : undefined}
            onClick={() => setStatus(value)}
          >
            {value === 'OPEN' ? 'Open' : 'Answered'}
          </Button>
        ))}
      </div>

      <Panel>
        <PanelHeader
          title={status === 'OPEN' ? 'Awaiting an answer' : 'Answered'}
          description={
            status === 'OPEN' && !canAnswer
              ? 'The patient cannot be served on these until the prescriber replies.'
              : undefined
          }
        />
        <PanelBody className="space-y-3">
          <DataState
            query={query}
            empty={{
              icon: MessageCircleQuestion,
              title: status === 'OPEN' ? 'Nothing waiting' : 'Nothing answered yet',
              description:
                status === 'OPEN'
                  ? 'Questions raised at the pharmacy counter appear here.'
                  : undefined,
            }}
          >
            {(items) =>
              items.map((row) => (
                <ClarificationCard key={row.id} row={row} canAnswer={canAnswer} />
              ))
            }
          </DataState>
        </PanelBody>
      </Panel>
    </div>
  );
}

function ClarificationCard({
  row,
  canAnswer,
}: {
  row: ClarificationRow;
  canAnswer: boolean;
}) {
  const [answerOpen, setAnswerOpen] = React.useState(false);
  const [withdrawOpen, setWithdrawOpen] = React.useState(false);

  /*
   * Thirty minutes. A patient is usually still in the building at that point, and
   * after it they are usually not — which is the difference between answering a
   * question and rescheduling a collection.
   */
  const urgent = row.status === 'OPEN' && row.waitingMinutes >= 30;

  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-ink">{row.drugDisplayName}</span>
            {row.strength ? (
              <span className="token text-xs text-ink-soft">{row.strength}</span>
            ) : null}
            <Badge tone={row.status === 'OPEN' ? 'warning' : 'positive'}>
              {row.status === 'OPEN' ? 'Open' : 'Answered'}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-ink-faint">
            {row.patientName}
            {row.patientAgeYears !== null ? `, ${row.patientAgeYears}y` : ''} ·{' '}
            {row.frequency} · prescribed by {row.prescriberName}
          </p>
        </div>

        <span
          className={
            urgent ? 'tabular text-2xs font-semibold text-critical' : 'tabular text-2xs text-ink-faint'
          }
        >
          {row.status === 'OPEN'
            ? `waiting ${formatMinutes(row.waitingMinutes)}`
            : relativeTime(row.answeredAt ?? row.raisedAt)}
        </span>
      </div>

      <p className="mt-2 rounded-md bg-surface-sunk px-2.5 py-1.5 text-sm text-ink">
        {row.question}
      </p>
      <p className="mt-1 text-2xs text-ink-faint">
        Asked by {row.raisedByName ?? 'the counter'}
      </p>

      {row.answer ? (
        <div className="mt-2 rounded-md border border-positive-line bg-positive-soft px-2.5 py-1.5">
          <p className="text-sm text-ink">{row.answer}</p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-ink-faint">
            {row.resolutionAction ? (
              <Badge tone="positive">{RESOLUTION_ACTION_LABEL[row.resolutionAction]}</Badge>
            ) : null}
            {row.answeredByName ?? 'the prescriber'}
          </p>
        </div>
      ) : null}

      {row.status === 'OPEN' ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {canAnswer ? (
            <Button size="sm" variant="primary" onClick={() => setAnswerOpen(true)}>
              Answer
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setWithdrawOpen(true)}>
              Withdraw — resolved at the counter
            </Button>
          )}
          {row.dispenseRecordId ? (
            <Button size="sm" variant="ghost" asChild>
              <Link href={`/pharmacy/queue/${row.dispenseRecordId}`}>Open prescription</Link>
            </Button>
          ) : null}
        </div>
      ) : null}

      <AnswerDialog open={answerOpen} onOpenChange={setAnswerOpen} row={row} />
      <WithdrawDialog open={withdrawOpen} onOpenChange={setWithdrawOpen} row={row} />
    </div>
  );
}

const ACTIONS: ResolutionAction[] = [
  'CONFIRMED_AS_WRITTEN',
  'SUBSTITUTE_APPROVED',
  'DOSE_CLARIFIED',
  'CANCEL_THIS_ITEM',
  'PATIENT_TO_RETURN',
];

function AnswerDialog({
  open,
  onOpenChange,
  row,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: ClarificationRow;
}) {
  const toast = useToast();
  const answer = useAnswerClarification();
  const [text, setText] = React.useState('');
  const [action, setAction] = React.useState<ResolutionAction>('CONFIRMED_AS_WRITTEN');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Answer about {row.drugDisplayName}</DialogTitle>
        </DialogHeader>

        <p className="rounded-md bg-surface-sunk px-2.5 py-1.5 text-sm text-ink-soft">
          {row.question}
        </p>

        <Field
          label="What should the counter do"
          htmlFor="resolution-action"
          required
          hint="A code as well as a sentence, so the pharmacist does not have to interpret one."
        >
          <Select
            id="resolution-action"
            value={action}
            onChange={(event) => setAction(event.target.value as ResolutionAction)}
          >
            {ACTIONS.map((value) => (
              <option key={value} value={value}>
                {RESOLUTION_ACTION_LABEL[value]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Your answer" htmlFor="answer-text" required>
          <Input
            id="answer-text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Two 250mg tablets is correct — same total dose"
          />
        </Field>

        <Alert tone="info" title="This does not change the prescription">
          A finalised prescription is never edited. Your answer is recorded against
          it, and the counter acts on the decision above.
        </Alert>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={text.trim().length < 3}
            loading={answer.isPending}
            onClick={() =>
              answer.mutate(
                { id: row.id, answer: text, resolutionAction: action },
                {
                  onSuccess: () => {
                    toast.success('Answer sent to the counter');
                    setText('');
                    onOpenChange(false);
                  },
                  onError: (error) =>
                    toast.error(error instanceof ApiError ? error.message : 'That did not send'),
                },
              )
            }
          >
            Send answer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WithdrawDialog({
  open,
  onOpenChange,
  row,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: ClarificationRow;
}) {
  const toast = useToast();
  const withdraw = useWithdrawClarification();
  const [reason, setReason] = React.useState('');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Withdraw the question</DialogTitle>
        </DialogHeader>

        <Alert tone="info" title="The question stays on the record">
          Withdrawing releases the prescription so you can dispense it. The question
          and this reason remain visible, because the next person to look at this
          prescription needs to know it was queried.
        </Alert>

        <Field label="Why no longer needed" htmlFor="withdraw-reason" required>
          <Input
            id="withdraw-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Found the prescribed strength in a second batch"
          />
        </Field>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Keep waiting
          </Button>
          <Button
            variant="secondary"
            disabled={reason.trim().length < 5}
            loading={withdraw.isPending}
            onClick={() =>
              withdraw.mutate(
                { id: row.id, reason },
                {
                  onSuccess: () => {
                    toast.success('Question withdrawn');
                    onOpenChange(false);
                  },
                  onError: (error) =>
                    toast.error(error instanceof ApiError ? error.message : 'That did not save'),
                },
              )
            }
          >
            Withdraw
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
