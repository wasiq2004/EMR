'use client';

import * as React from 'react';
import {
  DURATION_PRESETS,
  FREQUENCY_PRESETS,
  ROUTE_OPTIONS,
  TIMING_OPTIONS,
  describeFrequency,
  expandFrequency,
  quantityForCourse,
  type DrugCatalogueItem,
} from '@emr/contracts';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface DosageChoice {
  frequency: string;
  timingRelativeToFood: 'BEFORE_FOOD' | 'AFTER_FOOD' | 'WITH_FOOD' | null;
  durationDays: number | null;
  route: string | null;
  quantity: number | null;
  instructions: string | null;
}

/**
 * How much, how often, for how long.
 *
 * WHY THIS EXISTS AT ALL. Selecting a drug used to write the line straight to
 * the server with `frequency: '1-0-1'`, `timingRelativeToFood: 'AFTER_FOOD'` and
 * `durationDays: 5` hardcoded — for every drug, every time, whatever the doctor
 * intended. The screen then displayed those values back as read-only chips with
 * no way to change them, so a patient could leave with a printed prescription
 * saying twice a day after food for five days for a drug meant once at night for
 * three. The fields were all in the contract and all in the table; nothing was
 * ever asking.
 *
 * FOUR TAPS FOR THE COMMON CASE. A preset frequency, a preset duration, and the
 * defaults for the rest. The presets are not a constraint — the frequency stays
 * free text underneath, because "2-0-2 for 3 days then 1-0-1" is a real
 * prescription that no preset list will contain, and a picker that cannot
 * express a tapering course is a picker that gets worked around.
 *
 * THE QUANTITY IS COMPUTED AND EDITABLE. Doses per day times days, rounded up,
 * because that is arithmetic the prescriber should not be doing and the pharmacy
 * needs. It is editable because a clinic dispensing a full strip of fifteen for
 * a ten-day course is a real decision, and it blanks itself for SOS, where there
 * is no daily total and a confident number would be a wrong one.
 */
export function DosageDialog({
  open,
  drugName,
  drug,
  initial,
  saving,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  drugName: string;
  /** Null for a free-text drug, which has no catalogue route or form. */
  drug: DrugCatalogueItem | null;
  /** Set when editing an existing line, so the dialog opens on its values. */
  initial?: Partial<DosageChoice>;
  saving: boolean;
  onCancel: () => void;
  onConfirm: (choice: DosageChoice) => void;
}) {
  const [frequency, setFrequency] = React.useState('1-0-1');
  const [timing, setTiming] = React.useState<DosageChoice['timingRelativeToFood']>(
    'AFTER_FOOD',
  );
  const [durationText, setDurationText] = React.useState('5');
  const [route, setRoute] = React.useState<string>('');
  const [quantityText, setQuantityText] = React.useState('');
  const [quantityEdited, setQuantityEdited] = React.useState(false);
  const [instructions, setInstructions] = React.useState('');

  /*
   * Reset on open, not on every render.
   *
   * The dialog is reused for each drug in the prescription, and carrying the
   * last drug's duration into the next one is how a seven-day antibiotic
   * silently becomes a seven-day painkiller.
   */
  React.useEffect(() => {
    if (!open) return;
    setFrequency(initial?.frequency ?? '1-0-1');
    setTiming(initial?.timingRelativeToFood ?? 'AFTER_FOOD');
    setDurationText(initial?.durationDays ? String(initial.durationDays) : '5');
    // The catalogue's own route wins: an injection is not taken orally.
    setRoute(initial?.route ?? drug?.route ?? '');
    setQuantityText(initial?.quantity ? String(initial.quantity) : '');
    setQuantityEdited(Boolean(initial?.quantity));
    setInstructions(initial?.instructions ?? '');
  }, [open, drugName, drug?.route, initial]);

  const durationDays = (() => {
    const parsed = Number.parseInt(durationText, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  })();

  const suggestedQuantity = quantityForCourse(frequency, durationDays);

  // The suggestion fills the box until the prescriber types their own number.
  const quantity = quantityEdited
    ? (() => {
        const parsed = Number.parseFloat(quantityText);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      })()
    : suggestedQuantity;

  const confirm = () => {
    onConfirm({
      // Normalised so "BD" is stored as "1-0-1" — the printed prescription
      // should read the same whichever the doctor typed.
      frequency: expandFrequency(frequency).trim() || '1-0-1',
      timingRelativeToFood: timing,
      durationDays,
      route: route.trim() || null,
      quantity,
      instructions: instructions.trim() || null,
    });
  };

  const readable = describeFrequency(
    expandFrequency(frequency),
    drug?.dosageForm?.toLowerCase() ?? 'tablet',
  );

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{drugName}</DialogTitle>
          <DialogDescription>
            {drug?.strength ? `${drug.strength} · ` : ''}
            {drug?.dosageForm ?? 'As typed'}
            {drug?.moleculeName && drug.moleculeName !== drugName
              ? ` · ${drug.moleculeName}`
              : ''}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            {/*
              The presets sit ABOVE the Field, not inside it.

              `Field` clones its single child to attach the id the label points
              at, so wrapping these and the input in a div handed the div that
              id — leaving the label pointing at a div and two elements sharing
              one id. The presets are a shortcut for filling the input below,
              and `aria-pressed` is what tells a screen reader which is active.
            */}
            <div
              className="flex flex-wrap gap-1.5"
              role="group"
              aria-label="Common frequencies"
            >
              {FREQUENCY_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  aria-pressed={expandFrequency(frequency) === preset.value}
                  title={preset.hint}
                  onClick={() => setFrequency(preset.value)}
                  className={cn(
                    'rounded-sm border px-2 py-1 text-2xs font-medium tabular transition-colors',
                    expandFrequency(frequency) === preset.value
                      ? 'border-accent bg-accent text-accent-contrast'
                      : 'border-line bg-surface text-ink-soft hover:bg-surface-sunk',
                  )}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <Field
              label="Frequency"
              htmlFor="dose-frequency"
              hint={
                readable
                  ? `${readable}. Type any pattern — BD and TDS are understood.`
                  : 'Type any pattern — BD and TDS are understood.'
              }
            >
              <Input
                value={frequency}
                onChange={(event) => setFrequency(event.target.value)}
                placeholder="1-0-1"
                className="token"
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <div
                className="flex flex-wrap gap-1.5"
                role="group"
                aria-label="Common durations"
              >
                {DURATION_PRESETS.map((days) => (
                  <button
                    key={days}
                    type="button"
                    aria-pressed={durationDays === days}
                    onClick={() => setDurationText(String(days))}
                    className={cn(
                      'rounded-sm border px-2 py-1 text-2xs font-medium tabular transition-colors',
                      durationDays === days
                        ? 'border-accent bg-accent text-accent-contrast'
                        : 'border-line bg-surface text-ink-soft hover:bg-surface-sunk',
                    )}
                  >
                    {days}d
                  </button>
                ))}
              </div>
              <Field
                label="Duration"
                htmlFor="dose-duration"
                hint="Days. Blank for ongoing."
              >
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={durationText}
                  onChange={(event) => setDurationText(event.target.value)}
                  className="token"
                />
              </Field>
            </div>

            <Field label="Timing" htmlFor="dose-timing">
              <Select
                value={timing ?? ''}
                onChange={(event) =>
                  setTiming(
                    (event.target.value || null) as DosageChoice['timingRelativeToFood'],
                  )
                }
              >
                <option value="">Not specified</option>
                {TIMING_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Route"
              htmlFor="dose-route"
              hint={drug?.route ? 'From the catalogue entry.' : undefined}
            >
              <Select
                value={route}
                onChange={(event) => setRoute(event.target.value)}
              >
                <option value="">Not specified</option>
                {ROUTE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Quantity to dispense"
              htmlFor="dose-quantity"
              hint={
                suggestedQuantity !== null && !quantityEdited
                  ? `Calculated from the course.`
                  : suggestedQuantity === null
                    ? 'No daily total for this frequency — enter it if needed.'
                    : 'Overridden.'
              }
            >
              <Input
                type="number"
                min={0}
                step={0.5}
                value={quantityEdited ? quantityText : (suggestedQuantity ?? '')}
                onChange={(event) => {
                  setQuantityEdited(true);
                  setQuantityText(event.target.value);
                }}
                className="token"
              />
            </Field>
          </div>

          <Field
            label="Instructions"
            htmlFor="dose-instructions"
            hint="Printed on the prescription. Optional."
          >
            <Textarea
              rows={2}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="Take with plenty of water. Stop if the rash returns."
            />
          </Field>
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={confirm} loading={saving}>
            Add to prescription
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
