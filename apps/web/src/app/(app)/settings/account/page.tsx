'use client';

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { ROLE_LABEL } from '@emr/contracts';
import { ApiError, api } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, PasswordInput } from '@/components/ui/field';
import { Alert } from '@/components/ui/feedback';
import { DataList, Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { ThemeSwitcher } from '@/components/layout/theme-switcher';
import { useToast } from '@/components/ui/toast';

/**
 * My account.
 *
 * Two-factor is mandatory for Clinic Admin and Doctor — the roles that can
 * finalise a clinical record. The grace period is shown plainly so nobody is
 * locked out mid-consultation by a deadline they never saw.
 */
export default function AccountSettingsPage() {
  const session = useSession();
  const toast = useToast();

  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [confirm, setConfirm] = React.useState('');

  const mismatch = confirm.length > 0 && next !== confirm;
  const tooShort = next.length > 0 && next.length < 12;
  const unchanged = next.length > 0 && next === current;

  /**
   * Changing your own password, for real.
   *
   * THIS FORM USED TO DO NOTHING. Its submit handler cleared the three fields
   * and showed "Password changed. Your other sessions have been signed out." It
   * called no API — there was no `POST /auth/change-password` on the server at
   * all. Somebody who changed their password because they believed it had been
   * seen came away thinking the old one was dead and other sessions were cut.
   * Neither was true, and the screen was the only thing telling them otherwise.
   *
   * The toast now reports what the server actually did, including the number of
   * sessions it revoked, because that sentence is the reason somebody uses this
   * form during an incident.
   */
  const change = useMutation({
    mutationFn: (input: { currentPassword: string; newPassword: string }) =>
      api.post<{ otherSessionsRevoked: number }>('/auth/change-password', input),
    onSuccess: (result) => {
      setCurrent('');
      setNext('');
      setConfirm('');
      toast.success(
        'Password changed',
        result.otherSessionsRevoked > 0
          ? `${result.otherSessionsRevoked} other ${
              result.otherSessionsRevoked === 1 ? 'session was' : 'sessions were'
            } signed out. Use the new password next time you sign in.`
          : 'Use the new password next time you sign in.',
      );
    },
    onError: (error) =>
      /*
       * The current-password failure is kept distinct from everything else. "That
       * is not your current password" is actionable; a generic "could not change
       * it" sends somebody looking for a server fault that is not there.
       */
      toast.error(
        'Password not changed',
        error instanceof ApiError
          ? error.message
          : 'Nothing was altered. Try again in a moment.',
      ),
  });

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <PanelHeader title="Your account" />
        <PanelBody>
          <DataList
            items={[
              { label: 'Name', value: session.fullName },
              { label: 'Email', value: session.email },
              { label: 'Role', value: ROLE_LABEL[session.role] },
              { label: 'Clinic', value: session.clinicName },
              {
                label: 'Can sign prescriptions',
                value: session.hasMedicalRegistration ? (
                  <Badge tone="positive">Yes</Badge>
                ) : (
                  <Badge tone="neutral">No registration number on file</Badge>
                ),
              },
            ]}
          />
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="Appearance"
          description="Applies to this browser only, and is not shared with your clinic."
        />
        <PanelBody className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-soft">
            Match the system theme, or pick one.
          </p>
          <ThemeSwitcher />
        </PanelBody>
      </Panel>

      {/*
       * TWO-FACTOR IS HIDDEN, NOT REMOVED. Owner decision, 2026-09-28.
       *
       * The enrolment flow was never built: `POST /auth/mfa/verify` deliberately
       * answers "not yet available on this deployment". So this panel offered a
       * button that could not work, beside a countdown to a deadline that never
       * arrives — which is worse than showing nothing, because it tells a doctor
       * they are about to be locked out of a system that has no way to let them
       * back in.
       *
       * TO BRING IT BACK: build TOTP enrolment behind `/auth/mfa/*`, then delete
       * these comment markers. The schema already carries `mfa_enabled` and
       * `mfa_secret_encrypted`, the session already exposes
       * `mfaGraceDaysRemaining`, and `MFA_GRACE_DAYS` is already configurable —
       * nothing below needs rewriting, only unhiding.
       *
      <Panel>
        <PanelHeader
          title="Two-factor sign-in"
          actions={
            session.mfaEnabled ? (
              <Badge tone="positive">
                <ShieldCheck aria-hidden />
                On
              </Badge>
            ) : (
              <Badge tone="warning">Not set up</Badge>
            )
          }
        />
        <PanelBody className="flex flex-col gap-3">
          {!session.mfaEnabled && session.mfaGraceDaysRemaining !== null ? (
            <Alert
              tone="warning"
              title={`Required in ${session.mfaGraceDaysRemaining} days`}
            >
              Your role can finalise clinical records, so two-factor sign-in is
              mandatory. Set it up now and you will not be interrupted later.
            </Alert>
          ) : null}

          <p className="text-sm text-ink-soft">
            You will enter a six-digit code from an authenticator app each time
            you sign in from a new device.
          </p>

          <Button variant={session.mfaEnabled ? 'secondary' : 'primary'} className="w-fit">
            <Smartphone aria-hidden />
            {session.mfaEnabled ? 'Reset two-factor' : 'Set up two-factor'}
          </Button>
        </PanelBody>
      </Panel>
      */}

      <Panel>
        <PanelHeader title="Change your password" />
        <PanelBody>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (mismatch || tooShort || unchanged) return;
              change.mutate({ currentPassword: current, newPassword: next });
            }}
            className="flex max-w-sm flex-col gap-4"
          >
            {/*
              Said here as well as enforced on the server. Somebody changing a
              password during an incident needs to know the old one stops
              working everywhere, not just on this device.
            */}
            <Alert tone="info" title="This signs out your other devices">
              Everywhere else you are signed in will need the new password. This
              device stays signed in.
            </Alert>
            <Field label="Current password" htmlFor="current" required>
              <PasswordInput
                id="current"
                autoComplete="current-password"
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
              />
            </Field>
            <Field
              label="New password"
              htmlFor="next"
              required
              hint="At least 12 characters. A short phrase you can remember beats a complicated word."
              error={
                tooShort
                  ? 'Use at least 12 characters.'
                  : unchanged
                    ? 'That is the password you are already using.'
                    : undefined
              }
            >
              {/*
              The reveal earns the most here. "These do not match" between two
              masked fields gives you no way to tell WHICH one has the typo, so
              the only remedy is to clear both and start again.
            */}
              <PasswordInput
                id="next"
                autoComplete="new-password"
                value={next}
                onChange={(event) => setNext(event.target.value)}
              />
            </Field>
            <Field
              label="Confirm new password"
              htmlFor="confirm"
              required
              error={mismatch ? 'These do not match.' : undefined}
            >
              <PasswordInput
                id="confirm"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              className="w-fit"
              loading={change.isPending}
              disabled={
                !current || !next || !confirm || mismatch || tooShort || unchanged
              }
            >
              Change password
            </Button>
          </form>
        </PanelBody>
      </Panel>
    </div>
  );
}
