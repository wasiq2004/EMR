'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, MessageCircleQuestion, Pill, TriangleAlert } from 'lucide-react';
import { DISPENSE_STATUS_LABEL, type DispenseQueueRow } from '@emr/contracts';
import { usePharmacyAlerts, usePharmacyQueue } from '@/features/pharmacy/api';
import { formatMinutes, formatTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataState, StatRow } from '@/components/ui/data-state';
import { PageHeader, Panel, PanelBody, PanelHeader, Stat } from '@/components/ui/surface';
import { cn } from '@/lib/cn';

/**
 * The prescription queue — the pharmacist's home screen.
 *
 * WHAT IT ANSWERS, IN ORDER: who has been waiting longest, what is blocked on
 * somebody else, and what is ready to hand over. Everything else on this panel is
 * reachable from the sidebar; this screen is the counter's work list.
 *
 * SORTED BY WAIT, NOT BY ARRIVAL. They are the same thing until a prescription
 * gets stuck on a clarification, and then they are not — a blocked item should not
 * hold the top of the list while the pharmacist can be serving someone else. So
 * blocked items are separated out rather than left in line.
 *
 * ALLERGIES ARE ON THE ROW. Not behind a click. Handing amoxicillin to a
 * penicillin-allergic patient is the exact failure a pharmacy check exists to
 * catch, and a check that requires opening a record is a check that happens
 * sometimes.
 */
export default function PharmacyQueuePage() {
  const queue = usePharmacyQueue();
  const alerts = usePharmacyAlerts();

  const rows = queue.data ?? [];
  const blocked = rows.filter((r) => r.status === 'CLARIFICATION_NEEDED');
  const ready = rows.filter((r) => r.status === 'READY' || r.status === 'PARTIAL');
  const working = rows.filter(
    (r) => r.status === 'PENDING' || r.status === 'IN_PROGRESS',
  );

  const oldest = alerts.data?.oldestWaitingMinutes ?? null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Prescription queue"
        description="Finalised prescriptions arrive here automatically. Nothing is retyped."
        actions={
          <Button variant="secondary" asChild>
            <Link href="/pharmacy/alerts">
              <TriangleAlert aria-hidden />
              Stock alerts
            </Link>
          </Button>
        }
      />

      <StatRow>
        <Stat label="Waiting" value={working.length} />
        <Stat
          label="Ready to collect"
          value={ready.length}
          tone={ready.length > 0 ? 'positive' : 'neutral'}
        />
        <Stat
          label="Waiting on a doctor"
          value={blocked.length}
          tone={blocked.length > 0 ? 'warning' : 'neutral'}
          hint={blocked.length > 0 ? 'Someone else has to answer' : undefined}
        />
        <Stat
          label="Longest wait"
          value={oldest === null ? '—' : formatMinutes(oldest)}
          tone={oldest !== null && oldest > 20 ? 'critical' : 'neutral'}
        />
      </StatRow>

      {/*
        The blocked list is above the working list, and that is deliberate even
        though a pharmacist cannot act on it. It is the thing they need to chase,
        and burying it under work they can do means it is chased when the patient
        asks rather than before.
      */}
      {blocked.length > 0 ? (
        <Panel>
          <PanelHeader
            title="Waiting on a doctor"
            description="A question has been raised and not yet answered. The patient cannot be served until it is."
            actions={
              <Button size="sm" variant="ghost" asChild>
                <Link href="/pharmacy/clarifications">See the questions</Link>
              </Button>
            }
          />
          <PanelBody className="space-y-2">
            {blocked.map((row) => (
              <QueueRow key={row.id} row={row} />
            ))}
          </PanelBody>
        </Panel>
      ) : null}

      <Panel>
        <PanelHeader
          title="To prepare"
          description={
            working.length > 0
              ? 'Longest wait first.'
              : undefined
          }
        />
        <PanelBody className="space-y-2">
          <DataState
            query={{ ...queue, data: working }}
            empty={{
              icon: Pill,
              title: 'Nothing waiting',
              description:
                'Prescriptions appear here the moment a doctor signs a consultation.',
            }}
          >
            {(items) => items.map((row) => <QueueRow key={row.id} row={row} />)}
          </DataState>
        </PanelBody>
      </Panel>

      {ready.length > 0 ? (
        <Panel>
          <PanelHeader
            title="Ready to collect"
            description="Prepared and waiting for the patient."
          />
          <PanelBody className="space-y-2">
            {ready.map((row) => (
              <QueueRow key={row.id} row={row} />
            ))}
          </PanelBody>
        </Panel>
      ) : null}
    </div>
  );
}

function QueueRow({ row }: { row: DispenseQueueRow }) {
  /*
   * Twenty minutes is the threshold, and it is a judgement rather than a finding:
   * it is roughly how long a person will stand at a counter before asking. The
   * colour is paired with the word "waiting" and the figure, never used alone.
   */
  const late = row.waitingMinutes >= 20;

  return (
    <Link
      href={`/pharmacy/queue/${row.id}`}
      className={cn(
        'block rounded-md border border-line bg-surface px-3 py-2.5',
        'transition-colors duration-[--duration-ui] ease-[--ease-ui]',
        'hover:border-line-strong hover:bg-surface-sunk',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-ink">{row.patientName}</span>
            <span className="token text-2xs text-ink-faint">{row.patientMrn}</span>
            {row.patientAgeYears !== null ? (
              <span className="text-2xs text-ink-faint">{row.patientAgeYears}y</span>
            ) : null}
          </div>

          <p className="mt-0.5 text-xs text-ink-faint">
            {row.itemCount} item{row.itemCount === 1 ? '' : 's'}
            {row.dispensedItemCount > 0 ? ` · ${row.dispensedItemCount} done` : ''}
            {' · '}
            {row.prescriberName}
            {' · '}
            queued {formatTime(row.queuedAt)}
          </p>

          {/*
            The allergy strip. Loud on purpose, and it carries the word "allergy"
            as well as the colour — colour alone is not an accessible signal and
            this is the one thing on the row that is about safety.
          */}
          {row.allergySummary.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <AlertTriangle className="size-3.5 shrink-0 text-critical" aria-hidden />
              <span className="text-2xs font-semibold uppercase tracking-wide text-critical">
                Allergy
              </span>
              {row.allergySummary.map((substance) => (
                <Badge key={substance} tone="critical">
                  {substance}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge
            tone={
              row.status === 'CLARIFICATION_NEEDED'
                ? 'warning'
                : row.status === 'READY'
                  ? 'positive'
                  : row.status === 'PARTIAL'
                    ? 'info'
                    : 'neutral'
            }
          >
            {DISPENSE_STATUS_LABEL[row.status]}
          </Badge>

          <span
            className={cn(
              'tabular text-2xs',
              late ? 'font-semibold text-critical' : 'text-ink-faint',
            )}
          >
            waiting {formatMinutes(row.waitingMinutes)}
          </span>

          {row.openClarificationCount > 0 ? (
            <span className="flex items-center gap-1 text-2xs text-warning">
              <MessageCircleQuestion className="size-3" aria-hidden />
              {row.openClarificationCount} question
              {row.openClarificationCount === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
