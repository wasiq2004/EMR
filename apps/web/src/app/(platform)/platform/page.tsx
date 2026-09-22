'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { AlertTriangle, Building2, IndianRupee, TrendingUp } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Panel, PanelBody, PanelHeader, PageHeader } from '@/components/ui/surface';
import { Skeleton } from '@/components/ui/feedback';

interface Overview {
  clinics: number;
  active: number;
  suspended: number;
  mrrPaise: number;
  trials: number;
  pastDue: number;
  last30Days: {
    encounters: number;
    prescriptions: number;
    messagesSent: number;
    messagesFailed: number;
  };
}

interface Tenant {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  status: string | null;
  usage: { encounters: number; lastActiveDay: string | null };
}

/**
 * The estate at a glance.
 *
 * Two questions, in this order: is anyone broken, and is the business working.
 * A console that leads with revenue is a console that finds out about an outage
 * from the customer.
 */
export default function PlatformOverviewPage() {
  const overview = useQuery({
    queryKey: ['platform', 'overview'],
    queryFn: () => api.get<Overview>('/platform/overview'),
  });

  const tenants = useQuery({
    queryKey: ['platform', 'tenants'],
    queryFn: () => api.get<{ items: Tenant[] }>('/platform/tenants'),
  });

  if (overview.isLoading) return <Skeleton className="h-64 w-full" />;
  const data = overview.data;
  if (!data) return null;

  /*
   * A clinic that has done nothing for a week.
   *
   * The single most useful number on this screen. A clinic that has stopped
   * using the product has usually stopped for a reason nobody has been told
   * about, and it is the earliest warning of a cancellation there is.
   */
  const quiet = (tenants.data?.items ?? []).filter(
    (tenant) => tenant.isActive && daysSince(tenant.usage.lastActiveDay) > 7,
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Overview"
        description="Every clinic on this deployment."
      />

      {data.suspended > 0 || quiet.length > 0 ? (
        <Panel className="border-warning-line bg-warning-soft">
          <PanelBody className="flex flex-col gap-2">
            {quiet.length > 0 ? (
              <p className="flex items-start gap-2 text-sm text-warning">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  <strong>{quiet.length}</strong>{' '}
                  {quiet.length === 1 ? 'clinic has' : 'clinics have'} recorded no
                  activity for over a week:{' '}
                  {quiet.slice(0, 4).map((tenant, index) => (
                    <span key={tenant.id}>
                      {index > 0 ? ', ' : ''}
                      <Link href={`/platform/tenants/${tenant.id}`} className="underline">
                        {tenant.name}
                      </Link>
                    </span>
                  ))}
                  {quiet.length > 4 ? ' and others' : ''}.
                </span>
              </p>
            ) : null}

            {data.suspended > 0 ? (
              <p className="flex items-start gap-2 text-sm text-warning">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>
                  <strong>{data.suspended}</strong>{' '}
                  {data.suspended === 1 ? 'clinic is' : 'clinics are'} suspended and
                  cannot sign in.
                </span>
              </p>
            ) : null}
          </PanelBody>
        </Panel>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          icon={Building2}
          label="Clinics"
          value={data.clinics}
          hint={`${data.active} active · ${data.suspended} suspended`}
        />
        <Figure
          icon={IndianRupee}
          label="Monthly recurring"
          value={`₹${(data.mrrPaise / 100).toLocaleString('en-IN')}`}
          hint={`${data.trials} on trial · ${data.pastDue} past due`}
          tone={data.pastDue > 0 ? 'warning' : undefined}
        />
        <Figure
          icon={TrendingUp}
          label="Consultations"
          value={data.last30Days.encounters}
          hint="last 30 days, all clinics"
        />
        <Figure
          icon={TrendingUp}
          label="Messages sent"
          value={data.last30Days.messagesSent}
          hint={
            data.last30Days.messagesFailed > 0
              ? `${data.last30Days.messagesFailed} failed`
              : 'none failed'
          }
          tone={data.last30Days.messagesFailed > 0 ? 'warning' : undefined}
        />
      </div>

      <Panel>
        <PanelHeader
          title="Clinics"
          description="Newest first."
          actions={
            <Link href="/platform/tenants" className="text-xs text-accent hover:underline">
              See all
            </Link>
          }
        />
        <PanelBody className="flex flex-col gap-1.5">
          {(tenants.data?.items ?? []).slice(0, 8).map((tenant) => (
            <Link
              key={tenant.id}
              href={`/platform/tenants/${tenant.id}`}
              className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-surface-sunk"
            >
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                {tenant.name}
              </span>
              <span className="token text-2xs text-ink-faint">{tenant.slug}</span>
              {!tenant.isActive ? <Badge tone="critical">Suspended</Badge> : null}
              {tenant.status ? <Badge tone="neutral">{tenant.status}</Badge> : null}
            </Link>
          ))}
        </PanelBody>
      </Panel>
    </div>
  );
}

function Figure({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: typeof Building2;
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'warning';
}) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4 shadow-raise">
      <p className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-ink-faint">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </p>
      <p className="mt-1.5 text-2xl font-semibold tabular text-ink">{value}</p>
      {hint ? (
        <p className={tone === 'warning' ? 'mt-0.5 text-xs text-warning' : 'mt-0.5 text-xs text-ink-faint'}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function daysSince(day: string | null): number {
  // Never active counts as infinitely quiet: a clinic that was provisioned and
  // never used is exactly the one to call.
  if (!day) return Number.POSITIVE_INFINITY;
  return Math.floor((Date.now() - new Date(day).getTime()) / 86_400_000);
}
