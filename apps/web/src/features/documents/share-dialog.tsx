'use client';

import * as React from 'react';
import { Ban, Copy, Link2, ShieldCheck } from 'lucide-react';
import { OTP_EXEMPT_DOCUMENT_TYPES } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/feedback';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Sharing a document with a patient or a referred consultant.
 *
 * This is deliberately NOT a plain storage link. Such a link cannot be revoked
 * once issued, produces no record of who opened it, works for anyone it is
 * forwarded to, and exposes the storage structure. For a patient's lab report
 * every one of those is unacceptable.
 *
 * What is issued instead: an opaque token resolved by the server, with an
 * expiry, an access cap, an optional one-time code to the patient's registered
 * mobile, and immediate revocation. Every access is recorded.
 *
 * The one-time code DEFAULTS TO ON for everything except a prescription or
 * invoice the patient is already expecting. Defaulting to open and relying on
 * staff to tick a box is how clinical documents end up in forwarded chat
 * threads.
 */
export function ShareDocumentDialog({
  documentId,
  documentType,
  documentTitle,
  patientName,
  open,
  onOpenChange,
}: {
  documentId: string;
  documentType: string;
  documentTitle: string;
  patientName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();

  const defaultOtp = !OTP_EXEMPT_DOCUMENT_TYPES.has(documentType);
  const [requireOtp, setRequireOtp] = React.useState(defaultOtp);
  const [ttlHours, setTtlHours] = React.useState('72');
  const [maxAccess, setMaxAccess] = React.useState('10');
  const [purpose, setPurpose] = React.useState('');
  const [issued, setIssued] = React.useState<string | null>(null);
  /*
   * The link's id, kept so it can actually be revoked.
   *
   * The dialog has always said "it can be revoked at any time", and
   * `POST /share-links/:id/revoke` has always existed — nothing called it. A
   * promise the interface could not keep, about the one control that limits the
   * damage when a link reaches the wrong person.
   */
  const [issuedId, setIssuedId] = React.useState<string | null>(null);
  const [revoked, setRevoked] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [revoking, setRevoking] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setIssued(null);
      setIssuedId(null);
      setRevoked(false);
      setRequireOtp(defaultOtp);
    }
  }, [open, defaultOtp]);

  const create = async () => {
    setCreating(true);
    try {
      const link = await api.post<{ id: string; url: string }>(
        `/documents/${documentId}/share`,
        {
          ttlHours: Number.parseInt(ttlHours, 10),
          maxAccessCount: Number.parseInt(maxAccess, 10),
          requireOtp,
          purpose: purpose.trim() || null,
        },
      );
      setIssued(link.url);
      setIssuedId(link.id);
    } catch {
      toast.error('Could not create the link', 'Try again in a moment.');
    } finally {
      setCreating(false);
    }
  };

  /**
   * Revokes the link that was just issued.
   *
   * Offered right beside the copy button, which is where it is needed: the
   * moment somebody realises they pasted it into the wrong chat. The server
   * returns 204 and the resolver refuses the token from then on — a recipient
   * mid-flow gets the same "not valid" page as an expired link, which is
   * deliberate: the public page never distinguishes revoked from expired from
   * never-existed, so a leaked link cannot be probed for whether it was real.
   */
  const revoke = async () => {
    if (!issuedId) return;
    setRevoking(true);
    try {
      await api.post(`/share-links/${issuedId}/revoke`, {});
      setRevoked(true);
      toast.success('Link revoked', 'It will no longer open for anybody.');
    } catch {
      toast.error('Could not revoke it', 'Try again in a moment.');
    } finally {
      setRevoking(false);
    }
  };

  const copy = async () => {
    if (!issued) return;
    await navigator.clipboard.writeText(issued);
    toast.success('Link copied');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Share &ldquo;{documentTitle}&rdquo;</DialogTitle>
          <DialogDescription>
            Creates a secure link for {patientName}. It can be revoked at any
            time, and every time it is opened is recorded.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-4">
          {issued ? (
            <>
              {revoked ? (
                <Alert tone="warning" title="Link revoked">
                  It will no longer open for anybody, including the patient.
                  Create a new one if they still need the document.
                </Alert>
              ) : (
                <Alert tone="positive" title="Link created">
                  Send this to the patient. It expires in {ttlHours} hours.
                </Alert>
              )}
              <div className="flex items-center gap-2 rounded-md border border-line bg-surface-sunk p-2">
                <Link2 className="size-4 shrink-0 text-ink-faint" aria-hidden />
                <span
                  className={cn(
                    'token min-w-0 flex-1 truncate text-xs',
                    revoked ? 'text-ink-faint line-through' : 'text-ink',
                  )}
                >
                  {issued}
                </span>
                {!revoked ? (
                  <>
                    <Button size="sm" variant="secondary" onClick={copy}>
                      <Copy aria-hidden />
                      Copy
                    </Button>
                    {/*
                      Beside Copy, because that is the moment it is needed —
                      when somebody realises they pasted it into the wrong chat.
                    */}
                    <Button
                      size="sm"
                      variant="critical"
                      loading={revoking}
                      onClick={revoke}
                    >
                      <Ban aria-hidden />
                      Revoke
                    </Button>
                  </>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Expires after" htmlFor="share-ttl">
                  <Select
                    id="share-ttl"
                    value={ttlHours}
                    onChange={(event) => setTtlHours(event.target.value)}
                  >
                    <option value="24">24 hours</option>
                    <option value="72">3 days</option>
                    <option value="168">7 days</option>
                  </Select>
                </Field>

                <Field
                  label="Times it can be opened"
                  htmlFor="share-max"
                  hint="Stops a forwarded link circulating."
                >
                  <Select
                    id="share-max"
                    value={maxAccess}
                    onChange={(event) => setMaxAccess(event.target.value)}
                  >
                    <option value="1">Once</option>
                    <option value="3">3 times</option>
                    <option value="10">10 times</option>
                  </Select>
                </Field>
              </div>

              <label className="flex items-start gap-2.5 rounded-md border border-line p-3">
                <input
                  type="checkbox"
                  checked={requireOtp}
                  onChange={(event) => setRequireOtp(event.target.checked)}
                  className="mt-0.5 size-4 accent-accent"
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                    <ShieldCheck className="size-3.5 text-accent" aria-hidden />
                    Ask for a code sent to the patient&rsquo;s mobile
                  </span>
                  <span className="mt-0.5 block text-2xs text-ink-faint">
                    {defaultOtp
                      ? 'Recommended for this document type. Without it, anyone the link is forwarded to can open it.'
                      : 'Optional for a prescription or invoice the patient is expecting.'}
                  </span>
                </span>
              </label>

              <Field
                label="Why is this being shared?"
                htmlFor="share-purpose"
                hint="Appears in the activity log."
              >
                <Input
                  id="share-purpose"
                  value={purpose}
                  onChange={(event) => setPurpose(event.target.value)}
                  placeholder="e.g. Referral to Dr Kamath, cardiology"
                />
              </Field>
            </>
          )}
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {issued ? 'Done' : 'Cancel'}
          </Button>
          {!issued ? (
            <Button variant="primary" onClick={create} loading={creating}>
              Create secure link
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
