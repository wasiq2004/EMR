'use client';

import * as React from 'react';
import { AlertTriangle, Ban, ShieldAlert } from 'lucide-react';
import type { SafetyWarning } from '@emr/contracts';
import { formatDate } from '@/lib/format';
import { isHardBlocked, requiresOverrideReason } from '@/lib/safety';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * ======================= THE SAFETY WARNING DIALOG =========================
 *
 * The acceptance criterion: five of five pilot doctors must notice and act on
 * the allergy warning before signing. A single miss is a patient-safety defect
 * and a stop-and-redesign decision.
 *
 * Every design choice below follows from that, and none should be softened
 * without re-running the acceptance script:
 *
 *   - It is a MODAL, not a toast. "Advisory" in the specification means the
 *     system must not alter or refuse the prescription on its own. It does not
 *     mean the warning should be easy to miss.
 *   - Escape and click-outside are disabled. The only ways out are the two
 *     buttons, so the decision is deliberate rather than accidental.
 *   - Choosing something else is the PRIMARY action. Overriding is secondary
 *     and greyed until a reason is typed.
 *   - The override reason is free text with a minimum length. A single "OK"
 *     button is not a decision; typing why is.
 *   - It states the substance, the criticality AND the date recorded, because
 *     a doctor's first question is "how old is this information?".
 *   - A legal restriction (Schedule X in a remote consultation) offers no
 *     override at all — that is not clinical judgement to exercise.
 * ===========================================================================
 */
export function SafetyWarningDialog({
  warnings,
  drugName,
  open,
  onCancel,
  onProceed,
}: {
  warnings: SafetyWarning[];
  drugName: string;
  open: boolean;
  onCancel: () => void;
  /** Called with the typed reason when a blocking warning is overridden. */
  onProceed: (overrideReason: string | null) => void;
}) {
  const [reason, setReason] = React.useState('');
  const [touched, setTouched] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setReason('');
      setTouched(false);
    }
  }, [open]);

  const blocked = isHardBlocked(warnings);
  const needsReason = requiresOverrideReason(warnings);
  const reasonValid = reason.trim().length >= 10;
  const canProceed = !blocked && (!needsReason || reasonValid);

  const proceed = () => {
    if (!canProceed) {
      setTouched(true);
      return;
    }
    onProceed(needsReason ? reason.trim() : null);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent size="md" mandatory>
        <DialogHeader className="border-critical-line bg-critical-soft">
          <div className="flex items-start gap-3">
            {blocked ? (
              <Ban className="mt-0.5 size-5 shrink-0 text-critical" aria-hidden />
            ) : (
              <ShieldAlert className="mt-0.5 size-5 shrink-0 text-critical" aria-hidden />
            )}
            <div className="min-w-0">
              <DialogTitle className="text-critical">
                {blocked ? 'This medicine cannot be prescribed' : 'Check before prescribing'}
              </DialogTitle>
              <p className="mt-0.5 text-xs text-ink-soft">
                {drugName}
              </p>
            </div>
          </div>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          <ul className="flex flex-col gap-3">
            {warnings.map((warning, index) => (
              <li
                key={`${warning.kind}-${index}`}
                className="rounded-md border border-critical-line bg-critical-soft/50 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <AlertTriangle className="size-4 shrink-0 text-critical" aria-hidden />
                  <span className="text-sm font-semibold text-ink">{warning.title}</span>
                  {warning.criticality === 'HIGH' ? (
                    <Badge tone="alarm">High risk</Badge>
                  ) : null}
                  {!warning.overridable ? (
                    <Badge tone="critical">Cannot be overridden</Badge>
                  ) : null}
                </div>

                <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">
                  {warning.detail}
                </p>

                {warning.recordedAt ? (
                  <p className="mt-1.5 text-2xs text-ink-faint">
                    Recorded {formatDate(warning.recordedAt)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>

          {needsReason && !blocked ? (
            <Field
              label="If you are prescribing anyway, record why"
              htmlFor="override-reason"
              required
              hint="This is saved with the prescription and is visible in any later clinical review."
              error={
                touched && !reasonValid
                  ? 'Write at least a short sentence explaining your decision.'
                  : undefined
              }
            >
              <Textarea
                rows={3}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. Patient reports the reaction was mild indigestion, not a true allergy. Discussed and agreed."
              />
            </Field>
          ) : null}
        </DialogBody>

        <DialogFooter>
          {/* Choosing something else is the primary path. */}
          <Button variant="primary" onClick={onCancel} autoFocus>
            {blocked ? 'Choose another medicine' : 'Choose something else'}
          </Button>
          {!blocked ? (
            <Button
              variant="critical"
              onClick={proceed}
              disabled={needsReason && !reasonValid}
            >
              Prescribe anyway
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
