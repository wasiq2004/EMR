'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import type { PatientSummary, ServiceItem, Slot } from '@emr/contracts';
import { ApiError, api, idempotencyKey } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { ageGender, formatDate, formatPhone, formatTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';

/**
 * Booking into a slot the user clicked.
 *
 * EVERYTHING THE SLOT ALREADY KNOWS IS NOT ASKED FOR. The time, the doctor and
 * the length came from the grid, so the dialog asks for the patient and the
 * reason and nothing else. The full booking form at `/appointments/new` still
 * exists for the case where none of that is settled yet — somebody ringing up to
 * ask when Dr Rao is free — but a receptionist who has just clicked 09:30 on
 * Thursday should not be made to re-enter 09:30 on Thursday.
 *
 * THE SLOT'S LENGTH WINS UNLESS A SERVICE SAYS OTHERWISE. A service with its own
 * duration — a 30-minute new-patient consultation dropped into a 15-minute grid —
 * sets the end, because the clinic configured that duration for a reason and the
 * grid is a drawing convenience.
 */
export function BookSlotDialog({
  slot,
  date,
  onClose,
}: {
  slot: Slot | null;
  date: string | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [term, setTerm] = React.useState('');
  const [patient, setPatient] = React.useState<PatientSummary | null>(null);
  const [serviceItemId, setServiceItemId] = React.useState('');
  const [reason, setReason] = React.useState('');

  /*
   * One key per booking the user is making, not one per attempt — reset when the
   * dialog opens on a different slot.
   *
   * HONEST NOTE ON WHAT THIS CURRENTLY BUYS: nothing yet. `BookAppointment` has
   * no `idempotencyKey` field, so it is sent as an `Idempotency-Key` header and
   * the server does not read it. It is NOT put in the body, because zod would
   * strip it and the call would look protected while being exactly as
   * duplicable as before — which is the trap the payment screen fell into.
   *
   * The key is held stably anyway, so that wiring `/appointments` up properly
   * (TODO, "Still open after Stage F") is a server change rather than a hunt
   * through call sites for keys minted per attempt.
   */
  const bookingKey = React.useRef(idempotencyKey());
  React.useEffect(() => {
    if (!slot) return;
    bookingKey.current = idempotencyKey();
    setTerm('');
    setPatient(null);
    setServiceItemId('');
    setReason('');
  }, [slot?.startsAt, slot?.practitionerId, slot]);

  const { data: results, isFetching } = useQuery({
    queryKey: qk.patients(term.trim()),
    queryFn: () =>
      api.get<{ items: PatientSummary[] }>('/patients/search', {
        query: { q: term.trim(), limit: 6 },
      }),
    enabled: Boolean(slot) && term.trim().length >= 2 && !patient,
  });

  const { data: services } = useQuery({
    queryKey: qk.services,
    queryFn: () =>
      api.get<{ items: ServiceItem[] }>('/services').catch(() => ({ items: [] })),
    enabled: Boolean(slot),
  });

  const service = services?.items.find((s) => s.id === serviceItemId);
  const minutes = service?.defaultDurationMinutes ?? slot?.minutes ?? 15;

  const book = useMutation({
    mutationFn: () => {
      if (!slot || !patient) throw new Error('No slot');
      const start = new Date(slot.startsAt);
      return api.post(
        '/appointments',
        {
          patientId: patient.id,
          practitionerId: slot.practitionerId,
          locationId: slot.locationId,
          serviceItemId: serviceItemId || null,
          scheduledStart: start.toISOString(),
          scheduledEnd: new Date(start.getTime() + minutes * 60_000).toISOString(),
          reasonText: reason.trim() || null,
        },
        { idempotencyKey: bookingKey.current },
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['calendar'] });
      void queryClient.invalidateQueries({ queryKey: ['scheduling'] });
      void queryClient.invalidateQueries({ queryKey: ['appointments'] });
      void queryClient.invalidateQueries({ queryKey: ['queue'] });
      toast.success('Appointment booked', `${patient?.fullName} at ${formatTime(slot?.startsAt)}.`);
      onClose();
    },
  });

  const open = Boolean(slot);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Book this slot</DialogTitle>
          <DialogDescription>
            {slot ? (
              <>
                {formatTime(slot.startsAt)} on {formatDate(date ? `${date}T12:00:00` : null)} with{' '}
                {slot.practitionerName}
                {slot.capacity > 1
                  ? ` · ${slot.capacity - slot.bookedCount} of ${slot.capacity} free`
                  : ''}
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {book.isError ? (
            <Alert tone="critical" title="Could not book">
              {book.error instanceof ApiError
                ? book.error.message
                : 'Something went wrong. Try again in a moment.'}
            </Alert>
          ) : null}

          {patient ? (
            <div className="flex items-start justify-between gap-3 rounded-md border border-line-soft bg-surface-sunk p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">{patient.fullName}</p>
                <p className="text-xs text-ink-soft">
                  {patient.mrn} · {ageGender(patient)}
                  {patient.mobileE164 ? ` · ${formatPhone(patient.mobileE164)}` : ''}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPatient(null);
                  setTerm('');
                }}
              >
                <X className="size-3.5" aria-hidden />
                Change
              </Button>
            </div>
          ) : (
            <Field
              label="Patient"
              htmlFor="book-patient"
              hint="Name, phone or patient number. At least two characters."
            >
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-faint"
                  aria-hidden
                />
                <Input
                  autoFocus
                  value={term}
                  onChange={(event) => setTerm(event.target.value)}
                  placeholder="Search the registry"
                  className="pl-8"
                />
              </div>

              {term.trim().length >= 2 ? (
                <ul className="mt-2 max-h-56 overflow-y-auto rounded-md border border-line-soft">
                  {(results?.items ?? []).map((row) => (
                    <li key={row.id} className="border-b border-line-soft/60 last:border-b-0">
                      <button
                        type="button"
                        onClick={() => setPatient(row)}
                        className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-accent-soft"
                      >
                        <span className="text-sm text-ink">{row.fullName}</span>
                        <span className="text-2xs text-ink-faint">
                          {row.mrn} · {ageGender(row)}
                          {row.mobileE164 ? ` · ${formatPhone(row.mobileE164)}` : ''}
                        </span>
                      </button>
                    </li>
                  ))}

                  {/*
                    Three states, not two. "Nothing found" while the request is
                    still running sends a receptionist off to register somebody
                    who is already in the system.
                  */}
                  {(results?.items ?? []).length === 0 ? (
                    <li className="px-3 py-2 text-xs text-ink-faint">
                      {isFetching ? 'Searching…' : 'Nobody matches. Register them first.'}
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </Field>
          )}

          <Field
            label="Service"
            htmlFor="book-service"
            hint={
              service?.defaultDurationMinutes
                ? `${service.defaultDurationMinutes} minutes — this overrides the slot length.`
                : `Optional. The slot is ${slot?.minutes ?? 15} minutes.`
            }
          >
            <Select
              value={serviceItemId}
              onChange={(event) => setServiceItemId(event.target.value)}
            >
              <option value="">Not specified</option>
              {(services?.items ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.defaultDurationMinutes ? ` · ${item.defaultDurationMinutes} min` : ''}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Reason"
            htmlFor="book-reason"
            hint="Optional. What the patient said when they rang."
          >
            <Textarea
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Fever for three days"
            />
          </Field>
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!patient || book.isPending}
            onClick={() => book.mutate()}
          >
            {book.isPending ? 'Booking…' : `Book ${minutes} min`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
