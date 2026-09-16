'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ShieldCheck } from 'lucide-react';
import { MfaInput } from '@emr/contracts';
import { ApiError, api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/feedback';

/**
 * Two-factor verification.
 *
 * Mandatory for Clinic Admin and Doctor — the two roles that can finalise a
 * clinical record or sign a prescription.
 */
export default function MfaPage() {
  const router = useRouter();
  const [formError, setFormError] = React.useState<string | null>(null);

  const form = useForm({
    resolver: zodResolver(MfaInput),
    defaultValues: { code: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api.post('/auth/mfa/verify', values);
      router.push('/today');
    } catch (error) {
      setFormError(
        error instanceof ApiError ? error.message : 'Could not verify that code.',
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
            <ShieldCheck className="size-4.5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold text-ink">Two-factor sign-in</h1>
            <p className="text-xs text-ink-faint">
              Enter the code from your authenticator app
            </p>
          </div>
        </div>

        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 shadow-raise"
          noValidate
        >
          {formError ? <Alert tone="critical" title={formError} /> : null}

          <Field
            label="6-digit code"
            htmlFor="code"
            required
            hint="Demo code: 123456"
            error={form.formState.errors.code?.message}
          >
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
              className="token text-lg tracking-[0.3em]"
              {...form.register('code')}
            />
          </Field>

          <Button
            type="submit"
            variant="primary"
            size="lg"
            loading={form.formState.isSubmitting}
          >
            Verify and continue
          </Button>
        </form>
      </div>
    </div>
  );
}
