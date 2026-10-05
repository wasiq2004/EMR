'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import type { Patient } from '@emr/contracts';
import { ApiError, api } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { ageGender, formatDate, formatPhone } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert, Skeleton } from '@/components/ui/feedback';
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
 * Merging two records for the same person.
 *
 * WHY THIS IS A DIALOG AND NOT A ONE-CLICK BUTTON. The page's primary action was
 * a `<Button>` with no handler — the endpoint, the contract and the service were
 * all complete and nothing called them — but the fix is not simply wiring it up.
 * A merge moves every encounter, prescription, invoice and document from one
 * record onto another and is not easily undone, so the person pressing it has to
 * see both records and say which survives.
 *
 * THE DIRECTION IS THE DECISION. Everything moves onto the surviving record, and
 * which one that is matters: the one with the longer history usually wins, but
 * not when the other has the correct spelling of the name and the working phone
 * number. The dialog shows both so the choice is made on what is there rather
 * than on which happened to be listed first.
 */
export function MergePatientsDialog({
  firstId,
  secondId,
  onClose,
}: {
  firstId: string | null;
  secondId: string | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  /** Which of the two survives. Defaults to the first, and is changeable. */
  const [survivingId, setSurvivingId] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState('');

  React.useEffect(() => {
    if (!firstId) return;
    setSurvivingId(firstId);
    setReason('');
  }, [firstId]);

  const open = Boolean(firstId && secondId);

  const first = useQuery({
    queryKey: ['patients', firstId],
    queryFn: () => api.get<Patient>(`/patients/${firstId}`),
    enabled: open,
  });
  const second = useQuery({
    queryKey: ['patients', secondId],
    queryFn: () => api.get<Patient>(`/patients/${secondId}`),
    enabled: open,
  });

  const merge = useMutation({
    mutationFn: () =>
      api.post('/patients/merge', {
        survivingPatientId: survivingId,
        mergedPatientId: survivingId === firstId ? secondId : firstId,
        reason: reason.trim(),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['patients'] });
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      toast.success(
        'Records merged',
        'Everything moved onto the surviving record. The merged identifier is kept.',
      );
      onClose();
    },
  });

  const loading = first.isLoading || second.isLoading;
  const both = first.data && second.data ? [first.data, second.data] : null;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Merge two records</DialogTitle>
          <DialogDescription>
            Choose which record survives. Everything moves onto it.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {merge.isError ? (
            <Alert tone="critical" title="Could not merge them">
              {merge.error instanceof ApiError
                ? merge.error.message
                : 'Something went wrong. Try again in a moment.'}
            </Alert>
          ) : null}

          {/*
            Said before the choice, not after. "Cannot be undone easily" on the
            page behind this dialog is too far from the button that does it.
          */}
          <Alert tone="warning" title="This is hard to undo">
            Every visit, prescription, invoice and document on the merged record
            moves onto the surviving one. The merged patient number is kept so the
            history stays traceable, but the records do not come back apart.
          </Alert>

          {loading ? (
            <Skeleton className="h-32 w-full" />
          ) : both ? (
            <div className="flex flex-col gap-2">
              {both.map((patient) => {
                const survives = survivingId === patient.id;
                return (
                  <button
                    key={patient.id}
                    type="button"
                    onClick={() => setSurvivingId(patient.id)}
                    aria-pressed={survives}
                    className={cn(
                      'flex items-start gap-3 rounded-md border p-3 text-left transition-colors',
                      survives
                        ? 'border-accent bg-accent-soft'
                        : 'border-line hover:bg-surface-sunk',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-ink">
                        {patient.fullName}
                      </span>
                      <span className="block text-2xs text-ink-faint">
                        {patient.mrn} · {ageGender(patient)}
                        {patient.mobileE164 ? ` · ${formatPhone(patient.mobileE164)}` : ' · no mobile'}
                      </span>
                      <span className="block text-2xs text-ink-faint">
                        Registered {formatDate(patient.createdAt)}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'shrink-0 rounded-sm px-1.5 py-0.5 text-2xs font-medium',
                        survives
                          ? 'bg-accent text-accent-contrast'
                          : 'bg-surface-sunk text-ink-faint',
                      )}
                    >
                      {survives ? 'Survives' : 'Will be merged'}
                    </span>
                  </button>
                );
              })}

              <p className="flex items-center gap-1.5 text-2xs text-ink-faint">
                <ArrowRight className="size-3" aria-hidden />
                Everything moves onto the record marked &ldquo;survives&rdquo;.
              </p>
            </div>
          ) : (
            <Alert tone="critical" title="Could not load both records">
              One of them may already have been merged.
            </Alert>
          )}

          <Field
            label="Why are these the same person?"
            htmlFor="merge-reason"
            required
            /*
             * The server requires at least four characters, and the reason is
             * written into the audit trail. "Same mobile, same date of birth" is
             * what somebody needs to read in a year when a patient disputes it.
             */
            hint="Kept on the audit trail. What made you certain?"
          >
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Same mobile and date of birth; spoke to the patient"
            />
          </Field>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={merge.isPending}>
            Cancel
          </Button>
          <Button
            variant="critical"
            disabled={!both || reason.trim().length < 4 || !survivingId}
            loading={merge.isPending}
            onClick={() => merge.mutate()}
          >
            Merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
