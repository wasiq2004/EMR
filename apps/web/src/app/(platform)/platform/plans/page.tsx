'use client';

import * as React from 'react';
import { Layers, Plus } from 'lucide-react';
import { FEATURES } from '@emr/contracts';
import { usePlans, useRetirePlan, useSavePlan, type PlanRow } from '@/features/platform/api';
import { ApiError } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Alert, EmptyState, SkeletonRows } from '@/components/ui/feedback';
import { PageHeader, Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Table, TBody, TD, TH, THead, TR, TableScroller } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * The plan catalogue.
 *
 * A PLAN IS A TEMPLATE, NOT A CONTRACT. When a clinic is put on one, the price and
 * the limits are COPIED onto its subscription — so raising the list price here next
 * year does not silently reprice everyone already on it. That is why the clinic count
 * is shown on every row: it tells an operator how many customers a change will
 * *not* affect, which is the opposite of what most people assume.
 *
 * PLANS ARE RETIRED, NEVER DELETED. Clinics point at them, and last year's invoice
 * has to still resolve to a name.
 */
export default function PlansPage() {
  const plans = usePlans();
  const [editing, setEditing] = React.useState<PlanRow | 'new' | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Plans"
        description="What a clinic can be sold, and which modules each plan switches on."
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            <Plus aria-hidden />
            New plan
          </Button>
        }
      />

      <Alert tone="info" title="Changing a plan does not change existing customers">
        Price and limits are copied onto a clinic&apos;s subscription when it is assigned, so
        a clinic keeps what it was sold. Feature flags, however, ARE read through the
        plan — switching a module off here removes it from every clinic on this plan at
        their next request.
      </Alert>

      <Panel>
        <PanelHeader title="Catalogue" />
        <PanelBody>
          {plans.isLoading ? (
            <SkeletonRows rows={4} />
          ) : (plans.data ?? []).length === 0 ? (
            <EmptyState
              icon={Layers}
              title="No plans yet"
              description="A deployment with no plans has an empty plan picker, and the first clinic gets onboarded onto nothing."
              action={
                <Button variant="primary" onClick={() => setEditing('new')}>
                  New plan
                </Button>
              }
            />
          ) : (
            <TableScroller>
              <Table>
                <THead>
                  <TR>
                    <TH>Plan</TH>
                    <TH align="right">Monthly</TH>
                    <TH align="right">Practitioners</TH>
                    <TH align="right">Messages</TH>
                    <TH align="right">Trial</TH>
                    <TH>Modules</TH>
                    <TH align="right">Clinics</TH>
                    <TH />
                  </TR>
                </THead>
                <TBody>
                  {(plans.data ?? []).map((plan) => (
                    <TR key={plan.id} className={plan.isActive ? undefined : 'opacity-60'}>
                      <TD>
                        <span className="font-medium text-ink">{plan.name}</span>
                        <span className="token ml-1.5 text-2xs text-ink-faint">{plan.code}</span>
                        {!plan.isActive ? <Badge className="ml-1.5">Retired</Badge> : null}
                        {plan.isPrivate ? (
                          <Badge tone="info" className="ml-1.5">
                            Private
                          </Badge>
                        ) : null}
                        {plan.description ? (
                          <span className="mt-0.5 block max-w-md text-2xs text-ink-faint">
                            {plan.description}
                          </span>
                        ) : null}
                      </TD>
                      <TD align="right" className="tabular font-semibold">
                        ₹{(plan.monthlyPricePaise / 100).toLocaleString('en-IN')}
                      </TD>
                      <TD align="right" className="tabular">
                        {plan.maxPractitioners ?? '∞'}
                      </TD>
                      <TD align="right" className="tabular">
                        {plan.includedMessagesPerMonth === null
                          ? '∞'
                          : plan.includedMessagesPerMonth.toLocaleString('en-IN')}
                      </TD>
                      <TD align="right" className="tabular">
                        {plan.trialDays > 0 ? `${plan.trialDays}d` : '—'}
                      </TD>
                      <TD>
                        <Badge tone={plan.featureCount === plan.featureTotal ? 'positive' : 'neutral'}>
                          {plan.featureCount} of {plan.featureTotal}
                        </Badge>
                      </TD>
                      <TD align="right" className="tabular">
                        {plan.clinicsOnPlan > 0 ? (
                          <Badge tone="info">{plan.clinicsOnPlan}</Badge>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </TD>
                      <TD align="right">
                        <Button size="sm" variant="ghost" onClick={() => setEditing(plan)}>
                          Edit
                        </Button>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableScroller>
          )}
        </PanelBody>
      </Panel>

      <PlanDialog plan={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function PlanDialog({
  plan,
  onClose,
}: {
  plan: PlanRow | 'new' | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const save = useSavePlan();
  const retire = useRetirePlan();
  const existing = plan !== 'new' && plan !== null ? plan : null;

  const blank = {
    code: '',
    name: '',
    description: '',
    rupeesMonthly: '',
    rupeesAnnual: '',
    maxPractitioners: '',
    maxPatients: '',
    maxLocations: '',
    includedMessagesPerMonth: '',
    storageGb: '',
    trialDays: '14',
    displayOrder: '10',
    isActive: true,
    isPrivate: false,
    features: {} as Record<string, boolean>,
  };

  const [form, setForm] = React.useState(blank);

  React.useEffect(() => {
    if (!plan) return;
    if (plan === 'new') {
      setForm(blank);
      return;
    }
    setForm({
      code: plan.code,
      name: plan.name,
      description: plan.description ?? '',
      rupeesMonthly: String(plan.monthlyPricePaise / 100),
      rupeesAnnual: plan.annualPricePaise === null ? '' : String(plan.annualPricePaise / 100),
      maxPractitioners: plan.maxPractitioners === null ? '' : String(plan.maxPractitioners),
      maxPatients: plan.maxPatients === null ? '' : String(plan.maxPatients),
      maxLocations: plan.maxLocations === null ? '' : String(plan.maxLocations),
      includedMessagesPerMonth:
        plan.includedMessagesPerMonth === null ? '' : String(plan.includedMessagesPerMonth),
      storageGb: plan.storageGb === null ? '' : String(plan.storageGb),
      trialDays: String(plan.trialDays),
      displayOrder: String(plan.displayOrder),
      isActive: plan.isActive,
      isPrivate: plan.isPrivate,
      features: { ...plan.features },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  /**
   * Toggling a feature applies its dependencies in the UI as well as the server.
   *
   * Broadcasts need WhatsApp. Showing broadcasts on and WhatsApp off would be a
   * screen that disagrees with what the clinic actually gets, and the operator would
   * find out from a support call.
   */
  const toggleFeature = (key: string, on: boolean) => {
    const next = { ...form.features, [key]: on };
    const feature = FEATURES.find((f) => f.key === key);

    if (on) {
      for (const implied of feature?.implies ?? []) next[implied] = true;
    } else {
      // Turning one off takes anything that depends on it down too.
      for (const other of FEATURES) {
        if (other.implies.includes(key)) next[other.key] = false;
      }
    }
    set({ features: next });
  };

  const ready =
    /^[a-z0-9][a-z0-9-]*$/.test(form.code) &&
    form.name.trim().length >= 2 &&
    form.rupeesMonthly !== '';

  const nullableInt = (value: string) => (value === '' ? null : Number(value));

  return (
    <Dialog open={plan !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{existing ? `Edit ${existing.name}` : 'New plan'}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Code"
            htmlFor="plan-code"
            required
            hint="Stable identifier, referenced on invoices. Lower-case and hyphens."
          >
            <Input
              id="plan-code"
              value={form.code}
              disabled={Boolean(existing)}
              onChange={(event) => set({ code: event.target.value.toLowerCase() })}
              placeholder="clinic"
            />
          </Field>
          <Field label="Name" htmlFor="plan-name" required>
            <Input
              id="plan-name"
              value={form.name}
              onChange={(event) => set({ name: event.target.value })}
              placeholder="Clinic"
            />
          </Field>
        </div>

        <Field
          label="Description"
          htmlFor="plan-description"
          hint="One sentence. Shown beside the plan when an operator assigns it."
        >
          <Input
            id="plan-description"
            value={form.description}
            onChange={(event) => set({ description: event.target.value })}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Monthly price (₹)" htmlFor="plan-monthly" required>
            <Input
              id="plan-monthly"
              type="number"
              min={0}
              value={form.rupeesMonthly}
              onChange={(event) => set({ rupeesMonthly: event.target.value })}
            />
          </Field>
          <Field
            label="Annual price (₹)"
            htmlFor="plan-annual"
            hint="Usually ten months — two free."
          >
            <Input
              id="plan-annual"
              type="number"
              min={0}
              value={form.rupeesAnnual}
              onChange={(event) => set({ rupeesAnnual: event.target.value })}
            />
          </Field>
          <Field label="Trial days" htmlFor="plan-trial">
            <Input
              id="plan-trial"
              type="number"
              min={0}
              value={form.trialDays}
              onChange={(event) => set({ trialDays: event.target.value })}
            />
          </Field>
        </div>

        <p className="text-2xs text-ink-faint">
          Leave a limit blank for unlimited. Blank and zero are different answers —
          zero means none allowed.
        </p>

        <div className="grid gap-3 sm:grid-cols-5">
          <Field label="Practitioners" htmlFor="plan-prac">
            <Input
              id="plan-prac"
              type="number"
              min={1}
              value={form.maxPractitioners}
              onChange={(event) => set({ maxPractitioners: event.target.value })}
            />
          </Field>
          <Field label="Patients" htmlFor="plan-pat">
            <Input
              id="plan-pat"
              type="number"
              min={1}
              value={form.maxPatients}
              onChange={(event) => set({ maxPatients: event.target.value })}
            />
          </Field>
          <Field label="Locations" htmlFor="plan-loc">
            <Input
              id="plan-loc"
              type="number"
              min={1}
              value={form.maxLocations}
              onChange={(event) => set({ maxLocations: event.target.value })}
            />
          </Field>
          <Field label="Messages/month" htmlFor="plan-msg">
            <Input
              id="plan-msg"
              type="number"
              min={0}
              value={form.includedMessagesPerMonth}
              onChange={(event) => set({ includedMessagesPerMonth: event.target.value })}
            />
          </Field>
          <Field label="Storage (GB)" htmlFor="plan-storage">
            <Input
              id="plan-storage"
              type="number"
              min={1}
              value={form.storageGb}
              onChange={(event) => set({ storageGb: event.target.value })}
            />
          </Field>
        </div>

        <fieldset className="rounded-md border border-line-soft p-3">
          <legend className="px-1 text-2xs uppercase tracking-wide text-ink-faint">
            Modules this plan includes
          </legend>
          <p className="text-2xs text-ink-faint">
            Every flag defaults to off. A clinic on this plan gets exactly what is ticked
            here, unless an override is set on the clinic itself.
          </p>
          <div className="mt-2 space-y-2">
            {FEATURES.map((feature) => (
              <label key={feature.key} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={form.features[feature.key] === true}
                  onChange={(event) => toggleFeature(feature.key, event.target.checked)}
                />
                <span className="min-w-0">
                  <span className="font-medium text-ink">{feature.label}</span>
                  {feature.implies.length > 0 ? (
                    <Badge tone="info" className="ml-1.5">
                      needs {feature.implies.join(', ')}
                    </Badge>
                  ) : null}
                  <span className="block text-2xs text-ink-faint">{feature.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={form.isPrivate}
              onChange={(event) => set({ isPrivate: event.target.checked })}
            />
            Private — not offered publicly
          </label>
          <Field label="Display order" htmlFor="plan-order" className="w-32">
            <Input
              id="plan-order"
              type="number"
              min={0}
              value={form.displayOrder}
              onChange={(event) => set({ displayOrder: event.target.value })}
            />
          </Field>
        </div>

        {existing && existing.clinicsOnPlan > 0 ? (
          <Alert
            tone="warning"
            title={`${existing.clinicsOnPlan} clinic${existing.clinicsOnPlan === 1 ? '' : 's'} on this plan`}
          >
            Their price and limits will not change — those were copied when the plan was
            assigned. Module changes WILL reach them, at their next request.
          </Alert>
        ) : null}

        <DialogFooter>
          {existing && existing.isActive ? (
            <Button
              variant="ghost"
              loading={retire.isPending}
              onClick={() =>
                retire.mutate(existing.id, {
                  onSuccess: () => {
                    toast.success('Plan retired — existing clinics keep it');
                    onClose();
                  },
                  onError: (error) =>
                    toast.error(error instanceof ApiError ? error.message : 'That did not save'),
                })
              }
            >
              Retire
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                {
                  id: existing?.id,
                  code: form.code,
                  name: form.name,
                  description: form.description || null,
                  monthlyPricePaise: Math.round(Number(form.rupeesMonthly) * 100),
                  annualPricePaise: form.rupeesAnnual
                    ? Math.round(Number(form.rupeesAnnual) * 100)
                    : null,
                  maxPractitioners: nullableInt(form.maxPractitioners),
                  maxPatients: nullableInt(form.maxPatients),
                  maxLocations: nullableInt(form.maxLocations),
                  includedMessagesPerMonth: nullableInt(form.includedMessagesPerMonth),
                  storageGb: nullableInt(form.storageGb),
                  features: form.features,
                  isActive: form.isActive,
                  isPrivate: form.isPrivate,
                  trialDays: Number(form.trialDays || 0),
                  displayOrder: Number(form.displayOrder || 0),
                },
                {
                  onSuccess: () => {
                    toast.success('Plan saved');
                    onClose();
                  },
                  onError: (error) =>
                    toast.error(error instanceof ApiError ? error.message : 'That did not save'),
                },
              )
            }
          >
            Save plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
