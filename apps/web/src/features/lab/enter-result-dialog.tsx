'use client';

import * as React from 'react';
import type { LabOrder } from '@emr/contracts';
import { ApiError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/feedback';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/toast';
import { useEnterLabResult, useLabResultHistory } from './api';

/**
 * Typing in what the lab sent back.
 *
 * NO INTERPRETATION FIELD, deliberately. Whether a value is high, low or
 * alarming is derived on the server from the reference range — the same rule as
 * the vitals. A box here saying "normal" would let whoever types the number also
 * decide what it means, which is a clinical assertion a typist is not making.
 *
 * A NUMBER OR TEXT, not both required. Plenty of results are not numbers — "no
 * growth after 48 hours", "mild bronchial wall thickening" — and forcing a
 * numeric value would make those unrecordable. The database refuses a result
 * with neither.
 *
 * CORRECTING AN EXISTING RESULT NEEDS A REASON. The previous value may be why a
 * patient was started on a drug, so it is kept and superseded rather than
 * overwritten, and "corrected, no reason given" is not something anybody can act
 * on six months later.
 */
export function EnterResultDialog({
  order,
  onClose,
}: {
  order: LabOrder | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const enter = useEnterLabResult();
  const history = useLabResultHistory(order?.result ? order.id : null);

  const correcting = Boolean(order?.result);

  const [valueNumeric, setValueNumeric] = React.useState('');
  const [valueText, setValueText] = React.useState('');
  const [low, setLow] = React.useState('');
  const [high, setHigh] = React.useState('');
  const [performedBy, setPerformedBy] = React.useState('');
  const [labNote, setLabNote] = React.useState('');
  const [specimenAt, setSpecimenAt] = React.useState('');
  const [reason, setReason] = React.useState('');

  /*
   * Reset on open, seeded from the existing result when correcting.
   *
   * Carrying the last order's numbers into the next one is how a haemoglobin
   * ends up recorded against a potassium.
   */
  React.useEffect(() => {
    if (!order) return;
    const existing = order.result;
    setValueNumeric(existing?.valueNumeric != null ? String(existing.valueNumeric) : '');
    setValueText(existing?.valueText ?? '');
    setLow(existing?.referenceLow != null ? String(existing.referenceLow) : '');
    setHigh(existing?.referenceHigh != null ? String(existing.referenceHigh) : '');
    setPerformedBy(existing?.performedBy ?? '');
    setLabNote(existing?.labNote ?? '');
    setSpecimenAt('');
    setReason('');
  }, [order]);

  const submit = () => {
    if (!order) return;

    const numeric = valueNumeric.trim() === '' ? null : Number.parseFloat(valueNumeric);

    enter.mutate(
      {
        orderId: order.id,
        valueNumeric: numeric !== null && Number.isFinite(numeric) ? numeric : null,
        valueText: valueText.trim() || null,
        referenceLow: low.trim() === '' ? null : Number.parseFloat(low),
        referenceHigh: high.trim() === '' ? null : Number.parseFloat(high),
        performedBy: performedBy.trim() || null,
        labNote: labNote.trim() || null,
        specimenAt: specimenAt ? new Date(specimenAt).toISOString() : null,
        supersedesReason: correcting ? reason.trim() || null : null,
      },
      {
        onSuccess: () => {
          toast.success(
            correcting ? 'Result corrected' : 'Result recorded',
            correcting
              ? 'The previous value is kept, and the order needs reviewing again.'
              : 'It is waiting for a clinician to review it.',
          );
          onClose();
        },
      },
    );
  };

  const canSubmit =
    (valueNumeric.trim() !== '' || valueText.trim() !== '') &&
    (!correcting || reason.trim().length >= 3);

  return (
    <Dialog open={Boolean(order)} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>
            {correcting ? 'Correct the result' : 'Enter the result'}
          </DialogTitle>
          <DialogDescription>
            {order?.testName}
            {order?.patientName ? ` · ${order.patientName}` : ''}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {enter.isError ? (
            <Alert tone="critical" title="Could not save it">
              {enter.error instanceof ApiError
                ? enter.error.message
                : 'Something went wrong. Try again in a moment.'}
            </Alert>
          ) : null}

          {correcting ? (
            <Alert tone="warning" title="This replaces a result already recorded">
              The previous value is kept and marked superseded — it may be why a
              decision was made. The order goes back to needing review, because
              nobody has read the new value yet.
            </Alert>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Value"
              htmlFor="lab-value"
              hint={order?.unit ? `In ${order.unit}.` : 'A number, if the test gives one.'}
            >
              <Input
                type="number"
                step="any"
                className="token"
                value={valueNumeric}
                onChange={(event) => setValueNumeric(event.target.value)}
              />
            </Field>
            <Field
              label="Specimen taken"
              htmlFor="lab-specimen"
              hint="Optional. Not the same as when you type it in."
            >
              <Input
                type="datetime-local"
                value={specimenAt}
                onChange={(event) => setSpecimenAt(event.target.value)}
              />
            </Field>
          </div>

          <Field
            label="Or what the report says"
            htmlFor="lab-text"
            hint='For results that are not numbers — "No growth after 48 hours".'
          >
            <Textarea
              rows={2}
              value={valueText}
              onChange={(event) => setValueText(event.target.value)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Reference low"
              htmlFor="lab-low"
              /*
               * The lab's range wins where it quoted one. Labs disagree, and the
               * range printed on the report is what the result should be judged
               * against — so it is copied onto the result rather than read from
               * the catalogue later.
               */
              hint="Leave blank to use the catalogue's."
            >
              <Input
                type="number"
                step="any"
                className="token"
                value={low}
                onChange={(event) => setLow(event.target.value)}
              />
            </Field>
            <Field label="Reference high" htmlFor="lab-high">
              <Input
                type="number"
                step="any"
                className="token"
                value={high}
                onChange={(event) => setHigh(event.target.value)}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Lab" htmlFor="lab-performed-by" hint="Who ran it. Optional.">
              <Input
                value={performedBy}
                onChange={(event) => setPerformedBy(event.target.value)}
                placeholder="Metropolis"
              />
            </Field>
            <Field label="Lab's comment" htmlFor="lab-note" hint="Optional.">
              <Input value={labNote} onChange={(event) => setLabNote(event.target.value)} />
            </Field>
          </div>

          {correcting ? (
            <Field
              label="Why is it being corrected?"
              htmlFor="lab-reason"
              required
              hint="Kept on the record beside the old value."
            >
              <Input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Lab rang: transcription error"
              />
            </Field>
          ) : null}

          {/*
            The previous values, where there are any. Somebody correcting a
            result should be able to see what they are replacing without leaving
            the dialog.
          */}
          {correcting && (history.data ?? []).length > 0 ? (
            <div className="rounded-md border border-line-soft bg-surface-sunk p-2">
              <p className="text-2xs uppercase tracking-wide text-ink-faint">
                Already recorded
              </p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {(history.data ?? []).map((result) => (
                  <li key={result.id} className="text-2xs text-ink-soft">
                    <span className="tabular">
                      {result.valueNumeric ?? result.valueText}
                    </span>
                    {result.supersededAt ? ' — superseded' : ' — current'}
                    {result.supersededReason ? `: ${result.supersededReason}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={enter.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={!canSubmit}
            loading={enter.isPending}
          >
            {correcting ? 'Save correction' : 'Save result'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
