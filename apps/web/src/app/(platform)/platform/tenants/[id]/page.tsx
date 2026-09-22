'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pause, Play } from 'lucide-react';
import { ApiError, api } from '@/lib/api-client';
import { formatDate } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { DataList, Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface TenantDetail {
  clinic: {
    id: string;
    name: string;
    slug: string;
    registrationNumber: string | null;
    city: string | null;
    state: string | null;
    contactEmail: string | null;
    contactPhoneE164: string | null;
    timezone: string;
    isActive: boolean;
    suspendedAt: string | null;
    suspensionReason: string | null;
    createdAt: string;
  };
  subscription: {
    plan: string;
    status: string;
    monthlyPricePaise: number;
    maxPractitioners: number | null;
    maxPatients: number | null;
    includedMessagesPerMonth: number | null;
    trialEndsAt: string | null;
    notes: string | null;
  } | null;
  usage: {
    day: string;
    activeUsers: number;
    patientsTotal: number;
    encounters: number;
    prescriptions: number;
    messagesSent: number;
    messagesFailed: number;
  }[];
}

/**
 * One clinic.
 *
 * Everything an operator can know about a customer, which is deliberately
 * everything except what the customer's patients said. Contact details, the
 * plan, and a column of daily counts.
 */
export default function TenantPage() {
  const params = useParams<{ id: string }>();
  const clinicId = params.id;
  const queryClient = useQueryClient();

  const [suspendOpen, setSuspendOpen] = React.useState(false);
  const [planOpen, setPlanOpen] = React.useState(false);

  const tenant = useQuery({
    queryKey: ['platform', 'tenant', clinicId],
    queryFn: () => api.get<TenantDetail>(`/platform/tenants/${clinicId}`),
  });

  const audit = useQuery({
    queryKey: ['platform', 'audit', clinicId],
    queryFn: () =>
      api.get<{ items: AuditEntry[] }>(`/platform/audit?clinicId=${clinicId}`),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['platform'] });
  };

  if (tenant.isLoading) return <Skeleton className="h-96 w-full" />;
  const data = tenant.data;
  if (!data) return null;

  const { clinic, subscription } = data;
  const recent = data.usage.slice(-14);

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/platform/tenants"
        className="inline-flex items-center gap-1.5 text-xs text-ink-faint hover:text-ink"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        All clinics
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink">{clinic.name}</h1>
          <p className="mt-0.5 text-xs text-ink-faint">
            <span className="token">{clinic.slug}</span> · joined{' '}
            {formatDate(clinic.createdAt)}
          </p>
        </div>

        {clinic.isActive ? (
          <Button variant="secondary" onClick={() => setSuspendOpen(true)}>
            <Pause aria-hidden />
            Suspend
          </Button>
        ) : (
          <Button variant="primary" onClick={() => setSuspendOpen(true)}>
            <Play aria-hidden />
            Restore
          </Button>
        )}
      </div>

      {!clinic.isActive ? (
        <Alert tone="critical" title="This clinic is suspended">
          Nobody there can sign in. {clinic.suspensionReason}
          {clinic.suspendedAt ? ` (since ${formatDate(clinic.suspendedAt)})` : ''}
        </Alert>
      ) : null}

      <Panel>
        <PanelHeader title="Clinic" />
        <PanelBody>
          <DataList
            items={[
              { label: 'Contact email', value: clinic.contactEmail ?? '—' },
              { label: 'Contact phone', value: clinic.contactPhoneE164 ?? '—' },
              {
                label: 'Location',
                value: [clinic.city, clinic.state].filter(Boolean).join(', ') || '—',
              },
              { label: 'Clinic registration', value: clinic.registrationNumber ?? '—' },
              { label: 'Timezone', value: clinic.timezone },
              {
                label: 'Status',
                value: clinic.isActive ? (
                  <Badge tone="positive">Active</Badge>
                ) : (
                  <Badge tone="critical">Suspended</Badge>
                ),
              },
            ]}
          />
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="Plan"
          description={subscription ? undefined : 'No plan recorded for this clinic.'}
          actions={
            <Button size="sm" variant="secondary" onClick={() => setPlanOpen(true)}>
              {subscription ? 'Change plan' : 'Set a plan'}
            </Button>
          }
        />
        {subscription ? (
          <PanelBody>
            <DataList
              items={[
                { label: 'Plan', value: subscription.plan },
                { label: 'Status', value: <Badge tone="neutral">{subscription.status}</Badge> },
                {
                  label: 'Monthly',
                  value: `₹${(subscription.monthlyPricePaise / 100).toLocaleString('en-IN')}`,
                },
                { label: 'Patient limit', value: subscription.maxPatients ?? 'Unlimited' },
                {
                  label: 'Practitioner limit',
                  value: subscription.maxPractitioners ?? 'Unlimited',
                },
                {
                  label: 'Included messages',
                  value: subscription.includedMessagesPerMonth ?? 'Unmetered',
                },
              ]}
            />
            {subscription.notes ? (
              <p className="mt-3 text-xs text-ink-soft">{subscription.notes}</p>
            ) : null}
          </PanelBody>
        ) : null}
      </Panel>

      <Panel>
        <PanelHeader
          title="Activity"
          description="Daily counts. This is the only view of what happens inside this clinic."
        />
        <PanelBody>
          {recent.length === 0 ? (
            <p className="text-sm text-ink-faint">
              No usage recorded yet. Counts are computed once a day, for the day
              before.
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-ink-faint">
                  <th className="pb-1.5 font-medium">Day</th>
                  <th className="pb-1.5 text-right font-medium">Staff</th>
                  <th className="pb-1.5 text-right font-medium">Patients</th>
                  <th className="pb-1.5 text-right font-medium">Consults</th>
                  <th className="pb-1.5 text-right font-medium">Scripts</th>
                  <th className="pb-1.5 text-right font-medium">Messages</th>
                </tr>
              </thead>
              <tbody>
                {[...recent].reverse().map((row) => (
                  <tr key={row.day} className="border-t border-line-soft">
                    <td className="py-1.5 text-ink-soft">{row.day}</td>
                    <td className="py-1.5 text-right tabular text-ink">{row.activeUsers}</td>
                    <td className="py-1.5 text-right tabular text-ink">{row.patientsTotal}</td>
                    <td className="py-1.5 text-right tabular text-ink">{row.encounters}</td>
                    <td className="py-1.5 text-right tabular text-ink">{row.prescriptions}</td>
                    <td className="py-1.5 text-right tabular text-ink">
                      {row.messagesSent}
                      {row.messagesFailed > 0 ? (
                        <span className="text-critical"> ({row.messagesFailed} failed)</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="What we did to this clinic"
          description="Operator actions only. The clinic's own activity log is theirs and is not readable from here."
        />
        <PanelBody className="flex flex-col gap-2">
          {(audit.data?.items ?? []).length === 0 ? (
            <p className="text-sm text-ink-faint">Nothing yet.</p>
          ) : null}
          {(audit.data?.items ?? []).map((entry) => (
            <div key={entry.id} className="border-b border-line-soft pb-2 last:border-0">
              <p className="text-xs font-medium text-ink">
                {entry.action.replaceAll('_', ' ').toLowerCase()}
                <span className="font-normal text-ink-faint">
                  {' '}
                  · {entry.actorName} · {formatDate(entry.occurredAt)}
                </span>
              </p>
              {entry.reason ? (
                <p className="mt-0.5 text-xs text-ink-soft">{entry.reason}</p>
              ) : null}
            </div>
          ))}
        </PanelBody>
      </Panel>

      <StateDialog
        open={suspendOpen}
        onOpenChange={setSuspendOpen}
        clinicId={clinicId}
        suspending={clinic.isActive}
        clinicName={clinic.name}
        onDone={() => {
          setSuspendOpen(false);
          refresh();
        }}
      />

      <PlanDialog
        open={planOpen}
        onOpenChange={setPlanOpen}
        clinicId={clinicId}
        current={subscription}
        onDone={() => {
          setPlanOpen(false);
          refresh();
        }}
      />
    </div>
  );
}

interface AuditEntry {
  id: string;
  action: string;
  actorName: string | null;
  reason: string | null;
  occurredAt: string;
}

/**
 * Suspend or restore.
 *
 * The reason is required by the server and repeated here, because an operator
 * about to stop a clinic working should be made to write down why before the
 * button does anything.
 */
function StateDialog({
  open,
  onOpenChange,
  clinicId,
  clinicName,
  suspending,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clinicId: string;
  clinicName: string;
  suspending: boolean;
  onDone: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = React.useState('');

  React.useEffect(() => {
    if (open) setReason('');
  }, [open]);

  const act = useMutation({
    mutationFn: () =>
      api.post(`/platform/tenants/${clinicId}/${suspending ? 'suspend' : 'restore'}`, {
        reason,
      }),
    onSuccess: () => {
      toast.success(suspending ? 'Clinic suspended' : 'Clinic restored');
      onDone();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'That did not work'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{suspending ? `Suspend ${clinicName}?` : `Restore ${clinicName}?`}</DialogTitle>
        </DialogHeader>

        {suspending ? (
          <Alert tone="critical" title="Everyone there is signed out within seconds">
            A doctor mid-consultation loses access. Their records are untouched
            and return when the clinic is restored.
          </Alert>
        ) : null}

        <Field
          label="Reason"
          htmlFor="state-reason"
          hint="Recorded against your name, and the clinic can be shown it."
          required
        >
          <Input
            id="state-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={
              suspending ? 'Non-payment: invoice 41 overdue by 45 days' : 'Payment received'
            }
          />
        </Field>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={suspending ? 'critical' : 'primary'}
            disabled={reason.trim().length < 10}
            loading={act.isPending}
            onClick={() => act.mutate()}
          >
            {suspending ? 'Suspend' : 'Restore'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlanDialog({
  open,
  onOpenChange,
  clinicId,
  current,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clinicId: string;
  current: TenantDetail['subscription'];
  onDone: () => void;
}) {
  const toast = useToast();
  const [form, setForm] = React.useState({
    plan: 'pilot',
    status: 'TRIAL',
    rupees: '3000',
    maxPatients: '',
    reason: '',
  });

  React.useEffect(() => {
    if (!open) return;
    setForm({
      plan: current?.plan ?? 'pilot',
      status: current?.status ?? 'TRIAL',
      rupees: current ? String(current.monthlyPricePaise / 100) : '3000',
      maxPatients: current?.maxPatients ? String(current.maxPatients) : '',
      reason: '',
    });
  }, [open, current]);

  const save = useMutation({
    mutationFn: () =>
      api.post(`/platform/tenants/${clinicId}/plan`, {
        plan: form.plan,
        status: form.status,
        // Entered in rupees, stored in paise. Money is never a float.
        monthlyPricePaise: Math.round(Number(form.rupees) * 100),
        maxPatients: form.maxPatients ? Number(form.maxPatients) : null,
        reason: form.reason,
      }),
    onSuccess: () => {
      toast.success('Plan saved');
      onDone();
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'That did not save'),
  });

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{current ? 'Change plan' : 'Set a plan'}</DialogTitle>
        </DialogHeader>

        <Field label="Plan" htmlFor="plan-name" required>
          <Input
            id="plan-name"
            value={form.plan}
            onChange={(event) => set({ plan: event.target.value })}
          />
        </Field>

        <Field label="Status" htmlFor="plan-status" required>
          <select
            id="plan-status"
            value={form.status}
            onChange={(event) => set({ status: event.target.value })}
            className="h-9 w-full rounded-md border border-line-control bg-surface px-2 text-sm text-ink"
          >
            {['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Monthly price (₹)" htmlFor="plan-price" required>
          <Input
            id="plan-price"
            type="number"
            min={0}
            value={form.rupees}
            onChange={(event) => set({ rupees: event.target.value })}
          />
        </Field>

        <Field
          label="Patient limit"
          htmlFor="plan-max"
          hint="Blank for unlimited. A clinic over its limit is told to upgrade — never stopped from registering a patient."
        >
          <Input
            id="plan-max"
            type="number"
            min={1}
            value={form.maxPatients}
            onChange={(event) => set({ maxPatients: event.target.value })}
          />
        </Field>

        <Field label="Reason" htmlFor="plan-reason" hint="Recorded against your name." required>
          <Input
            id="plan-reason"
            value={form.reason}
            onChange={(event) => set({ reason: event.target.value })}
            placeholder="Pilot agreement signed 22 September"
          />
        </Field>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={form.reason.trim().length < 10}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
