'use client';

import * as React from 'react';
import { Activity, AlertTriangle, CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import { useAggregateUsage, usePlatformHealth } from '@/features/platform/api';
import { ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, SkeletonRows } from '@/components/ui/feedback';
import { PageHeader, Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';

/**
 * Is this deployment working.
 *
 * NOT A METRICS SYSTEM. The question this answers is "is it broken", not "how fast is
 * it" — a five-clinic deployment does not need a time-series database, and a page of
 * graphs nobody reads is worse than four checks somebody does.
 *
 * Each check says what it means in plain words, because "degraded" on its own sends
 * an operator to the logs. The usage-aggregation check is the one that matters most
 * and is easiest to miss: if that job stops, every figure on the overview quietly
 * freezes and nothing else goes wrong to signal it.
 */
export default function HealthPage() {
  const toast = useToast();
  const health = usePlatformHealth();
  const aggregate = useAggregateUsage();

  const status = health.data?.status;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Platform health"
        description="Four things worth knowing before the first support call."
        actions={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              loading={health.isFetching}
              onClick={() => void health.refetch()}
            >
              <RefreshCw aria-hidden />
              Check now
            </Button>
            <Button
              variant="secondary"
              loading={aggregate.isPending}
              onClick={() =>
                aggregate.mutate(undefined, {
                  onSuccess: (data) =>
                    toast.success(`Usage recomputed for ${data.clinics} clinics`),
                  onError: (error) =>
                    toast.error(
                      error instanceof ApiError ? error.message : 'That did not run',
                    ),
                })
              }
            >
              <Activity aria-hidden />
              Recompute usage
            </Button>
          </div>
        }
      />

      {status !== undefined ? (
        <Alert
          tone={status === 'ok' ? 'positive' : status === 'degraded' ? 'warning' : 'critical'}
          title={
            status === 'ok'
              ? 'Everything is answering'
              : status === 'degraded'
                ? 'Something is not right'
                : 'Something is down'
          }
        >
          {status === 'ok'
            ? 'No check reported a problem. Figures on the overview are current.'
            : 'Read the checks below — each one says what it means and what to do about it.'}
        </Alert>
      ) : null}

      <Panel>
        <PanelHeader
          title="Checks"
          description={
            health.data ? `Last run ${formatDateTime(health.data.at)}` : undefined
          }
        />
        <PanelBody className="space-y-2">
          {health.isLoading ? (
            <SkeletonRows rows={4} />
          ) : (
            (health.data?.checks ?? []).map((check) => (
              <div
                key={check.name}
                className={cn(
                  'flex items-start gap-2.5 rounded-md border px-3 py-2.5',
                  check.status === 'ok'
                    ? 'border-line'
                    : check.status === 'degraded'
                      ? 'border-warning-line bg-warning-soft'
                      : 'border-critical-line bg-critical-soft',
                )}
              >
                {check.status === 'ok' ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden />
                ) : check.status === 'degraded' ? (
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                ) : (
                  <XCircle className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden />
                )}

                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{check.name}</span>
                    <Badge
                      tone={
                        check.status === 'ok'
                          ? 'positive'
                          : check.status === 'degraded'
                            ? 'warning'
                            : 'critical'
                      }
                    >
                      {check.status}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-soft">{check.detail}</p>
                </div>
              </div>
            ))
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="What these mean" />
        <PanelBody className="space-y-2 text-xs text-ink-soft">
          <p>
            <span className="font-medium text-ink">Database. </span>
            A trivial query, timed. Over 250ms on a <span className="token">SELECT 1</span> is
            not slow, it is wrong — something is saturated or a connection pool is
            exhausted.
          </p>
          <p>
            <span className="font-medium text-ink">Usage aggregation. </span>
            The job that writes each clinic&apos;s daily counts. If it stops, every figure
            on the overview freezes at its last value and nothing else fails to tell you.
            Recompute above to catch up.
          </p>
          <p>
            <span className="font-medium text-ink">Tenancy. </span>
            How many clinics exist and how many are suspended. A sanity check on the
            console&apos;s own view of the estate.
          </p>
          <p>
            <span className="font-medium text-ink">Onboarding from console. </span>
            Degraded means <span className="token">MIGRATION_DATABASE_URL</span> is not set,
            so clinics can only be created from the command line. That is a legitimate
            deployment choice — it keeps the owner role off the API host — but it is worth
            knowing before you try.
          </p>
        </PanelBody>
      </Panel>
    </div>
  );
}
