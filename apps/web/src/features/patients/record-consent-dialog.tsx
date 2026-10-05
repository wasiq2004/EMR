'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CONSENT_SCOPE_LABEL, type ConsentScope } from '@emr/contracts';
import { ApiError, api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
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
 * Recording that a patient consented.
 *
 * EVERY FIELD HERE IS A LEGAL REQUIREMENT, not bookkeeping, and the dialog says
 * so. DPDP requires that a data principal was shown a specific notice, in a
 * language they chose, and that the manner of capture is recorded. None of them
 * has a convenient default that would let somebody record a consent nobody
 * actually gave.
 *
 * It is also the thing that makes messaging work. The send path refuses a
 * patient with no `WHATSAPP_COMMUNICATION` consent, so until this existed,
 * reminders and broadcasts were gated on something the product offered no way to
 * obtain.
 */
export function RecordConsentDialog({
  patientId,
  scope,
  onClose,
}: {
  patientId: string;
  /** Null closes it. */
  scope: ConsentScope | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [policyVersion, setPolicyVersion] = React.useState('');
  const [captureMethod, setCaptureMethod] = React.useState('IN_PERSON_SIGNED');
  const [presentedLanguage, setPresentedLanguage] = React.useState('en');
  const [expiresAt, setExpiresAt] = React.useState('');

  React.useEffect(() => {
    if (!scope) return;
    setPolicyVersion('');
    setCaptureMethod('IN_PERSON_SIGNED');
    setPresentedLanguage('en');
    setExpiresAt('');
  }, [scope]);

  const record = useMutation({
    mutationFn: () =>
      api.post(`/patients/${patientId}/consents`, {
        scope,
        policyVersion: policyVersion.trim(),
        captureMethod,
        presentedLanguage,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.patientConsents(patientId) });
      toast.success('Consent recorded');
      onClose();
    },
  });

  return (
    <Dialog open={scope !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record consent</DialogTitle>
          <DialogDescription>
            {scope ? CONSENT_SCOPE_LABEL[scope] : ''}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {record.isError ? (
            <Alert tone="critical" title="Could not record it">
              {record.error instanceof ApiError
                ? record.error.message
                : 'Something went wrong. Try again in a moment.'}
            </Alert>
          ) : null}

          <Alert tone="info" title="Record only what actually happened">
            A consent recorded without the patient having seen the notice is not a
            consent. This is the record a clinic would have to stand behind.
          </Alert>

          <Field
            label="Notice version"
            htmlFor="consent-version"
            required
            /*
             * The reason, on the field. "They consented" is not a defensible
             * record without it: a consent given against last year's notice does
             * not cover a purpose added since, and without the version nobody
             * can tell which notice applied.
             */
            hint="Which version of your notice they were shown. A consent without this cannot be relied on later."
          >
            <Input
              value={policyVersion}
              onChange={(event) => setPolicyVersion(event.target.value)}
              placeholder="v1.0"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="How it was given" htmlFor="consent-method" required>
              <Select
                value={captureMethod}
                onChange={(event) => setCaptureMethod(event.target.value)}
              >
                <option value="IN_PERSON_SIGNED">Signed on paper</option>
                <option value="VERBAL_RECORDED">Given verbally at the desk</option>
                <option value="DIGITAL_OTP">Confirmed by OTP</option>
              </Select>
            </Field>

            <Field
              label="Language of the notice"
              htmlFor="consent-language"
              required
              /*
               * DPDP gives the data principal the choice of language. Recording
               * English for a patient who was read the notice in Tamil makes the
               * record untrue in exactly the way the provision exists to
               * prevent.
               */
              hint="The language they read or heard it in."
            >
              <Select
                value={presentedLanguage}
                onChange={(event) => setPresentedLanguage(event.target.value)}
              >
                <option value="en">English</option>
                <option value="hi">Hindi</option>
                <option value="ta">Tamil</option>
                <option value="te">Telugu</option>
                <option value="kn">Kannada</option>
                <option value="ml">Malayalam</option>
                <option value="mr">Marathi</option>
                <option value="bn">Bengali</option>
                <option value="gu">Gujarati</option>
              </Select>
            </Field>
          </div>

          <Field
            label="Expires"
            htmlFor="consent-expires"
            hint="Leave blank for open-ended. ABDM linkage consents are always time-bounded."
          >
            <Input
              type="date"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </Field>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={record.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={policyVersion.trim().length === 0}
            loading={record.isPending}
            onClick={() => record.mutate()}
          >
            Record consent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Withdrawing one.
 *
 * NO REASON IS REQUIRED, and the dialog does not ask for one as a condition. A
 * patient exercising a right under the Act should not have to justify it to a
 * receptionist before the system will accept it. The field is there because a
 * clinic often wants its own note, not because the withdrawal depends on it.
 */
export function WithdrawConsentDialog({
  patientId,
  consentId,
  scope,
  onClose,
}: {
  patientId: string;
  consentId: string | null;
  scope: ConsentScope | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = React.useState('');

  React.useEffect(() => {
    if (consentId) setReason('');
  }, [consentId]);

  const withdraw = useMutation({
    mutationFn: () =>
      api.post(`/consents/${consentId}/withdraw`, { reason: reason.trim() || null }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.patientConsents(patientId) });
      toast.success(
        'Consent withdrawn',
        'It takes effect immediately — nothing further will be sent for this purpose.',
      );
      onClose();
    },
  });

  return (
    <Dialog
      open={consentId !== null}
      onOpenChange={(next) => (next ? undefined : onClose())}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Withdraw consent</DialogTitle>
          <DialogDescription>{scope ? CONSENT_SCOPE_LABEL[scope] : ''}</DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {withdraw.isError ? (
            <Alert tone="critical" title="Could not withdraw it">
              {withdraw.error instanceof ApiError
                ? withdraw.error.message
                : 'Something went wrong. Try again in a moment.'}
            </Alert>
          ) : null}

          {/*
            Says what it does and what it does not undo. A clinic worrying that
            withdrawal rewrites history will hesitate to honour one.
          */}
          <Alert tone="warning" title="This takes effect immediately">
            Nothing further will be sent for this purpose. Messages already sent
            stay on the record — they were sent while consent was held, and the
            record shows that.
          </Alert>

          <Field
            label="Note"
            htmlFor="withdraw-reason"
            hint="Optional. The patient does not have to give a reason."
          >
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Asked at the desk"
            />
          </Field>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={withdraw.isPending}>
            Cancel
          </Button>
          <Button
            variant="critical"
            loading={withdraw.isPending}
            onClick={() => withdraw.mutate()}
          >
            Withdraw
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
