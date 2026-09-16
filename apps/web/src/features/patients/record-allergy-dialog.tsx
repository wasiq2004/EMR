'use client';

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { RecordAllergy } from '@emr/contracts';
import { useRecordAllergy } from './api';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
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
 * Recording an allergy.
 *
 * Nurses hold allergy:create deliberately — they are usually the person who
 * asks the question at triage, and blocking them means the allergy is never
 * recorded at all.
 *
 * Criticality and reaction severity are captured separately because they mean
 * different things: criticality is the risk of a FUTURE reaction and is what
 * gates prescribing; severity describes a reaction that already happened.
 * Conflating them is a known source of prescribing error.
 */
export function RecordAllergyDialog({
  patientId,
  open,
  onOpenChange,
}: {
  patientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const record = useRecordAllergy(patientId);
  const toast = useToast();

  const form = useForm({
    resolver: zodResolver(RecordAllergy),
    defaultValues: {
      patientId,
      category: 'MEDICATION' as const,
      criticality: 'UNABLE_TO_ASSESS' as const,
      substanceText: '',
      substanceMoleculeId: null,
      reactionDescription: null,
      reactionSeverity: null,
    },
  });

  React.useEffect(() => {
    if (open) form.reset({ ...form.getValues(), substanceText: '' });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSubmit = form.handleSubmit(async (values) => {
    await record.mutateAsync(values);
    toast.success(
      'Allergy recorded',
      'It will now be checked against every medicine prescribed for this patient.',
    );
    onOpenChange(false);
    form.reset();
  });

  const criticality = form.watch('criticality');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <form onSubmit={onSubmit} noValidate>
          <DialogHeader>
            <DialogTitle>Record an allergy</DialogTitle>
            <DialogDescription>
              This is checked against every medicine prescribed for this patient
              from now on.
            </DialogDescription>
          </DialogHeader>

          <DialogBody className="flex flex-col gap-4">
            <Field
              label="Substance"
              htmlFor="substanceText"
              required
              hint="Name the drug, food or substance as the patient described it."
              error={form.formState.errors.substanceText?.message}
            >
              <Input autoFocus {...form.register('substanceText')} />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Type" htmlFor="category">
                <Select {...form.register('category')}>
                  <option value="MEDICATION">Medicine</option>
                  <option value="FOOD">Food</option>
                  <option value="ENVIRONMENT">Environmental</option>
                  <option value="BIOLOGIC">Biologic</option>
                </Select>
              </Field>

              <Field
                label="Risk of a future reaction"
                htmlFor="criticality"
                hint="This is what decides whether prescribing is interrupted."
              >
                <Select {...form.register('criticality')}>
                  <option value="UNABLE_TO_ASSESS">Not assessed</option>
                  <option value="LOW">Low</option>
                  <option value="HIGH">High</option>
                </Select>
              </Field>
            </div>

            {criticality === 'HIGH' ? (
              <Alert tone="critical" title="Prescribing will be interrupted">
                A high-risk allergy shows a blocking warning whenever this
                substance, or anything in the same class, is prescribed. Overriding
                it will require a typed reason.
              </Alert>
            ) : null}

            <Field
              label="What happened"
              htmlFor="reactionDescription"
              hint="For example: widespread rash and facial swelling within 2 hours."
            >
              <Textarea rows={3} {...form.register('reactionDescription')} />
            </Field>

            <Field
              label="How severe was that reaction"
              htmlFor="reactionSeverity"
              hint="Describes what already happened, not future risk."
            >
              <Select {...form.register('reactionSeverity')}>
                <option value="">Not recorded</option>
                <option value="MILD">Mild</option>
                <option value="MODERATE">Moderate</option>
                <option value="SEVERE">Severe</option>
              </Select>
            </Field>
          </DialogBody>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={record.isPending}>
              Record allergy
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
