'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Search, UserPlus } from 'lucide-react';
import type { PatientSummary, Practitioner } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { useAddWalkIn } from './api';
import { ageGender, formatPhone } from '@/lib/format';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { cn } from '@/lib/cn';
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
 * Adding a walk-in.
 *
 * One action, not two. There is no separate "create appointment" step — a
 * walk-in creates an appointment already in the arrived state, which is what
 * places them in the queue. Roughly 60–80% of patients at a small Indian OPD
 * arrive this way, so this is the common path, not the exception.
 *
 * Target: under fifteen seconds from opening this to the patient appearing on
 * the board.
 */
export function AddWalkInDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [term, setTerm] = React.useState('');
  const [selected, setSelected] = React.useState<PatientSummary | null>(null);
  const [practitionerId, setPractitionerId] = React.useState<string>('');
  const [reason, setReason] = React.useState('');

  const addWalkIn = useAddWalkIn();
  const toast = useToast();

  const trimmed = term.trim();
  const { data: results } = useQuery({
    queryKey: qk.patients(trimmed),
    queryFn: () =>
      api.get<{ items: PatientSummary[] }>('/patients/search', {
        query: { q: trimmed, limit: 6 },
      }),
    enabled: open && trimmed.length >= 2 && !selected,
  });

  // /practitioners, not /users — see the note in appointments/new.
  const { data: staff } = useQuery({
    queryKey: qk.practitioners,
    queryFn: () => api.get<{ items: Practitioner[] }>('/practitioners'),
    enabled: open,
  });

  const doctors = staff?.items ?? [];

  React.useEffect(() => {
    if (!open) {
      setTerm('');
      setSelected(null);
      setReason('');
    } else if (doctors[0] && !practitionerId) {
      // Defaults to the only, or last used, doctor — one less decision.
      setPractitionerId(doctors[0].id);
    }
  }, [open, doctors, practitionerId]);

  const submit = async () => {
    if (!selected) return;
    await addWalkIn.mutateAsync({
      patientId: selected.id,
      practitionerId: practitionerId || null,
      reasonText: reason.trim() || null,
    });
    toast.success(
      `${selected.fullName} added to the queue`,
      'They are at the end of the list. Use the arrows to move them up.',
    );
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Add a walk-in</DialogTitle>
          <DialogDescription>
            Find the patient, then add them straight to today&rsquo;s queue.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {selected ? (
            <div className="flex items-center gap-3 rounded-md border border-accent/40 bg-accent-soft/40 p-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">{selected.fullName}</p>
                <p className="text-2xs text-ink-faint">
                  {ageGender(selected)} ·{' '}
                  <span className="token">{formatPhone(selected.mobileE164)}</span>
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setSelected(null)}>
                Change
              </Button>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
                <Search className="size-4 shrink-0 text-ink-faint" aria-hidden />
                <Input
                  autoFocus
                  value={term}
                  onChange={(event) => setTerm(event.target.value)}
                  placeholder="Mobile number or name"
                  aria-label="Find the patient"
                  className="h-9 border-0 px-0 focus-visible:ring-0"
                />
              </div>

              {trimmed.length >= 2 ? (
                <ul className="mt-2 max-h-52 overflow-y-auto scroll-thin rounded-md border border-line">
                  {(results?.items ?? []).length === 0 ? (
                    <li className="px-3 py-3 text-center text-xs text-ink-faint">
                      No match.{' '}
                      <Link
                        href={`/patients/new?q=${encodeURIComponent(trimmed)}`}
                        className="font-medium text-accent underline"
                      >
                        Register them first
                      </Link>
                    </li>
                  ) : (
                    (results?.items ?? []).map((patient) => (
                      <li key={patient.id}>
                        <button
                          type="button"
                          onClick={() => setSelected(patient)}
                          className={cn(
                            'flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-sunk',
                          )}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-ink">
                              {patient.fullName}
                            </span>
                            <span className="block text-2xs text-ink-faint">
                              {ageGender(patient)} ·{' '}
                              <span className="token">
                                {formatPhone(patient.mobileE164)}
                              </span>
                            </span>
                          </span>
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              ) : null}
            </div>
          )}

          <Field label="Doctor" htmlFor="walkin-doctor">
            <Select
              id="walkin-doctor"
              value={practitionerId}
              onChange={(event) => setPractitionerId(event.target.value)}
            >
              <option value="">Not assigned yet</option>
              {doctors.map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  {doctor.fullName}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Reason for visit"
            htmlFor="walkin-reason"
            hint="A few words is enough. The doctor will take the history."
          >
            <Input
              id="walkin-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. Fever and body ache"
            />
          </Field>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={!selected}
            loading={addWalkIn.isPending}
          >
            <UserPlus aria-hidden />
            Add to queue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
