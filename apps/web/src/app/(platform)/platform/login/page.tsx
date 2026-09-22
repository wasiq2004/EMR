'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ShieldAlert } from 'lucide-react';
import { ApiError, api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/feedback';

/**
 * Operator sign-in.
 *
 * A separate credential from any clinic account — different table, different
 * cookie, different token audience. A clinic administrator's password does not
 * work here, and an operator's does not work on a clinic.
 */
export default function PlatformLoginPage() {
  const router = useRouter();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post('/platform/auth/login', { email, password });
      router.replace('/platform');
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'That sign-in could not be completed.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span
            className="flex size-9 items-center justify-center rounded-md bg-ink text-ink-inverse"
            aria-hidden
          >
            <ShieldAlert className="size-4.5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold text-ink">Operations console</h1>
            <p className="text-xs text-ink-faint">Platform staff only</p>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 shadow-raise"
          noValidate
        >
          {error ? <Alert tone="critical" title={error} /> : null}

          <Field label="Email" htmlFor="op-email" required>
            <Input
              id="op-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>

          <Field label="Password" htmlFor="op-password" required>
            <Input
              id="op-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>

          <Button type="submit" variant="primary" size="lg" loading={busy}>
            Sign in
          </Button>

          <p className="text-xs leading-relaxed text-ink-soft">
            Operator accounts are created on the server and there is no
            self-service reset. Every action taken here is recorded against your
            name in a log the clinics can be shown.
          </p>
        </form>
      </div>
    </div>
  );
}
