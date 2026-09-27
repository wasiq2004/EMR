'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Check,
  MessageCircleQuestion,
  PackageX,
  ShoppingCart,
} from 'lucide-react';
import {
  DISPENSE_STATUS_LABEL,
  RESOLUTION_ACTION_LABEL,
  suggestedQuantity,
  type DispenseLineDetail,
} from '@emr/contracts';
import {
  useCompleteDispense,
  useDispense,
  useFillLine,
  useRaiseClarification,
  useStartDispense,
} from '@/features/pharmacy/api';
import { ApiError } from '@/lib/api-client';
import { formatDate, formatMinutes, formatPaise } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { RecordState } from '@/components/ui/data-state';
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
import { cn } from '@/lib/cn';

/**
 * The dispensing workspace.
 *
 * ONE SCREEN, ONE PRESCRIPTION, ONE ROW PER ITEM. Each row shows what the doctor
 * ordered on the left — read-only, always, and visibly so — and what the counter is
 * doing about it on the right. The asymmetry is the point: a pharmacist can change
 * the right-hand side and can never change the left.
 *
 * EVERY ROW IS INDEPENDENT. Three items go out, the fourth is out of stock, and the
 * pharmacist records that without re-entering the three. This is what "partial
 * dispense" means in practice, and building it as one big form would have made it
 * impossible.
 *
 * BATCHES ARE OFFERED, NEAREST EXPIRY FIRST, AND EXPIRED ONES ARE ABSENT. Not
 * greyed out — absent. A batch that cannot legally be dispensed has no business
 * being one click away from being dispensed.
 */
export default function DispenseWorkspacePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();

  const id = params.id;
  const dispense = useDispense(id);
  const start = useStartDispense();
  const complete = useCompleteDispense();

  const record = dispense.data;

  /*
   * Claiming the prescription on open, once.
   *
   * So two people at two terminals do not prepare the same basket. Fired on mount
   * rather than behind a button because opening it IS the claim — an extra click
   * that everyone learns to make is not a safeguard.
   */
  const claimed = React.useRef(false);
  React.useEffect(() => {
    if (!record || claimed.current) return;
    if (record.status === 'PENDING') {
      claimed.current = true;
      start.mutate(id);
    }
  }, [record, id, start]);

  const canComplete =
    record !== undefined &&
    record.openClarificationCount === 0 &&
    record.status !== 'DISPENSED' &&
    record.status !== 'CANCELLED' &&
    record.lines.every((line) => line.quantityDispensed > 0 || line.notDispensedReason);

  return (
    <div className="space-y-5">
      <PageHeader
        breadcrumb={
          <Link
            href="/pharmacy"
            className="inline-flex items-center gap-1 text-xs text-ink-faint hover:text-ink"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            Prescription queue
          </Link>
        }
        title={record ? record.patientName : 'Prescription'}
        description={
          record
            ? `${record.itemCount} item${record.itemCount === 1 ? '' : 's'} · prescribed by ${record.prescriberName} · waiting ${formatMinutes(record.waitingMinutes)}`
            : undefined
        }
        actions={
          record ? (
            <div className="flex items-center gap-2">
              <Badge tone={record.status === 'READY' ? 'positive' : 'neutral'}>
                {DISPENSE_STATUS_LABEL[record.status]}
              </Badge>
              {record.saleId ? (
                <Badge tone="info">Charged {formatPaise(record.saleTotalPaise ?? 0)}</Badge>
              ) : (
                <Button variant="secondary" asChild>
                  <Link href={`/pharmacy/sales?dispenseId=${record.id}`}>
                    <ShoppingCart aria-hidden />
                    Charge
                  </Link>
                </Button>
              )}
              <Button
                variant="primary"
                disabled={!canComplete}
                loading={complete.isPending}
                onClick={() =>
                  complete.mutate(id, {
                    onSuccess: () => {
                      toast.success('Prescription dispensed');
                      router.push('/pharmacy');
                    },
                    onError: (error) =>
                      toast.error(
                        error instanceof ApiError ? error.message : 'That did not save',
                      ),
                  })
                }
              >
                <Check aria-hidden />
                Hand over
              </Button>
            </div>
          ) : null
        }
      />

      <RecordState
        query={dispense}
        notFound={{
          title: 'That prescription could not be found',
          description: 'It may have been cancelled. Go back to the queue.',
        }}
      >
        {(detail) => (
          <div className="space-y-4">
            {/*
              The allergy banner, at the top and unmissable. Same component
              language as the consultation screen so a pharmacist and a doctor are
              reading the same warning in the same shape.
            */}
            {detail.allergySummary.length > 0 ? (
              <Alert tone="critical" title="This patient has a recorded allergy">
                <div className="flex flex-wrap items-center gap-1.5">
                  {detail.allergySummary.map((substance) => (
                    <Badge key={substance} tone="alarm">
                      {substance}
                    </Badge>
                  ))}
                </div>
                <p className="mt-1.5 text-xs">
                  Check every item below against this before handing anything over.
                </p>
              </Alert>
            ) : null}

            {detail.openClarificationCount > 0 ? (
              <Alert tone="warning" title="Waiting on the prescriber">
                A question has been raised on this prescription. It cannot be handed
                over until the answer arrives, or the question is withdrawn.
              </Alert>
            ) : null}

            {detail.lines.map((line) => (
              <LineCard key={line.id} line={line} dispenseId={detail.id} />
            ))}
          </div>
        )}
      </RecordState>
    </div>
  );
}

/**
 * One prescribed item.
 *
 * The ordered side is rendered as read-only text with no input anywhere near it.
 * That is not only a permissions matter — it is so the pharmacist can see at a
 * glance which half of the row is a fact and which half is their decision.
 */
function LineCard({ line, dispenseId }: { line: DispenseLineDetail; dispenseId: string }) {
  const toast = useToast();
  const fill = useFillLine();

  const batches = line.availableBatches ?? [];
  const openQuestion = line.clarifications.find((c) => c.status === 'OPEN');
  const answered = line.clarifications.filter((c) => c.status === 'ANSWERED');

  /* The suggested quantity, derived once from the order rather than typed. */
  const suggested =
    line.quantityPrescribed ?? suggestedQuantity(line.frequency, line.durationDays);

  const [batchId, setBatchId] = React.useState(line.stockBatchId ?? '');
  const [quantity, setQuantity] = React.useState(
    String(line.quantityDispensed || suggested || ''),
  );
  const [reason, setReason] = React.useState(line.substitutionReason ?? '');
  const [askOpen, setAskOpen] = React.useState(false);
  const [declineOpen, setDeclineOpen] = React.useState(false);

  const chosen = batches.find((b) => b.stockBatchId === batchId);
  const isSubstitution = chosen?.isSubstitution ?? false;
  const done = line.quantityDispensed > 0;

  const save = () =>
    fill.mutate(
      {
        lineId: line.id,
        input: {
          stockBatchId: batchId || null,
          quantityDispensed: Number(quantity) || 0,
          isSubstitution,
          substitutionReason: isSubstitution ? reason : null,
          unitPricePaise: null,
          notDispensedReason: null,
        },
      },
      {
        onSuccess: () => toast.success(`${line.orderedDrugName} recorded`),
        onError: (error) =>
          toast.error(error instanceof ApiError ? error.message : 'That did not save'),
      },
    );

  return (
    <Panel className={cn(done && 'border-positive-line')}>
      <PanelHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {line.orderedDrugName}
            {line.orderedStrength ? (
              <span className="token text-xs text-ink-soft">{line.orderedStrength}</span>
            ) : null}
            {done ? <Badge tone="positive">Dispensed {line.quantityDispensed}</Badge> : null}
            {line.isSubstitution ? <Badge tone="warning">Substituted</Badge> : null}
            {line.notDispensedReason ? <Badge tone="neutral">Not dispensed</Badge> : null}
          </span>
        }
        description={[
          line.frequency,
          line.durationDays ? `for ${line.durationDays} days` : null,
          line.timingRelativeToFood,
          line.orderedRoute,
        ]
          .filter(Boolean)
          .join(' · ')}
      />

      <PanelBody className="space-y-3">
        {line.instructions ? (
          <p className="rounded-md bg-surface-sunk px-2.5 py-1.5 text-xs text-ink-soft">
            <span className="font-medium text-ink">Instructions: </span>
            {line.instructions}
          </p>
        ) : null}

        {openQuestion ? (
          <Alert tone="warning" title="Question sent to the prescriber">
            <p className="text-xs">{openQuestion.question}</p>
            <p className="mt-1 text-2xs text-ink-faint">
              Asked by {openQuestion.raisedByName ?? 'the counter'}. Waiting for an answer.
            </p>
          </Alert>
        ) : null}

        {answered.map((c) => (
          <Alert key={c.id} tone="info" title="The prescriber answered">
            <p className="text-xs">{c.answer}</p>
            {c.resolutionAction ? (
              <p className="mt-1">
                <Badge tone="info">{RESOLUTION_ACTION_LABEL[c.resolutionAction]}</Badge>
              </p>
            ) : null}
          </Alert>
        ))}

        {line.notDispensedReason ? (
          <p className="text-xs text-ink-soft">
            <span className="font-medium text-ink">Not dispensed: </span>
            {line.notDispensedReason}
          </p>
        ) : null}

        {/* ---- The counter's side ---------------------------------------- */}

        {batches.length === 0 ? (
          <Alert tone="warning" title="Nothing in stock for this item">
            No unexpired batch matches what was prescribed. Raise a question with the
            prescriber, or record it as not dispensed so the patient is told.
          </Alert>
        ) : (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_7rem_auto]">
            <Field label="Batch" htmlFor={`batch-${line.id}`} hint="Nearest expiry first.">
              <Select
                id={`batch-${line.id}`}
                value={batchId}
                onChange={(event) => setBatchId(event.target.value)}
              >
                <option value="">Choose a batch…</option>
                {batches.map((batch) => (
                  <option key={batch.stockBatchId} value={batch.stockBatchId}>
                    {batch.productName} — {batch.batchNumber} — exp{' '}
                    {formatDate(batch.expiryDate)} — {batch.quantityOnHand} left
                    {batch.isSubstitution ? ' (different molecule)' : ''}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Quantity"
              htmlFor={`qty-${line.id}`}
              hint={suggested ? `Suggested ${suggested}` : undefined}
            >
              <Input
                id={`qty-${line.id}`}
                type="number"
                min={0}
                max={chosen?.quantityOnHand}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </Field>

            <div className="flex items-end">
              <Button
                variant="primary"
                loading={fill.isPending}
                disabled={!batchId || !quantity || (isSubstitution && reason.trim().length < 5)}
                onClick={save}
              >
                <Check aria-hidden />
                {done ? 'Update' : 'Record'}
              </Button>
            </div>
          </div>
        )}

        {/*
          The substitution reason appears only when it is needed, and then it is
          required. Showing it always would train people to ignore it.
        */}
        {isSubstitution ? (
          <Alert tone="warning" title="That is a different molecule">
            <Field
              label="Why"
              htmlFor={`sub-${line.id}`}
              required
              hint="The prescriber will see this. If you are unsure, ask them instead."
            >
              <Input
                id={`sub-${line.id}`}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Prescribed molecule unavailable; same class agreed with patient"
              />
            </Field>
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-2 border-t border-line-soft pt-2">
          <Button size="sm" variant="ghost" onClick={() => setAskOpen(true)} disabled={Boolean(openQuestion)}>
            <MessageCircleQuestion aria-hidden />
            Ask the prescriber
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDeclineOpen(true)}>
            <PackageX aria-hidden />
            Not dispensed
          </Button>
        </div>
      </PanelBody>

      <AskDialog
        open={askOpen}
        onOpenChange={setAskOpen}
        dispenseId={dispenseId}
        line={line}
      />
      <DeclineDialog open={declineOpen} onOpenChange={setDeclineOpen} line={line} />
    </Panel>
  );
}

function AskDialog({
  open,
  onOpenChange,
  dispenseId,
  line,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dispenseId: string;
  line: DispenseLineDetail;
}) {
  const toast = useToast();
  const raise = useRaiseClarification();
  const [question, setQuestion] = React.useState('');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ask about {line.orderedDrugName}</DialogTitle>
        </DialogHeader>

        <Alert tone="info" title="This goes to the prescriber, not to a phone">
          The question and their answer stay attached to this prescription, so the
          next person to look at it can see what was decided and why.
        </Alert>

        <Field
          label="Your question"
          htmlFor="clarification-question"
          required
          hint="Ask it the way you would on the phone."
        >
          <Textarea
            id="clarification-question"
            rows={3}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Prescribed 500mg but only 250mg is in stock — give two tablets, or change the strength?"
          />
        </Field>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={question.trim().length < 10}
            loading={raise.isPending}
            onClick={() =>
              raise.mutate(
                {
                  dispenseId,
                  medicationRequestId: line.medicationRequestId,
                  question,
                },
                {
                  onSuccess: () => {
                    toast.success('Question sent to the prescriber');
                    setQuestion('');
                    onOpenChange(false);
                  },
                  onError: (error) =>
                    toast.error(error instanceof ApiError ? error.message : 'That did not send'),
                },
              )
            }
          >
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeclineDialog({
  open,
  onOpenChange,
  line,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  line: DispenseLineDetail;
}) {
  const toast = useToast();
  const fill = useFillLine();
  const [reason, setReason] = React.useState(line.notDispensedReason ?? '');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Not dispensing {line.orderedDrugName}</DialogTitle>
        </DialogHeader>

        <Field
          label="Reason"
          htmlFor="decline-reason"
          required
          hint="The patient will be told this, and the prescriber can see it."
        >
          <Input
            id="decline-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Out of stock — patient to collect tomorrow"
          />
        </Field>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="critical"
            disabled={reason.trim().length < 5}
            loading={fill.isPending}
            onClick={() =>
              fill.mutate(
                {
                  lineId: line.id,
                  input: {
                    stockBatchId: null,
                    quantityDispensed: 0,
                    isSubstitution: false,
                    substitutionReason: null,
                    unitPricePaise: null,
                    notDispensedReason: reason,
                  },
                },
                {
                  onSuccess: () => {
                    toast.success('Recorded as not dispensed');
                    onOpenChange(false);
                  },
                  onError: (error) =>
                    toast.error(error instanceof ApiError ? error.message : 'That did not save'),
                },
              )
            }
          >
            Record
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
