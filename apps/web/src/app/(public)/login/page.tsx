'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Stethoscope } from 'lucide-react';
import { LoginInput } from '@emr/contracts';
import { ApiError, api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Field, Input, PasswordInput } from '@/components/ui/field';
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
    defaultValues: { email: '', password: '' },
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
            <h1 className="text-lg font-semibold text-ink">Clinic EMR</h1>
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
            {/*
              Every clinical role signs in here — front desk, doctor, nurse,
              pharmacist, analyst, clinic admin — so this one field is the
              reveal that matters most. It is also where a password issued by an
              administrator gets typed for the first time, from memory or off a
              scrap of paper, and the only feedback on a typo is "email or
              password is incorrect", which does not say which of the two.
            */}
            <PasswordInput
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

          <p className="text-xs leading-relaxed text-ink-soft">
            Forgotten your password? A clinic administrator can reset it for you
            from Staff and roles.
          </p>
        </form>

      </div>
    </div>
  );
}
