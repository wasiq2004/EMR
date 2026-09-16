'use client';

import * as React from 'react';
import { VITAL_CODES } from '@emr/contracts';
import { useRecordObservation } from './api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/field';
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
 * Out-of-range values are flagged on entry so a mistyped figure is caught at
 * the bedside rather than on the Snapshot an hour later.
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

  React.useEffect(() => {
    if (open) setValues({});
  }, [open]);

  const entered = VITAL_CODES.filter((vital) => {
    const raw = values[vital.code];
    return raw !== undefined && raw.trim() !== '';
  });

  const save = async () => {
    setSaving(true);
    try {
      for (const vital of entered) {
        const numeric = Number.parseFloat(values[vital.code] ?? '');
        if (!Number.isFinite(numeric)) continue;

        await record.mutateAsync({
          patientId,
          encounterId: encounterId ?? null,
          code: vital.code,
          display: vital.display,
          valueNumeric: numeric,
          valueUnit: vital.unit,
          valueText: null,
          referenceLow: vital.low,
          referenceHigh: vital.high,
          interpretation: interpret(numeric, vital.low, vital.high),
        });
      }
      toast.success(
        `${entered.length} observation${entered.length === 1 ? '' : 's'} recorded`,
        `Recorded by ${recordedByName}.`,
      );
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
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

        <DialogBody>
          <div className="grid gap-3 sm:grid-cols-2">
            {VITAL_CODES.map((vital) => {
              const raw = values[vital.code] ?? '';
              const numeric = Number.parseFloat(raw);
              const flag =
                raw.trim() !== '' && Number.isFinite(numeric)
                  ? interpret(numeric, vital.low, vital.high)
                  : null;

              return (
                <div key={vital.code} className="flex flex-col gap-1.5">
                  <Label htmlFor={`vital-${vital.code}`}>
                    {vital.display}
                    <span className="ml-1 font-normal text-ink-faint">
                      ({vital.unit})
                    </span>
                  </Label>
                  <Input
                    id={`vital-${vital.code}`}
                    inputMode="decimal"
                    value={raw}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [vital.code]: event.target.value,
                      }))
                    }
                    className="token"
                    aria-describedby={flag ? `vital-${vital.code}-flag` : undefined}
                  />
                  {flag && flag !== 'NORMAL' ? (
                    <p
                      id={`vital-${vital.code}-flag`}
                      className="text-2xs font-medium text-critical"
                    >
                      {flag === 'HIGH' ? 'Above' : 'Below'} the usual range
                      {vital.low !== null && vital.high !== null
                        ? ` (${vital.low}–${vital.high})`
                        : ''}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </DialogBody>

        <DialogFooter>
          <span className="mr-auto text-2xs text-ink-faint">
            {entered.length === 0
              ? 'Nothing entered yet'
              : `${entered.length} will be saved`}
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

function interpret(
  value: number,
  low: number | null,
  high: number | null,
): 'NORMAL' | 'LOW' | 'HIGH' {
  if (low !== null && value < low) return 'LOW';
  if (high !== null && value > high) return 'HIGH';
  return 'NORMAL';
}
