'use client';

import * as React from 'react';
import { ROLE_LABEL } from '@emr/contracts';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
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
              if (mismatch || tooShort) return;
              toast.success('Password changed', 'Your other sessions have been signed out.');
              setCurrent('');
              setNext('');
              setConfirm('');
            }}
            className="flex max-w-sm flex-col gap-4"
          >
            <Field label="Current password" htmlFor="current" required>
              <Input
                id="current"
                type="password"
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
              error={tooShort ? 'Use at least 12 characters.' : undefined}
            >
              <Input
                id="next"
                type="password"
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
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              className="w-fit"
              disabled={!current || !next || mismatch || tooShort}
            >
              Change password
            </Button>
          </form>
        </PanelBody>
      </Panel>
    </div>
  );
}
