'use client';

import * as React from 'react';
import { Check, Copy, KeyRound } from 'lucide-react';
import { Alert } from '@/components/ui/feedback';
import { Button } from '@/components/ui/button';

/**
 * A one-time password, shown once.
 *
 * Used by all three flows that mint a credential — onboarding a clinic, rescuing a
 * locked-out administrator, and creating or resetting an operator — because the
 * handling rules are identical and writing them out three times is how one of them
 * ends up missing the warning.
 *
 * WHY IT IS SHOWN AT ALL. There is no mail provider connected. The honest options
 * are to display it once and say so, or to pretend an email was sent that never
 * arrives. The first leaves a clinic able to sign in; the second leaves them
 * waiting.
 *
 * WHY THERE IS NO "SHOW AGAIN". It is not stored in plaintext anywhere, so there is
 * nothing to show. The recovery path is to issue a new one, which is audited.
 */
export function CredentialReveal({
  email,
  password,
  what,
}: {
  email: string;
  password: string;
  /** e.g. "clinic administrator" or "operator" — used in the instruction sentence. */
  what: string;
}) {
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /*
       * Clipboard access can be refused — an insecure origin, or a browser policy.
       * The password is selectable text either way, so failing silently here is
       * correct: the operator reads it out, which is what they were going to do.
       */
    }
  };

  return (
    <Alert tone="warning" title="Write this down now">
      <p className="text-xs">
        Read it out to the {what} rather than sending it. It is not stored in
        plaintext and cannot be shown again — if it is lost, issue a new one.
      </p>

      <div className="mt-2 space-y-1.5">
        <div>
          <span className="text-2xs uppercase tracking-wide text-ink-faint">
            Sign in with
          </span>
          <p className="token text-sm text-ink">{email}</p>
        </div>

        <div>
          <span className="text-2xs uppercase tracking-wide text-ink-faint">
            One-time password
          </span>
          <div className="flex items-center gap-2">
            {/*
              `select-all` so one click grabs the whole string. A password read off a
              screen in parts is a password typed wrong.
            */}
            <code className="token select-all rounded-sm border border-warning-line bg-surface px-2 py-1 text-md font-semibold text-ink">
              {password}
            </code>
            <Button size="sm" variant="secondary" onClick={copy}>
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      </div>

      <p className="mt-2 flex items-start gap-1.5 text-2xs text-ink-faint">
        <KeyRound className="mt-0.5 size-3 shrink-0" aria-hidden />
        They will be asked to change it on first sign-in. Until they do, the account
        records that its password has never been changed from the one issued here.
      </p>
    </Alert>
  );
}
