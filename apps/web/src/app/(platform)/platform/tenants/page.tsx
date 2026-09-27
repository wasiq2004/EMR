'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/field';
import { Panel, PanelBody, PageHeader } from '@/components/ui/surface';
import { Skeleton } from '@/components/ui/feedback';
import { Button } from '@/components/ui/button';
import { OnboardClinicDialog } from '@/features/platform/onboard-clinic-dialog';

interface Tenant {
  id: string;
  name: string;
  slug: string;
  city: string | null;
  state: string | null;
  contactEmail: string | null;
  isActive: boolean;
  suspensionReason: string | null;
  plan: string | null;
  status: string | null;
  monthlyPricePaise: number | null;
  maxPatients: number | null;
  createdAt: string;
  usage: {
    patientsTotal: number;
    encounters: number;
    messagesSent: number;
    activeUsers: number;
    lastActiveDay: string | null;
  };
}

/**
 * Every clinic.
 *
 * Each row answers the three questions an operator actually has: is it running,
 * is it being used, and is it paying. Everything else is a click away.
 */
export default function TenantsPage() {
  const [term, setTerm] = React.useState('');
  const [onboardOpen, setOnboardOpen] = React.useState(false);

  const tenants = useQuery({
    queryKey: ['platform', 'tenants'],
    queryFn: () => api.get<{ items: Tenant[] }>('/platform/tenants'),
  });

  const items = React.useMemo(() => {
    const needle = term.trim().toLowerCase();
    const all = tenants.data?.items ?? [];
    if (!needle) return all;
    return all.filter(
      (tenant) =>
        tenant.name.toLowerCase().includes(needle) ||
        tenant.slug.includes(needle) ||
        tenant.city?.toLowerCase().includes(needle) ||
        tenant.contactEmail?.toLowerCase().includes(needle),
    );
  }, [tenants.data, term]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Clinics"
        description={`${items.length} on this deployment.`}
        actions={
          <Button variant="primary" onClick={() => setOnboardOpen(true)}>
            <Plus aria-hidden />
            Onboard a clinic
          </Button>
        }
      />

      <OnboardClinicDialog open={onboardOpen} onOpenChange={setOnboardOpen} />

      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint"
          aria-hidden
        />
        <Input
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Search by name, slug, city or contact email"
          aria-label="Search clinics"
          className="pl-8"
        />
      </div>

      {tenants.isLoading ? <Skeleton className="h-48 w-full" /> : null}

      <Panel>
        <PanelBody className="flex flex-col gap-1">
          {items.map((tenant) => {
            const quiet = daysSince(tenant.usage.lastActiveDay);

            return (
              <Link
                key={tenant.id}
                href={`/platform/tenants/${tenant.id}`}
                className="flex flex-col gap-1.5 rounded-md border border-line-soft px-3 py-2.5 hover:bg-surface-sunk"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink">{tenant.name}</span>
                  <span className="token text-2xs text-ink-faint">{tenant.slug}</span>

                  {!tenant.isActive ? (
                    <Badge tone="critical">Suspended</Badge>
                  ) : quiet > 7 ? (
                    // The earliest warning of a cancellation there is.
                    <Badge tone="warning">
                      {Number.isFinite(quiet) ? `Quiet ${quiet}d` : 'Never used'}
                    </Badge>
                  ) : null}

                  {tenant.status ? (
                    <Badge tone={tenant.status === 'PAST_DUE' ? 'warning' : 'neutral'}>
                      {tenant.status}
                    </Badge>
                  ) : (
                    <Badge tone="warning">No plan</Badge>
                  )}

                  <span className="ml-auto text-2xs text-ink-faint">
                    {tenant.city ?? '—'}
                  </span>
                </div>

                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-2xs text-ink-faint">
                  <span>
                    <strong className="tabular text-ink-soft">
                      {tenant.usage.patientsTotal}
                    </strong>{' '}
                    patients
                    {tenant.maxPatients ? ` of ${tenant.maxPatients}` : ''}
                  </span>
                  <span>
                    <strong className="tabular text-ink-soft">
                      {tenant.usage.encounters}
                    </strong>{' '}
                    consultations (30d)
                  </span>
                  <span>
                    <strong className="tabular text-ink-soft">
                      {tenant.usage.messagesSent}
                    </strong>{' '}
                    messages (30d)
                  </span>
                  {tenant.monthlyPricePaise ? (
                    <span>
                      ₹{(tenant.monthlyPricePaise / 100).toLocaleString('en-IN')}/month
                    </span>
                  ) : null}
                </div>

                {tenant.suspensionReason ? (
                  <p className="text-2xs text-critical">{tenant.suspensionReason}</p>
                ) : null}
              </Link>
            );
          })}

          {!tenants.isLoading && items.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-faint">
              {term ? 'Nothing matches that.' : 'No clinics yet.'}
            </p>
          ) : null}
        </PanelBody>
      </Panel>
    </div>
  );
}

function daysSince(day: string | null): number {
  if (!day) return Number.POSITIVE_INFINITY;
  return Math.floor((Date.now() - new Date(day).getTime()) / 86_400_000);
}
