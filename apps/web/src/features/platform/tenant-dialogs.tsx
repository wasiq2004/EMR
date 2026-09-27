'use client';

import * as React from 'react';
import { FEATURES, resolveFeatures } from '@emr/contracts';
import { usePlans, useResetClinicAdmin, useSetFeatures } from './api';
import { CredentialReveal } from './credential-reveal';
import { ApiError } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Which modules a clinic has.
 *
 * TWO LAYERS, SHOWN SEPARATELY. The plan says what the clinic bought; an override says
 * what this clinic gets regardless. Collapsing them into one row of checkboxes would
 * make it impossible to tell whether a module is on because it was sold or because
 * somebody switched it on once and forgot.
 *
 * So an override is three-state — Inherit, On, Off — rather than a tick. Setting one
 * back to Inherit is how a clinic rejoins its plan, and there would be no way to
 * express that with a checkbox.
 */
export function FeaturesDialog({
  open,
  onOpenChange,
  clinicId,
  planId,
  overrides,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clinicId: string;
  planId: string | null;
  overrides: Record<string, boolean>;
  onDone: () => void;
}) {
  const toast = useToast();
  const setFeatures = useSetFeatures();
  const plans = usePlans();

  const [draft, setDraft] = React.useState<Record<string, boolean>>({});
  const [reason, setReason] = React.useState('');

  React.useEffect(() => {
    if (!open) return;
    setDraft({ ...overrides });
    setReason('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const plan = (plans.data ?? []).find((p) => p.id === planId) ?? null;
  const planFeatures = plan?.features ?? {};

  /*
   * The effective set, computed with the SAME function the server uses.
   *
   * So the preview cannot disagree with what the clinic will actually get —
   * including the dependency pass, which is why turning on Broadcasts shows
   * WhatsApp turning on too.
   */
  const effective = resolveFeatures(planFeatures, draft);

  const setOverride = (key: string, value: 'inherit' | 'on' | 'off') => {
    setDraft((current) => {
      const next = { ...current };
      if (value === 'inherit') delete next[key];
      else next[key] = value === 'on';
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Modules for this clinic</DialogTitle>
        </DialogHeader>

        {plan ? (
          <p className="text-xs text-ink-faint">
            On plan <span className="font-medium text-ink">{plan.name}</span>. Anything left
            on Inherit follows that plan, so a later plan change reaches it.
          </p>
        ) : (
          <Alert tone="warning" title="This clinic has no plan">
            With no plan every module inherits as off. Assign a plan, or force on the ones
            this clinic needs.
          </Alert>
        )}

        <div className="space-y-2">
          {FEATURES.map((feature) => {
            const override =
              feature.key in draft ? (draft[feature.key] ? 'on' : 'off') : 'inherit';
            const fromPlan = planFeatures[feature.key] === true;
            const on = effective[feature.key] === true;

            return (
              <div key={feature.key} className="rounded-md border border-line px-3 py-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-ink">{feature.label}</span>
                      <Badge tone={on ? 'positive' : 'neutral'}>{on ? 'on' : 'off'}</Badge>
                      {override !== 'inherit' ? (
                        <Badge tone="warning">overridden</Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-2xs text-ink-faint">
                      Plan says {fromPlan ? 'on' : 'off'}
                      {feature.implies.length > 0
                        ? ` · needs ${feature.implies.join(', ')}`
                        : ''}
                    </p>
                  </div>

                  <div
                    className="inline-flex shrink-0 rounded-md border border-line p-0.5"
                    role="group"
                    aria-label={`${feature.label} override`}
                  >
                    {(['inherit', 'on', 'off'] as const).map((option) => (
                      <Button
                        key={option}
                        size="sm"
                        variant={override === option ? 'secondary' : 'ghost'}
                        aria-pressed={override === option}
                        className={
                          override === option ? 'bg-accent-soft text-accent-ink' : undefined
                        }
                        onClick={() => setOverride(feature.key, option)}
                      >
                        {option === 'inherit' ? 'Inherit' : option === 'on' ? 'On' : 'Off'}
                      </Button>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <Field
          label="Reason"
          htmlFor="features-reason"
          required
          hint="Recorded against your name. A module appearing or vanishing with no explanation is a support call."
        >
          <Input
            id="features-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Pilot agreed to trial the pharmacy module ahead of upgrading"
          />
        </Field>

        <Alert tone="info" title="This applies immediately">
          The clinic&apos;s cached feature set is dropped on save, so the change reaches
          them at their next request rather than up to thirty seconds later.
        </Alert>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={reason.trim().length < 10}
            loading={setFeatures.isPending}
            onClick={() =>
              setFeatures.mutate(
                { clinicId, features: draft, reason },
                {
                  onSuccess: () => {
                    toast.success('Modules updated');
                    onDone();
                  },
                  onError: (error) =>
                    toast.error(
                      error instanceof ApiError ? error.message : 'That did not save',
                    ),
                },
              )
            }
          >
            Save modules
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Rescues a locked-out clinic administrator.
 *
 * The most sensitive action in this console — it hands somebody a working credential for
 * a customer's clinic. So: PLATFORM_ADMIN only, a reason is required, it is audited, and
 * it resets ONE NAMED ACCOUNT.
 *
 * The email has to be known already because this console cannot list a clinic's staff.
 * That is deliberate rather than an omission: an operator must not be able to use a
 * password-reset form to discover who works at a clinic.
 */
export function ResetAdminDialog({
  open,
  onOpenChange,
  clinicId,
  clinicName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clinicId: string;
  clinicName: string;
}) {
  const toast = useToast();
  const reset = useResetClinicAdmin();
  const [email, setEmail] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [issued, setIssued] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) return;
    setEmail('');
    setReason('');
    setIssued(null);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset an administrator password</DialogTitle>
        </DialogHeader>

        {issued ? (
          <>
            <CredentialReveal
              email={email}
              password={issued}
              what={`administrator at ${clinicName}`}
            />
            <DialogFooter>
              <Button variant="primary" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <Alert tone="warning" title="This hands somebody a working credential">
              Use it only when the clinic has nobody who can let their administrator back
              in. It is recorded against your name with the reason you give, in a log the
              clinic can be shown.
            </Alert>

            <Field
              label="Administrator email"
              htmlFor="reset-email"
              required
              hint="Must be known already — this console cannot list a clinic's staff, by design."
            >
              <Input
                id="reset-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value.toLowerCase())}
              />
            </Field>

            <Field label="Why" htmlFor="reset-reason" required>
              <Input
                id="reset-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Sole administrator locked out; identity confirmed by phone with Dr Rao"
              />
            </Field>

            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                variant="critical"
                disabled={!EMAIL.test(email) || reason.trim().length < 10}
                loading={reset.isPending}
                onClick={() =>
                  reset.mutate(
                    { clinicId, adminEmail: email, reason },
                    {
                      onSuccess: (data) => {
                        setIssued(data.temporaryPassword);
                        toast.success('Password reset');
                      },
                      onError: (error) =>
                        toast.error(
                          error instanceof ApiError ? error.message : 'That did not save',
                        ),
                    },
                  )
                }
              >
                Reset password
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
