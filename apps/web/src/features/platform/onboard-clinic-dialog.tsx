'use client';

import * as React from 'react';
import { useOnboardClinic, usePlans } from './api';
import { CredentialReveal } from '@/components/ui/credential-reveal';
import { ApiError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Onboarding a clinic.
 *
 * ONE TRANSACTION, TWO RECORDS. A clinic with no administrator cannot be signed into
 * and an administrator with no clinic is meaningless, so the server creates both or
 * neither. This form reflects that: there is no way to create a clinic and add its
 * first administrator later.
 *
 * THE SLUG IS THE SUBDOMAIN, so it is derived from the name rather than typed — and
 * it stays editable, because the derivation is a guess and "Dr Sharma's Clinic"
 * should not become `dr-sharmas-clinic` if the customer wants `sharma`.
 *
 * WHY THIS ACTION EXISTS AT ALL, given the console holds no patient data: the
 * alternative is shell access to a production database every time a customer signs
 * up. The server does this through a separate, narrowly-scoped connection precisely
 * so that it can write `app_user` without the console's own role ever gaining the
 * privilege to read it.
 */
export function OnboardClinicDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const onboard = useOnboardClinic();
  const plans = usePlans();

  const blank = {
    name: '',
    slug: '',
    adminName: '',
    adminEmail: '',
    planId: '',
    city: '',
    state: '',
    contactEmail: '',
    contactPhoneE164: '',
  };

  const [form, setForm] = React.useState(blank);
  const [slugEdited, setSlugEdited] = React.useState(false);
  const [issued, setIssued] = React.useState<{
    email: string;
    password: string;
    slug: string;
    /** False means the clinic has no plan, so every optional module is off. */
    planAssigned: boolean;
  } | null>(null);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  /* Reset when reopened, so a previous credential is never on screen twice. */
  React.useEffect(() => {
    if (open) return;
    setForm(blank);
    setSlugEdited(false);
    setIssued(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const setName = (name: string) => {
    set({ name, ...(slugEdited ? {} : { slug: slugify(name) }) });
  };

  const active = (plans.data ?? []).filter((plan) => plan.isActive);

  const slugValid = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(form.slug);
  const ready =
    form.name.trim().length >= 2 &&
    slugValid &&
    form.adminName.trim().length >= 2 &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.adminEmail);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{issued ? 'Clinic created' : 'Onboard a clinic'}</DialogTitle>
        </DialogHeader>

        {issued ? (
          <>
            <p className="text-sm text-ink-soft">
              <span className="font-semibold text-ink">{form.name}</span> is live at slug{' '}
              <span className="token">{issued.slug}</span>.
            </p>

            <CredentialReveal
              email={issued.email}
              password={issued.password}
              what="clinic administrator"
            />

            {/*
              Repeated AFTER creation, not just before it. The warning on the
              form is easy to click past, and this is the last moment anybody
              looks at this clinic before the staff do. A clinic onboarded
              without a plan can open a patient record and nothing else — and
              the first symptom its staff see is being told to contact their
              administrator, who is the person reading this screen.
            */}
            {!issued.planAssigned ? (
              <Alert tone="warning" title="This clinic has no plan yet">
                Every optional module is off — billing, documents, WhatsApp,
                pharmacy, lab and analytics. Assign a plan on the clinic&apos;s page
                before handing these details over, or its staff will be told to
                contact you.
              </Alert>
            ) : null}

            <DialogFooter>
              <Button variant="primary" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <Alert tone="info" title="The clinic and its first administrator are created together">
              A clinic with no administrator cannot be signed into. Everything else —
              locations, staff, services, templates — the clinic sets up itself.
            </Alert>

            <Field label="Clinic name" htmlFor="onboard-name" required>
              <Input
                id="onboard-name"
                value={form.name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Sunrise Family Clinic"
              />
            </Field>

            <Field
              label="Slug"
              htmlFor="onboard-slug"
              required
              hint="The clinic's subdomain. Lower-case letters, digits and hyphens. Cannot be changed later."
              error={
                form.slug.length > 0 && !slugValid
                  ? 'Lower-case letters, digits and hyphens, starting and ending with a letter or digit.'
                  : undefined
              }
            >
              <Input
                id="onboard-slug"
                value={form.slug}
                onChange={(event) => {
                  setSlugEdited(true);
                  set({ slug: event.target.value.toLowerCase() });
                }}
                placeholder="sunrise"
              />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Administrator name"
                htmlFor="onboard-admin-name"
                required
                hint="The person who will set the clinic up."
              >
                <Input
                  id="onboard-admin-name"
                  value={form.adminName}
                  onChange={(event) => set({ adminName: event.target.value })}
                />
              </Field>
              <Field
                label="Administrator email"
                htmlFor="onboard-admin-email"
                required
                hint="Their sign-in. A one-time password is issued for it."
              >
                <Input
                  id="onboard-admin-email"
                  type="email"
                  value={form.adminEmail}
                  onChange={(event) => set({ adminEmail: event.target.value.toLowerCase() })}
                />
              </Field>
            </div>

            <Field
              label="Plan"
              htmlFor="onboard-plan"
              hint={
                active.length === 0
                  ? 'No active plans in the catalogue — add one under Plans first, or leave this blank and set it afterwards.'
                  : 'Sets the price, the limits and which modules the clinic gets. Can be changed later.'
              }
            >
              <Select
                id="onboard-plan"
                value={form.planId}
                onChange={(event) => set({ planId: event.target.value })}
              >
                <option value="">No plan yet</option>
                {active.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name} — ₹{(plan.monthlyPricePaise / 100).toLocaleString('en-IN')}/month
                    {plan.trialDays > 0 ? ` · ${plan.trialDays}-day trial` : ''}
                  </option>
                ))}
              </Select>
            </Field>

            {form.planId === '' ? (
              <Alert tone="warning" title="Without a plan, every optional module is off">
                Feature flags default to off, so the clinic gets the core record and
                nothing else until a plan is assigned. That is a safe default, not a
                broken one — but it will look broken to them.
              </Alert>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="City" htmlFor="onboard-city">
                <Input
                  id="onboard-city"
                  value={form.city}
                  onChange={(event) => set({ city: event.target.value })}
                />
              </Field>
              <Field label="State" htmlFor="onboard-state">
                <Input
                  id="onboard-state"
                  value={form.state}
                  onChange={(event) => set({ state: event.target.value })}
                />
              </Field>
              <Field
                label="Billing contact email"
                htmlFor="onboard-contact-email"
                hint="Optional, and separate from the administrator's sign-in."
              >
                <Input
                  id="onboard-contact-email"
                  type="email"
                  value={form.contactEmail}
                  onChange={(event) => set({ contactEmail: event.target.value })}
                />
              </Field>
              <Field label="Contact phone" htmlFor="onboard-contact-phone">
                <Input
                  id="onboard-contact-phone"
                  value={form.contactPhoneE164}
                  onChange={(event) => set({ contactPhoneE164: event.target.value })}
                  placeholder="+919876543210"
                />
              </Field>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!ready}
                loading={onboard.isPending}
                onClick={() =>
                  onboard.mutate(
                    {
                      name: form.name.trim(),
                      slug: form.slug.trim(),
                      adminName: form.adminName.trim(),
                      adminEmail: form.adminEmail.trim(),
                      planId: form.planId || null,
                      city: form.city || null,
                      state: form.state || null,
                      contactEmail: form.contactEmail || null,
                      contactPhoneE164: form.contactPhoneE164 || null,
                    },
                    {
                      onSuccess: (data) => {
                        setIssued({
                          email: form.adminEmail.trim(),
                          password: data.temporaryPassword,
                          slug: data.slug,
                          planAssigned: data.planAssigned,
                        });
                        toast.success(`${form.name} created`);
                      },
                      onError: (error) =>
                        toast.error(
                          error instanceof ApiError
                            ? error.message
                            : 'That clinic could not be created',
                        ),
                    },
                  )
                }
              >
                Create clinic
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * A first guess at the subdomain.
 *
 * Strips the honorifics and the words every clinic has, because `dr-sharma-clinic`
 * is a worse subdomain than `sharma` and the operator would have deleted them
 * anyway. Still editable — this is a suggestion, not a rule.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(dr|prof|the|clinic|hospital|centre|center|care|medical)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}
