'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import { Download, FileText, Lock, ShieldCheck } from 'lucide-react';
import { ApiError, api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/feedback';

/**
 * The public document viewer.
 *
 * One of only a handful of pages reachable without signing in, so it carries
 * its own defences:
 *
 *   - Every failure — unknown link, expired, revoked, opened too many times —
 *     produces the SAME message. The page must not confirm which links exist,
 *     or it becomes a way to probe for valid ones.
 *   - A one-time code to the patient's registered mobile is required for most
 *     document types.
 *   - The file is streamed through the server. The underlying storage location
 *     is never exposed to the recipient.
 *
 * Nothing about the clinic, the patient or the document is shown until the
 * recipient has proved they are the intended one.
 */
export default function SharedDocumentPage() {
  const params = useParams<{ token: string }>();

  /*
   * The OTP that worked, kept rather than cleared.
   *
   * `GET /share/:token/file` re-verifies it — the resolver is the only thing
   * standing between a leaked link and somebody's medical record, so it checks
   * on every request rather than trusting that a previous call succeeded. That
   * means the download needs the same code the verify step used.
   */
  const [verifiedOtp, setVerifiedOtp] = React.useState<string | null>(null);
  const [state, setState] = React.useState<'loading' | 'otp' | 'ready' | 'denied'>(
    'loading',
  );
  const [code, setCode] = React.useState('');
  const [hint, setHint] = React.useState<string | null>(null);
  const [document, setDocument] = React.useState<{ title: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [checking, setChecking] = React.useState(false);

  const attempt = React.useCallback(
    async (otp?: string) => {
      setChecking(true);
      setError(null);
      try {
        const result = await api.post<{ title: string }>(`/share/${params.token}`, {
          otp: otp ?? null,
        });
        setVerifiedOtp(otp ?? null);
        setDocument(result);
        setState('ready');
      } catch (cause) {
        if (cause instanceof ApiError) {
          const problem = cause.problem as { code?: string };
          if (problem.code === 'OTP_REQUIRED' || cause.status === 403) {
            setHint(cause.message);
            setState('otp');
            if (otp) setError('That code is not correct.');
            return;
          }
        }
        setState('denied');
      } finally {
        setChecking(false);
      }
    },
    [params.token],
  );

  React.useEffect(() => {
    void attempt();
  }, [attempt]);

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span
            className="flex size-9 items-center justify-center rounded-md bg-accent text-accent-contrast"
            aria-hidden
          >
            <ShieldCheck className="size-4.5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold text-ink">Secure document</h1>
            <p className="text-xs text-ink-faint">Shared by your clinic</p>
          </div>
        </div>

        <div className="rounded-lg border border-line bg-surface p-5 shadow-raise">
          {state === 'loading' ? (
            <p className="text-sm text-ink-faint">Checking this link…</p>
          ) : null}

          {/*
            Deliberately identical for every failure reason. Saying "expired"
            rather than "not found" would confirm that the link once existed.
          */}
          {state === 'denied' ? (
            <Alert tone="critical" title="This link is not valid">
              It may have expired, been opened too many times, or been withdrawn
              by the clinic. Contact the clinic for a new one.
            </Alert>
          ) : null}

          {state === 'otp' ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void attempt(code);
              }}
              className="flex flex-col gap-4"
              noValidate
            >
              <div className="flex items-start gap-2.5">
                <Lock className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                <p className="text-sm text-ink-soft">
                  {hint ?? 'Enter the code sent to your registered mobile number.'}
                </p>
              </div>

              <Field
                label="Verification code"
                htmlFor="otp"
                required
                error={error ?? undefined}
              >
                <Input
                  id="otp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  autoFocus
                  className="token text-lg tracking-[0.3em]"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              </Field>

              <Button type="submit" variant="primary" size="lg" loading={checking}>
                Open document
              </Button>
            </form>
          ) : null}

          {state === 'ready' && document ? (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-2.5">
                <FileText className="size-5 shrink-0 text-accent" aria-hidden />
                <p className="text-sm font-medium text-ink">{document.title}</p>
              </div>
              {/*
                The whole point of the page, and it did nothing.

                A patient opened the link, received an OTP, typed it correctly —
                and then met a button with no handler. `GET /share/:token/file`
                has existed all along and takes the same OTP as a query
                parameter, which is why it is kept in state after a successful
                verify rather than cleared.
              */}
              <Button variant="primary" size="lg" asChild>
                <a
                  href={`/api/share/${params.token}/file${
                    verifiedOtp ? `?otp=${encodeURIComponent(verifiedOtp)}` : ''
                  }`}
                  download={document.title}
                >
                  <Download aria-hidden />
                  Download
                </a>
              </Button>
              <p className="text-2xs text-ink-faint">
                This link expires automatically. Please do not forward it — it
                gives access to your medical document.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
