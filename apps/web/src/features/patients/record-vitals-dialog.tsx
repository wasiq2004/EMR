'use client';

import * as React from 'react';
import { VITAL_CODES, bmiBand, bodyMassIndex, interpretVital } from '@emr/contracts';
import { useRecordObservation } from './api';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';
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

/**
 * Vitals entry.
 *
 * Laid out in the order a nurse takes them and navigable entirely by keyboard —
 * tab moves down the column, and blank fields are simply not recorded. Nothing
 * is mandatory, because forcing a complete set means the nurse either invents a
 * number or abandons the form.
 *
 * THE UNIT IS PRINTED, NEVER CHOSEN. It belongs to the measure, and the server
 * writes its own copy regardless of what arrives — a weight filed in pounds
 * under a kilogram code is not a validation message, it is a dose calculated
 * later on the wrong body weight.
 *
 * THE FLAG HERE IS THE SAME FUNCTION THE SERVER USES. `interpretVital` lives in
 * the contracts package precisely so the number this screen shows in red and the
 * number stored on the record cannot disagree. The server still derives its own
 * — this one is for the nurse's eye at the bedside, not the stored value.
 */
export function RecordVitalsDialog({
  patientId,
  encounterId,
  open,
  onOpenChange,
  recordedByName,
}: {
  patientId: string;
  encounterId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recordedByName: string;
}) {
  const record = useRecordObservation(patientId);
  const toast = useToast();
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);
  const [failed, setFailed] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (open) {
      setValues({});
      setFailed([]);
    }
  }, [open]);

  const numberFor = (code: string): number | null => {
    const raw = values[code];
    if (raw === undefined || raw.trim() === '') return null;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const entered = VITAL_CODES.filter((vital) => numberFor(vital.code) !== null);

  /*
   * BMI, computed live from the weight and height in the boxes above it.
   *
   * Not saved, and not a field anybody types into. It is two numbers already on
   * the form divided by each other, and storing it would create a third copy
   * that stops agreeing the moment somebody corrects a mistyped weight.
   */
  const bmi = bodyMassIndex(numberFor('29463-7'), numberFor('8302-2'));

  const save = async () => {
    setSaving(true);
    setFailed([]);

    /*
     * One request per measurement, and the failures are collected rather than
     * thrown away.
     *
     * The loop used to stop at the first error with no indication of how far it
     * had got, which leaves a half-recorded set of vitals and a nurse who
     * believes none of it saved. Each one is independent, so the rest are still
     * worth attempting — and the ones that did not make it are named.
     */
    const taken = new Date().toISOString();
    const notSaved: string[] = [];

    for (const vital of entered) {
      const numeric = numberFor(vital.code);
      if (numeric === null) continue;

      try {
        await record.mutateAsync({
          patientId,
          encounterId: encounterId ?? null,
          code: vital.code,
          display: vital.display,
          valueNumeric: numeric,
          valueUnit: vital.unit,
          valueText: null,
          // One timestamp for the whole set: they were taken together, and
          // stamping each with its own save time spreads one reading across
          // several minutes on a trend.
          effectiveAt: taken,
        });
      } catch {
        notSaved.push(vital.display);
      }
    }

    setSaving(false);

    if (notSaved.length > 0) {
      setFailed(notSaved);
      const saved = entered.length - notSaved.length;
      toast.error(
        `${notSaved.length} could not be saved`,
        saved > 0 ? `${saved} were recorded. The rest are still in the form.` : undefined,
      );
      return;
    }

    toast.success(
      `${entered.length} observation${entered.length === 1 ? '' : 's'} recorded`,
      `Recorded by ${recordedByName}.`,
    );
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Record vitals</DialogTitle>
          <DialogDescription>
            Leave anything you did not measure blank. Only what you enter is saved.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          {failed.length > 0 ? (
            <Alert tone="critical" title="Some readings did not save">
              {failed.join(', ')}. They are still in the boxes below — press save again.
            </Alert>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            {VITAL_CODES.map((vital) => {
              const raw = values[vital.code] ?? '';
              const numeric = numberFor(vital.code);
              const flag = numeric === null ? null : interpretVital(vital.code, numeric);
              const critical = flag === 'CRITICAL';

              return (
                <div key={vital.code} className="flex flex-col gap-1.5">
                  <Label htmlFor={`vital-${vital.code}`}>
                    {vital.display}
                    <span className="ml-1 font-normal text-ink-faint">({vital.unit})</span>
                  </Label>
                  <Input
                    id={`vital-${vital.code}`}
                    type="number"
                    inputMode="decimal"
                    step={vital.step}
                    value={raw}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [vital.code]: event.target.value,
                      }))
                    }
                    className={cn('token', critical && 'border-critical')}
                    aria-describedby={flag ? `vital-${vital.code}-flag` : undefined}
                    aria-invalid={critical || undefined}
                  />
                  {flag && flag !== 'NORMAL' ? (
                    <p
                      id={`vital-${vital.code}-flag`}
                      className={cn(
                        'text-2xs font-medium',
                        critical ? 'text-critical' : 'text-warning',
                      )}
                    >
                      {/*
                        Critical reads differently from merely out of range. A
                        systolic of 145 is high and ordinary; 210 is somebody who
                        should not be sent back to the waiting room. Wording them
                        the same makes the second look like the first.
                      */}
                      {critical
                        ? 'Well outside the usual range — check before the patient leaves'
                        : `${flag === 'HIGH' ? 'Above' : 'Below'} the usual range`}
                      {vital.low !== null && vital.high !== null
                        ? ` (${vital.low}–${vital.high})`
                        : ''}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>

          {/*
            BMI sits with the vitals but is visibly not one of them: no box, no
            unit to choose, and it appears only once both numbers it needs are
            present. Showing an empty BMI row invites somebody to type into it.
          */}
          {bmi !== null ? (
            <div className="flex items-baseline gap-2 rounded-md border border-line-soft bg-surface-sunk px-3 py-2">
              <span className="text-2xs uppercase tracking-wide text-ink-faint">BMI</span>
              <span className="text-sm font-semibold tabular text-ink">{bmi}</span>
              <span
                className={cn(
                  'text-2xs font-medium',
                  bmiBand(bmi).tone === 'normal' ? 'text-ink-soft' : 'text-warning',
                )}
              >
                {bmiBand(bmi).label}
              </span>
              <span className="ml-auto text-2xs text-ink-faint">
                Calculated, not stored. Asian cut-offs.
              </span>
            </div>
          ) : null}
        </DialogBody>

        <DialogFooter>
          <span className="mr-auto text-2xs text-ink-faint">
            {entered.length === 0 ? 'Nothing entered yet' : `${entered.length} will be saved`}
          </span>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={save}
            loading={saving}
            disabled={entered.length === 0}
          >
            Save vitals
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
