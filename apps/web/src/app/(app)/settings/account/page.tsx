'use client';

import * as React from 'react';
import { ShieldCheck, Smartphone } from 'lucide-react';
import { ROLE_LABEL } from '@emr/contracts';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { DataList, Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Alert } from '@/components/ui/feedback';
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
