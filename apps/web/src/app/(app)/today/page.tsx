'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  Banknote,
  ClipboardList,
  Inbox,
  Stethoscope,
  Thermometer,
  UserPlus,
  Users,
} from 'lucide-react';
import type { Route } from 'next';
import type { ReportSummary, Task } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { useSession } from '@/lib/session';
import { ageGender, formatMinutes, formatPaiseShort } from '@/lib/format';
import { useQueue, useStartConsultation } from '@/features/queue/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Panel, PanelBody, PanelHeader, PageHeader, Stat } from '@/components/ui/surface';
import { EmptyState, SkeletonRows } from '@/components/ui/feedback';

/**
 * Today.
 *
 * One route, four renderings. The role decides what question the screen
 * answers, and only one of the four is an analytics dashboard — a doctor who
 * opens the app to a revenue chart is a product failure. The doctor opens it to
 * "who is next".
 */
export default function TodayPage() {
  const session = useSession();

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <PageHeader
        title={greeting(session.fullName)}
        description={new Date().toLocaleDateString('en-IN', {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
        })}
      />

      {session.role === 'RECEPTIONIST' ? <FrontDeskHome /> : null}
      {session.role === 'DOCTOR' ? <DoctorHome /> : null}
      {session.role === 'NURSE_ASSISTANT' ? <NurseHome /> : null}
      {session.role === 'OWNER_ADMIN' ? <ClinicAdminHome /> : null}
    </div>
  );
}

function greeting(fullName: string): string {
  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const first = fullName.split(' ').slice(0, 2).join(' ');
  return `${part}, ${first}`;
}

/* ------------------------------------------------------------------------- *
 * Front Desk — a work queue, not a dashboard
 * ------------------------------------------------------------------------- */

function FrontDeskHome() {
  const queue = useQueue();
  const tasks = useOpenTasks();
  const waiting = queue.data?.waiting ?? [];
  const longestWait = waiting.reduce((max, e) => Math.max(max, e.waitingMinutes ?? 0), 0);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Panel>
          <PanelBody>
            <Stat
              label="Waiting now"
              value={waiting.filter((e) => e.appointment.status === 'ARRIVED').length}
            />
          </PanelBody>
        </Panel>
        <Panel>
          <PanelBody>
            <Stat
              label="Longest wait"
              value={formatMinutes(longestWait || null)}
              tone={longestWait > 45 ? 'warning' : 'neutral'}
              hint={longestWait > 45 ? 'Consider telling the patient' : undefined}
            />
          </PanelBody>
        </Panel>
        <Panel>
          <PanelBody>
            <Stat
              label="Seen today"
              value={queue.data?.completed.length ?? 0}
            />
          </PanelBody>
        </Panel>
        <Panel>
          <PanelBody>
            <Stat
              label="Open tasks"
              value={tasks.data?.items.length ?? 0}
              tone={(tasks.data?.items.length ?? 0) > 0 ? 'warning' : 'neutral'}
            />
          </PanelBody>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Panel>
          <PanelHeader
            title="Waiting"
            description="In queue order. Drag on the queue board to re-prioritise."
            actions={
              <>
                <Button size="sm" variant="secondary" asChild>
                  <Link href="/patients">
                    <UserPlus aria-hidden />
                    Register
                  </Link>
                </Button>
                <Button size="sm" variant="primary" asChild>
                  <Link href="/queue">Open queue</Link>
                </Button>
              </>
            }
          />
          {queue.isLoading ? (
            <SkeletonRows rows={4} />
          ) : waiting.length === 0 ? (
            <EmptyState
              icon={Users}
              title="Nobody is waiting"
              description="Walk-ins you add will appear here straight away."
            />
          ) : (
            <ul className="divide-y divide-line-soft">
              {waiting.map((entry) => (
                <li key={entry.appointment.id}>
                  <Link
                    href={`/patients/${entry.patient.id}`}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-sunk"
                  >
                    <span className="w-8 shrink-0 text-center text-sm font-semibold tabular text-ink-faint">
                      {waiting.indexOf(entry) + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink">
                          {entry.patient.fullName}
                        </span>
                        {entry.patient.hasHighCriticalityAllergy ? (
                          <Badge tone="critical">
                            <AlertTriangle aria-hidden />
                            Allergy
                          </Badge>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-2xs text-ink-faint">
                        {ageGender(entry.patient)} · {entry.appointment.reasonText ?? 'No reason given'}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-sm tabular text-ink">
                        {formatMinutes(entry.waitingMinutes)}
                      </span>
                      <span className="block text-2xs text-ink-faint">
                        {entry.practitionerName ?? 'Unassigned'}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <TaskPanel tasks={tasks.data?.items ?? []} loading={tasks.isLoading} />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------------- *
 * Doctor — a worklist. "Who is next", not "how did we do".
 * ------------------------------------------------------------------------- */

function DoctorHome() {
  const session = useSession();
  const queue = useQueue();
  const router = useRouter();
  const start = useStartConsultation();

  const mine = (queue.data?.waiting ?? []).filter(
    (entry) =>
      entry.appointment.practitionerId === session.userId ||
      entry.appointment.practitionerId === null,
  );
  const next = mine[0];
  const drafts = mine.filter((entry) => entry.encounterId !== null);

  const open = async (patientId: string, appointmentId: string) => {
    const encounter = await start.mutateAsync({ patientId, appointmentId });
    router.push(`/encounters/${encounter.id}`);
  };

  return (
    <>
      {next ? (
        <Panel className="border-accent/40 bg-accent-soft/40">
          <PanelBody className="flex flex-wrap items-center gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-2xs font-semibold uppercase tracking-wide text-accent-ink">
                Next patient
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-ink">
                  {next.patient.fullName}
                </h2>
                <span className="text-sm text-ink-soft">{ageGender(next.patient)}</span>
                {next.patient.hasHighCriticalityAllergy ? (
                  <Badge tone="alarm">
                    <AlertTriangle aria-hidden />
                    Allergy on file
                  </Badge>
                ) : null}
              </div>
              <p className="mt-1 text-sm text-ink-soft">
                {next.appointment.reasonText ?? 'No reason recorded'} · waiting{' '}
                {formatMinutes(next.waitingMinutes)}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="secondary" asChild>
                <Link href={`/patients/${next.patient.id}`}>Open record</Link>
              </Button>
              <Button
                variant="primary"
                loading={start.isPending}
                onClick={() => open(next.patient.id, next.appointment.id)}
              >
                <Stethoscope aria-hidden />
                Start consultation
              </Button>
            </div>
          </PanelBody>
        </Panel>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Panel>
          <PanelHeader
            title="My patients today"
            description={`${mine.length} waiting`}
            actions={
              <Button size="sm" variant="secondary" asChild>
                <Link href="/queue">Full queue</Link>
              </Button>
            }
          />
          {queue.isLoading ? (
            <SkeletonRows rows={4} />
          ) : mine.length === 0 ? (
            <EmptyState
              icon={Stethoscope}
              title="No one is waiting for you"
              description="Patients added to the queue will appear here."
            />
          ) : (
            <ul className="divide-y divide-line-soft">
              {mine.map((entry, index) => (
                <li
                  key={entry.appointment.id}
                  className="flex items-center gap-3 px-4 py-2.5"
                >
                  <span className="w-6 shrink-0 text-center text-sm font-semibold tabular text-ink-faint">
                    {index + 1}
                  </span>
                  <Link
                    href={`/patients/${entry.patient.id}`}
                    className="min-w-0 flex-1 hover:underline"
                  >
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-ink">
                        {entry.patient.fullName}
                      </span>
                      {entry.patient.hasHighCriticalityAllergy ? (
                        <Badge tone="critical">
                          <AlertTriangle aria-hidden />
                          Allergy
                        </Badge>
                      ) : null}
                      {entry.encounterId ? <Badge tone="warning">Draft open</Badge> : null}
                    </span>
                    <span className="mt-0.5 block truncate text-2xs text-ink-faint">
                      {ageGender(entry.patient)} ·{' '}
                      {entry.appointment.reasonText ?? 'No reason given'} · waiting{' '}
                      {formatMinutes(entry.waitingMinutes)}
                    </span>
                  </Link>
                  <Button
                    size="sm"
                    variant={entry.encounterId ? 'secondary' : 'primary'}
                    onClick={() => open(entry.patient.id, entry.appointment.id)}
                  >
                    {entry.encounterId ? 'Resume' : 'Start'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <div className="flex flex-col gap-4">
          {drafts.length > 0 ? (
            <Panel className="border-warning-line">
              <PanelHeader
                title="Unfinished consultations"
                description="These are saved but not signed. Nothing has been sent to the patient."
              />
              <ul className="divide-y divide-line-soft">
                {drafts.map((entry) => (
                  <li key={entry.appointment.id} className="px-4 py-2.5">
                    <Link
                      href={`/encounters/${entry.encounterId}`}
                      className="text-sm font-medium text-ink hover:underline"
                    >
                      {entry.patient.fullName}
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}
          <DoctorTaskPanel />
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------------- *
 * Nurse — a prep list. Vitals and allergy gaps, nothing else.
 * ------------------------------------------------------------------------- */

function NurseHome() {
  const queue = useQueue();
  const waiting = queue.data?.waiting ?? [];

  return (
    <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
      <Panel>
        <PanelHeader
          title="Waiting for vitals"
          description="Record observations before the doctor calls the patient."
        />
        {queue.isLoading ? (
          <SkeletonRows rows={4} />
        ) : waiting.length === 0 ? (
          <EmptyState icon={Thermometer} title="Nobody is waiting" />
        ) : (
          <ul className="divide-y divide-line-soft">
            {waiting.map((entry) => (
              <li key={entry.appointment.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">
                      {entry.patient.fullName}
                    </span>
                    {entry.patient.hasHighCriticalityAllergy ? (
                      <Badge tone="critical">
                        <AlertTriangle aria-hidden />
                        Allergy
                      </Badge>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-2xs text-ink-faint">
                    {ageGender(entry.patient)} · waiting{' '}
                    {formatMinutes(entry.waitingMinutes)}
                  </span>
                </span>
                <Button size="sm" variant="primary" asChild>
                  <Link href={`/patients/${entry.patient.id}`}>Record vitals</Link>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <DoctorTaskPanel />
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * Clinic Admin — the one genuine dashboard
 * ------------------------------------------------------------------------- */

function ClinicAdminHome() {
  const { data, isLoading } = useQuery({
    queryKey: qk.reports('today', 'today'),
    queryFn: () => api.get<ReportSummary>('/reports/summary'),
  });

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Panel>
          <PanelBody>
            <Stat label="Visits, 14 days" value={isLoading ? '—' : data?.visits ?? 0} />
          </PanelBody>
        </Panel>
        <Panel>
          <PanelBody>
            <Stat
              label="Collected"
              value={isLoading ? '—' : formatPaiseShort(data?.collectionsPaise ?? 0)}
            />
          </PanelBody>
        </Panel>
        <Panel>
          <PanelBody>
            <Stat
              label="Outstanding"
              value={isLoading ? '—' : formatPaiseShort(data?.outstandingPaise ?? 0)}
              tone={(data?.outstandingPaise ?? 0) > 0 ? 'warning' : 'neutral'}
            />
          </PanelBody>
        </Panel>
        <Panel>
          <PanelBody>
            <Stat
              label="No-shows"
              value={isLoading ? '—' : data?.noShows ?? 0}
              hint="Last 14 days"
            />
          </PanelBody>
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Panel>
          <PanelHeader
            title="Visits and collections"
            description="Last 14 days"
            actions={
              <Button size="sm" variant="secondary" asChild>
                <Link href="/reports">
                  <Activity aria-hidden />
                  All reports
                </Link>
              </Button>
            }
          />
          <PanelBody>
            {isLoading ? (
              <SkeletonRows rows={3} />
            ) : (
              <MiniChart series={data?.series ?? []} />
            )}
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="By doctor" description="Visits in the period" />
          <ul className="divide-y divide-line-soft">
            {(data?.byPractitioner ?? []).map((row) => (
              <li
                key={row.practitionerId}
                className="flex items-center justify-between gap-3 px-4 py-2.5"
              >
                <span className="truncate text-sm text-ink">{row.practitionerName}</span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-medium tabular text-ink">
                    {row.visits}
                  </span>
                  <span className="block text-2xs tabular text-ink-faint">
                    {formatPaiseShort(row.collectionsPaise)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <QuickLink href="/inbox" icon={Inbox} label="Patient inbox" />
        <QuickLink href="/billing" icon={Banknote} label="Billing" />
        <QuickLink href="/settings/users" icon={Users} label="Staff and roles" />
      </div>
    </>
  );
}

/**
 * A 14-day series drawn as bars.
 *
 * Every bar is labelled by its date on the axis and its value in the tooltip,
 * and the tallest bar is emphasised — a chart that shows shape but no values is
 * decoration.
 */
function MiniChart({
  series,
}: {
  series: { date: string; visits: number; collectionsPaise: number }[];
}) {
  if (series.length === 0) return null;
  const max = Math.max(...series.map((d) => d.visits), 1);

  return (
    <div>
      <div className="flex h-32 items-end gap-1" role="img" aria-label="Visits per day over the last 14 days">
        {series.map((point) => {
          const height = Math.round((point.visits / max) * 100);
          const peak = point.visits === max;
          return (
            <div key={point.date} className="group flex flex-1 flex-col items-center gap-1">
              <span className="text-2xs tabular text-ink-faint opacity-0 transition-opacity group-hover:opacity-100">
                {point.visits}
              </span>
              <div
                className={peak ? 'w-full rounded-t-xs bg-accent' : 'w-full rounded-t-xs bg-accent/35'}
                style={{ height: `${Math.max(height, 4)}%` }}
                title={`${point.visits} visits on ${point.date}`}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-2xs tabular text-ink-faint">
        <span>{series[0]?.date.slice(5)}</span>
        <span>Peak {max} visits</span>
        <span>{series.at(-1)?.date.slice(5)}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * Shared pieces
 * ------------------------------------------------------------------------- */

function useOpenTasks() {
  return useQuery({
    queryKey: qk.tasks('open'),
    queryFn: () => api.get<{ items: Task[] }>('/tasks', { query: { filter: 'open' } }),
    refetchInterval: 60_000,
  });
}

function DoctorTaskPanel() {
  const tasks = useOpenTasks();
  return <TaskPanel tasks={tasks.data?.items ?? []} loading={tasks.isLoading} />;
}

function TaskPanel({ tasks, loading }: { tasks: Task[]; loading: boolean }) {
  return (
    <Panel>
      <PanelHeader
        title="Needs attention"
        description="Undelivered messages, duplicate reviews and follow-ups"
        actions={
          <Button size="sm" variant="secondary" asChild>
            <Link href="/tasks">All tasks</Link>
          </Button>
        }
      />
      {loading ? (
        <SkeletonRows rows={3} />
      ) : tasks.length === 0 ? (
        <EmptyState icon={ClipboardList} title="Nothing needs attention" />
      ) : (
        <ul className="divide-y divide-line-soft">
          {tasks.slice(0, 5).map((task) => (
            <li key={task.id} className="px-4 py-2.5">
              <Link href="/tasks" className="block hover:underline">
                <span className="flex items-start gap-2">
                  {task.priority !== 'ROUTINE' ? (
                    <Badge tone="warning">{task.priority.toLowerCase()}</Badge>
                  ) : null}
                  <span className="min-w-0 flex-1 text-sm text-ink">{task.title}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function QuickLink({
  href,
  icon: Icon,
  label,
}: {
  href: Route;
  icon: typeof Inbox;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 shadow-raise transition-colors hover:bg-surface-sunk"
    >
      <Icon className="size-4 shrink-0 text-accent" aria-hidden />
      <span className="text-sm font-medium text-ink">{label}</span>
    </Link>
  );
}
