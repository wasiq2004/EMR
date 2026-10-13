'use client';

import * as React from 'react';
import { Field, FieldGrid, PasswordInput } from '@/components/ui/field';

/**
 * Setting somebody else's password.
 *
 * Used wherever one person chooses a credential for another — staff accounts,
 * platform operators, a new clinic's administrator. Passwords used to be
 * generated and read out; they are typed now, and this is the control that
 * types them.
 *
 * TWO FIELDS, ALWAYS. The person typing is not the person who will use it, so a
 * typo is not discovered by whoever made it — it is discovered by somebody who
 * cannot sign in, has no way to tell whether they are at fault, and whose only
 * recourse is to ask for another reset. Confirming costs four seconds.
 */
export function passwordProblem(password: string, confirmation: string): string | null {
  if (password.length === 0) return 'Set a password';
  if (password.length < 8) return 'Use at least 8 characters';
  if (new Set(password).size < 4) return 'Use a few more different characters';
  if (confirmation !== password) return 'The two passwords do not match';
  return null;
}

export function PasswordPair({
  idPrefix,
  password,
  confirmation,
  onPassword,
  onConfirmation,
  label = 'Password',
  hint = 'At least 8 characters. Tell them what you set.',
}: {
  idPrefix: string;
  password: string;
  confirmation: string;
  onPassword: (value: string) => void;
  onConfirmation: (value: string) => void;
  label?: string;
  hint?: string;
}) {
  const problem = passwordProblem(password, confirmation);

  return (
    <FieldGrid>
      <Field label={label} htmlFor={`${idPrefix}-password`} required hint={hint}>
        <PasswordInput
          id={`${idPrefix}-password`}
          value={password}
          onChange={(event) => onPassword(event.target.value)}
          autoComplete="new-password"
        />
      </Field>
      <Field
        label="Confirm password"
        htmlFor={`${idPrefix}-password-confirm`}
        required
        /*
         * Silent until they have started confirming. Telling somebody the two
         * do not match while the second box is still empty is noise, and a
         * field that is red before you touch it stops being read.
         */
        error={confirmation.length > 0 ? (problem ?? undefined) : undefined}
      >
        <PasswordInput
          id={`${idPrefix}-password-confirm`}
          value={confirmation}
          onChange={(event) => onConfirmation(event.target.value)}
          autoComplete="new-password"
        />
      </Field>
    </FieldGrid>
  );
}
