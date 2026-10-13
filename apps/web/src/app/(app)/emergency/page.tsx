'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Siren, TriangleAlert } from 'lucide-react';
import type { Appointment, Practitioner } from '@emr/contracts';
import { ApiError, api, idempotencyKey } from '@/lib/api-client';
import { useCan } from '@/lib/session';
import { qk } from '@/lib/query-client';
import { Button } from '@/components/ui/button';
import { Field, FieldGrid, Input, Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/feedback';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';

/**
 * Emergency admission.
 *
 * THE DESIGN BRIEF IS THE SITUATION. Somebody is being carried through the door.
 * Whoever is nearest — the receptionist, a nurse, the doctor — has one hand free
 * and perhaps twenty seconds. Everything here follows from that:
 *
 *   - ONE required field. A label. Not a name, because the patient may be
 *     unconscious and unaccompanied: "Unknown male, approx 40" is a legitimate
 *     answer and calling the field a name invites somebody to invent one.
 *   - NO duplicate search. Every other registration path in this product refuses
 *     without proof that a search for an existing patient ran first, and that is
 *     the right rule at a desk. It is the wrong rule here, so the server skips it
 *     and records that it did.
 *   - ONE button, and it does everything: registers the patient, puts them at the
 *     front of the queue, and raises the task to finish the record later.
 *   - Everything optional is VISIBLY optional, so nobody stops to think about
 *     whether it matters right now. It does not. It can all be added afterwards.
 *
 * The visual loudness is not decoration. This screen is reached in a hurry and
 * must be unmistakable from the one next to it — a receptionist who thinks they
 * are on the ordinary booking form will start looking for fields that are not
 * here.
 */
export default function EmergencyPage() {
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();
  const allowed = useCan('emergency:create');

  const [label, setLabel] = React.useState('');
  const [mobile, setMobile] = React.useState('');
  const [gender, setGender] = React.useState('UNKNOWN');
  const [age, setAge] = React.useState('');
  const [attendantName, setAttendantName] = React.useState('');
  const [attendantPhone, setAttendantPhone] = React.useState('');
  const [practitionerId, setPractitionerId] = React.useState('');
  const [reason, setReason] = React.useState('');

  /*
   * One key for the admission being made, not one per attempt. A double-tap on
   * a screen used under pressure is likelier than anywhere else in the product,
   * and admitting the same person twice puts two of them in the queue.
   */
  const admissionKey = React.useRef(idempotencyKey());

  const { data: staff } = useQuery({
    queryKey: qk.practitioners,
    queryFn: () => api.get<{ items: Practitioner[] }>('/practitioners'),
  });

  const admit = useMutation({
    mutationFn: () =>
      api.post<Appointment>('/emergency', {
        label: label.trim(),
        mobileE164: mobile.trim() || null,
        gender,
        ageYears: age ? Number.parseInt(age, 10) : null,
        attendantName: attendantName.trim() || null,
        attendantPhoneE164: attendantPhone.trim() || null,
        practitionerId: practitionerId || null,
        reasonText: reason.trim() || null,
        idempotencyKey: admissionKey.current,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.queue() });
      void queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
      toast.success(
        `${label.trim()} is at the front of the queue`,
        'Registration is deliberately incomplete. A task has been raised to finish it.',
      );
      admissionKey.current = idempotencyKey();
      router.push('/queue');
    },
    onError: (error) =>
      toast.error(
        'Could not admit',
        error instanceof ApiError ? error.message : 'Try again, or add a walk-in from the queue.',
      ),
  });

  if (!allowed) {
    return (
      <Panel>
        <PanelBody>
          <Alert tone="info" title="Emergency admission is limited">
            Reception, nursing, doctors and the clinic administrator can admit an
            emergency. Ask one of them, or add a walk-in from the queue.
          </Alert>
        </PanelBody>
      </Panel>
    );
  }

  const ready = label.trim().length >= 2;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      {/*
        The header is red and says what pressing the button does. Somebody who
        arrived here by mistake should know within one glance, and somebody who
        arrived here on purpose should not have to read anything.
      */}
      <div className="flex items-start gap-4 rounded-lg border-l-4 border-critical bg-critical-soft px-5 py-4">
        <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-lg bg-critical text-critical-contrast">
          <Siren className="size-5.5" aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">
            Emergency admission
          </h1>
          <p className="mt-0.5 text-sm text-ink-soft">
            Registers the patient and puts them at the front of the queue. A name
            is the only thing needed — everything else can be filled in once they
            are being seen.
          </p>
        </div>
      </div>

      <Panel>
        <PanelHeader
          title="Who is it?"
          description="If nobody knows, describe them. “Unknown male, approx 40” is a valid answer and a better record than a guessed name."
        />
        <PanelBody className="flex flex-col gap-4">
          <Field
            label="Name or description"
            htmlFor="emergency-label"
            required
            hint="The only required field on this screen."
          >
            <Input
              id="emergency-label"
              autoFocus
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Ramesh Kumar — or: Unknown male, approx 40"
              className="h-11 text-base"
            />
          </Field>

          <FieldGrid columns={3}>
            <Field label="Mobile" htmlFor="emergency-mobile" hint="Optional.">
              <Input
                id="emergency-mobile"
                value={mobile}
                onChange={(event) => setMobile(event.target.value)}
                placeholder="+919876543210"
              />
            </Field>
            <Field
              label="Gender"
              htmlFor="emergency-gender"
              hint="Leave as unknown rather than guessing."
            >
              <Select
                id="emergency-gender"
                value={gender}
                onChange={(event) => setGender(event.target.value)}
              >
                <option value="UNKNOWN">Not known</option>
                <option value="MALE">Male</option>
                <option value="FEMALE">Female</option>
                <option value="OTHER">Other</option>
              </Select>
            </Field>
            <Field
              label="Approximate age"
              htmlFor="emergency-age"
              hint="An estimate is useful. A guessed date of birth is not."
            >
              <Input
                id="emergency-age"
                type="number"
                inputMode="numeric"
                min={0}
                max={130}
                value={age}
                onChange={(event) => setAge(event.target.value)}
              />
            </Field>
          </FieldGrid>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="Who brought them in?"
          description="For somebody who cannot answer questions, the person standing next to them is the only history available — and the number is who gets rung when a decision is needed."
        />
        <PanelBody>
          <FieldGrid>
            <Field label="Attendant’s name" htmlFor="emergency-attendant" hint="Optional.">
              <Input
                id="emergency-attendant"
                value={attendantName}
                onChange={(event) => setAttendantName(event.target.value)}
                placeholder="Neighbour, son, passer-by"
              />
            </Field>
            <Field
              label="Attendant’s mobile"
              htmlFor="emergency-attendant-phone"
              hint="The number that gets rung, not the patient’s."
            >
              <Input
                id="emergency-attendant-phone"
                value={attendantPhone}
                onChange={(event) => setAttendantPhone(event.target.value)}
                placeholder="+919876543210"
              />
            </Field>
          </FieldGrid>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="What happened, and who sees them" />
        <PanelBody>
          <FieldGrid>
            <Field
              label="Reason"
              htmlFor="emergency-reason"
              hint="A few words. Not a diagnosis — the doctor writes that."
            >
              <Input
                id="emergency-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Road accident, head injury"
              />
            </Field>
            <Field
              label="Doctor"
              htmlFor="emergency-doctor"
              hint="Optional. Leave blank for whoever is free."
            >
              <Select
                id="emergency-doctor"
                value={practitionerId}
                onChange={(event) => setPractitionerId(event.target.value)}
              >
                <option value="">Any available doctor</option>
                {(staff?.items ?? []).map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.fullName}
                  </option>
                ))}
              </Select>
            </Field>
          </FieldGrid>
        </PanelBody>
      </Panel>

      {/*
        Said before the button, not after. Skipping the duplicate check is a real
        trade and the person making it should know they are making it — the
        record is recoverable by merging, which is the right direction for this
        error to run in.
      */}
      <Alert tone="warning" title="The duplicate check is skipped here">
        <span className="flex items-start gap-1.5">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          This patient may already exist in the register. That is accepted on
          purpose so nothing slows the admission down, it is recorded against your
          name, and a task is raised to merge and complete the record afterwards.
        </span>
      </Alert>

      <div className="sticky bottom-0 -mx-1 flex items-center justify-between gap-3 rounded-lg border border-line bg-surface/95 px-4 py-3 shadow-raise backdrop-blur">
        <p className="text-xs text-ink-faint">
          Goes straight to the front of the queue.
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => router.push('/queue')}>
            Cancel
          </Button>
          <Button
            variant="critical"
            size="lg"
            disabled={!ready}
            loading={admit.isPending}
            onClick={() => admit.mutate()}
          >
            <Siren aria-hidden />
            Admit and queue
          </Button>
        </div>
      </div>
    </div>
  );
}
