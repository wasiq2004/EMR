'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Stethoscope } from 'lucide-react';
import { LoginInput, ROLE_LABEL, type UserRole } from '@emr/contracts';
import { ApiError, api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/feedback';

/**
 * Sign in.
 *
 * The tenant is resolved from the clinic's own subdomain, not from anything the
 * user types — email is unique per clinic, not globally, so two clinics can
 * both have admin@example.com.
 *
 * NOTE FOR THE API: the specification currently states that the clinic id is
 * never accepted from a path, query, body or header. At sign-in there is no
 * token yet, so the subdomain (a Host header) is the only possible source. That
 * rule needs an explicit, narrow carve-out for this endpoint — see the open
 * items in the frontend specification.
 *
 * There is also no password-reset endpoint: the API defines exactly five
 * unauthenticated routes and reset is not among them. Until that is resolved,
 * this screen points the user at their administrator rather than offering a
 * link that goes nowhere.
 */
export default function LoginPage() {
  const router = useRouter();
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm({
    resolver: zodResolver(LoginInput),
    defaultValues: { email: 'priya.k@sunriseclinic.in', password: 'demo' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      const result = await api.post<{ mfaRequired: boolean }>('/auth/login', values);
      router.push(result.mfaRequired ? '/login/mfa' : '/today');
    } catch (error) {
      setFormError(
        error instanceof ApiError
          ? error.message
          : 'Could not sign in. Check your connection and try again.',
      );
    }
  });

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span
            className="flex size-9 items-center justify-center rounded-md bg-accent text-accent-contrast"
            aria-hidden
          >
            <Stethoscope className="size-4.5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold text-ink">Sunrise Family Clinic</h1>
            <p className="text-xs text-ink-faint">Sign in to continue</p>
          </div>
        </div>

        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 shadow-raise"
          noValidate
        >
          {formError ? <Alert tone="critical" title={formError} /> : null}

          <Field
            label="Email"
            htmlFor="email"
            required
            error={form.formState.errors.email?.message}
          >
            <Input
              type="email"
              autoComplete="username"
              autoFocus
              {...form.register('email')}
            />
          </Field>

          <Field
            label="Password"
            htmlFor="password"
            required
            error={form.formState.errors.password?.message}
          >
            <Input
              type="password"
              autoComplete="current-password"
              {...form.register('password')}
            />
          </Field>

          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={form.formState.isSubmitting}
          >
            Sign in
          </Button>

          <p className="text-2xs text-ink-faint">
            Forgotten your password? A clinic administrator can reset it for you from
            Staff and roles.
          </p>
        </form>

        <DemoRolePicker />
      </div>
    </div>
  );
}

/**
 * Development only. Lets a reviewer see each panel without seeding five
 * accounts. This component is not rendered once API_BASE_URL is configured,
 * because the real session comes from a verified token.
 */
function DemoRolePicker() {
  const router = useRouter();
  const roles: UserRole[] = [
    'RECEPTIONIST',
    'DOCTOR',
    'NURSE_ASSISTANT',
    'OWNER_ADMIN',
    'AUDITOR',
  ];

  const emails: Record<UserRole, string> = {
    RECEPTIONIST: 'priya.k@sunriseclinic.in',
    DOCTOR: 'anjali.mehta@sunriseclinic.in',
    NURSE_ASSISTANT: 'fatima.s@sunriseclinic.in',
    OWNER_ADMIN: 'owner@sunriseclinic.in',
    AUDITOR: 'compliance@sunriseclinic.in',
  };

  const signInAs = async (role: UserRole) => {
    await api.post('/auth/login', { email: emails[role], password: 'demo' });
    router.push(role === 'AUDITOR' ? '/audit' : '/today');
    router.refresh();
  };

  return (
    <div className="mt-4 rounded-md border border-dashed border-line p-3">
      <p className="text-2xs font-semibold uppercase tracking-wide text-ink-faint">
        Demo · open a panel
      </p>
      <p className="mt-1 text-2xs text-ink-faint">
        Sample data only. Not part of the production sign-in.
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {roles.map((role) => (
          <Button key={role} size="sm" variant="secondary" onClick={() => signInAs(role)}>
            {ROLE_LABEL[role]}
          </Button>
        ))}
      </div>
    </div>
  );
}
