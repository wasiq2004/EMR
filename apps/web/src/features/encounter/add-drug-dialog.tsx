'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
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

/**
 * Keeping a drug the shared catalogue does not have.
 *
 * PRESCRIBING ONE HAS ALWAYS WORKED — the combobox offers "prescribe as typed"
 * and the line is stored with a null `catalogueItemId`. This is the separate act
 * of KEEPING it, so the next doctor finds it by searching and the allergy check
 * has a molecule to reason about.
 *
 * THE MOLECULE IS THE ONLY REQUIRED FIELD, and the dialog says why. Safety is
 * computed from the molecule: the class map is what catches "Mox 500" for a
 * penicillin-allergic patient, since the brand name contains no hint of
 * penicillin. A catalogue row with a brand and no molecule would search well and
 * check nothing — worse than not being in the catalogue, because a doctor would
 * reasonably assume a catalogued drug had been checked.
 */
export function AddDrugDialog({
  open,
  /** What the doctor typed, used to seed the form. */
  typed,
  onClose,
  onAdded,
}: {
  open: boolean;
  typed: string;
  onClose: () => void;
  onAdded?: (brandOrMolecule: string) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [brandName, setBrandName] = React.useState('');
  const [moleculeName, setMoleculeName] = React.useState('');
  const [strength, setStrength] = React.useState('');
  const [dosageForm, setDosageForm] = React.useState('');
  const [route, setRoute] = React.useState('Oral');
  const [drugSchedule, setDrugSchedule] = React.useState('');

  /*
   * Seeded from what was typed, into the BRAND field.
   *
   * People type brands — "Augmentin 625", not "Amoxicillin + Clavulanic acid" —
   * so putting it there and leaving the molecule empty makes the one required
   * field the one that still needs thought.
   */
  React.useEffect(() => {
    if (!open) return;
    setBrandName(typed);
    setMoleculeName('');
    setStrength('');
    setDosageForm('');
    setRoute('Oral');
    setDrugSchedule('');
  }, [open, typed]);

  const add = useMutation({
    mutationFn: () =>
      api.post('/drugs', {
        brandName: brandName.trim() || null,
        moleculeName: moleculeName.trim(),
        strength: strength.trim() || null,
        dosageForm: dosageForm.trim() || null,
        route: route.trim() || null,
        drugSchedule: drugSchedule || null,
      }),
    onSuccess: () => {
      // The search is cached per term; drop the lot so the new row is findable.
      void queryClient.invalidateQueries({ queryKey: ['drugs'] });
      toast.success(
        'Added to the clinic catalogue',
        'Everybody here will find it by searching from now on.',
      );
      onAdded?.(brandName.trim() || moleculeName.trim());
      onClose();
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Add this drug to the clinic&rsquo;s list</DialogTitle>
          <DialogDescription>
            Only this clinic sees it. The shared catalogue is not changed.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {add.isError ? (
            <Alert tone="critical" title="Could not add it">
              {add.error instanceof ApiError
                ? add.error.message
                : 'Something went wrong. Try again in a moment.'}
            </Alert>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Brand" htmlFor="drug-brand" hint="As marketed. Optional.">
              <Input
                value={brandName}
                onChange={(event) => setBrandName(event.target.value)}
                placeholder="Augmentin 625"
              />
            </Field>
            <Field label="Strength" htmlFor="drug-strength">
              <Input
                value={strength}
                onChange={(event) => setStrength(event.target.value)}
                placeholder="625 mg"
              />
            </Field>
          </div>

          <Field
            label="Molecule"
            htmlFor="drug-molecule"
            required
            /*
             * The reason, on the field. Somebody filling this in at a counter
             * will skip a required field they think is bureaucracy, and this one
             * is the difference between the allergy check working and not.
             */
            hint="Required: the allergy check works from the molecule, not the brand. Write a combination as you would say it."
          >
            <Input
              value={moleculeName}
              onChange={(event) => setMoleculeName(event.target.value)}
              placeholder="Amoxicillin + Clavulanic acid"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Form" htmlFor="drug-form">
              <Input
                value={dosageForm}
                onChange={(event) => setDosageForm(event.target.value)}
                placeholder="Tablet"
              />
            </Field>
            <Field label="Route" htmlFor="drug-route">
              <Select value={route} onChange={(event) => setRoute(event.target.value)}>
                {['Oral', 'Topical', 'Inhaled', 'IM', 'IV', 'Nasal', 'Ophthalmic'].map(
                  (option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ),
                )}
              </Select>
            </Field>
            <Field
              label="Schedule"
              htmlFor="drug-schedule"
              /*
               * Left blank unless known, and the hint says so. Schedule X
               * carries a telemedicine prohibition the server enforces: a wrong
               * value either blocks a legitimate prescription or waves through
               * one the law forbids.
               */
              hint="Leave blank if unsure."
            >
              <Select
                value={drugSchedule}
                onChange={(event) => setDrugSchedule(event.target.value)}
              >
                <option value="">Not known</option>
                <option value="H">H</option>
                <option value="H1">H1</option>
                <option value="X">X — not by telemedicine</option>
              </Select>
            </Field>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={add.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={moleculeName.trim().length < 2}
            loading={add.isPending}
            onClick={() => add.mutate()}
          >
            Add to the list
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
