'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Stethoscope,
  UserPlus,
  UserX,
  Users,
} from 'lucide-react';
import type { QueueEntry } from '@emr/contracts';
import {
  useChangeAppointmentStatus,
  useQueue,
  useReorderQueue,
  useStartConsultation,
} from '@/features/queue/api';
import { AddWalkInDialog } from '@/features/queue/add-walk-in-dialog';
import { useCan } from '@/lib/session';
import { ageGender, formatMinutes, formatTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel, PanelHeader, PageHeader } from '@/components/ui/surface';
import { EmptyState, SkeletonRows } from '@/components/ui/feedback';

/**
 * The live queue.
 *
 * The board the front desk lives on. Three things it has to get right:
 *
 *   - RE-PRIORITISING TAKES ONE GESTURE. No edit screen, no dialog. An elderly
 *     patient who arrives unwell has to move above someone in a single action,
 *     because that is a conversation happening at the counter right now.
 *   - THE POSITION IS OBVIOUS AT A GLANCE. Patients ask "how long?" constantly.
 *   - TWO SCREENS AGREE. The doctor's view reflects a front-desk reorder within
 *     a couple of seconds without anyone refreshing.
 *
 * Reordering moves the row immediately and reconciles afterwards. If the server
 * rejects it, the row snaps back — visible failure beats a silent one.
 */
export default function QueuePage() {
  const { data, isLoading } = useQueue();
  const reorder = useReorderQueue();
  const changeStatus = useChangeAppointmentStatus();
  const startConsultation = useStartConsultation();
  const router = useRouter();

  const canManage = useCan('appointment:update');
  const canConsult = useCan('encounter:create');
  const canAddWalkIn = useCan('appointment:create');

  const [walkInOpen, setWalkInOpen] = React.useState(false);

  const waiting = data?.waiting ?? [];
  const completed = data?.completed ?? [];

  const moveUp = (index: number) => {
    const entry = waiting[index];
    const target = waiting[index - 1];
    if (!entry || !target) return;
    reorder.mutate({
      appointmentId: entry.appointment.id,
      beforeAppointmentId: target.appointment.id,
    });
  };

  const moveDown = (index: number) => {
    const entry = waiting[index];
    const target = waiting[index + 2] ?? null;
    if (!entry) return;
    reorder.mutate({
      appointmentId: entry.appointment.id,
      beforeAppointmentId: target?.appointment.id ?? null,
    });
  };

  const consult = async (entry: QueueEntry) => {
    const encounter = await startConsultation.mutateAsync({
      patientId: entry.patient.id,
      appointmentId: entry.appointment.id,
    });
    router.push(`/encounters/${encounter.id}`);
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <PageHeader
        title="Today's queue"
        description={`${waiting.length} waiting · ${completed.length} seen`}
        actions={
          canAddWalkIn ? (
            <Button variant="primary" onClick={() => setWalkInOpen(true)}>
              <UserPlus aria-hidden />
              Add walk-in
            </Button>
          ) : null
        }
      />

      <Panel>
        <PanelHeader
          title="Waiting"
          description="In the order they will be seen. Use the arrows to re-prioritise."
        />
        {isLoading ? (
          <SkeletonRows rows={4} />
        ) : waiting.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Nobody is waiting"
            description="Add a walk-in, or check the appointments calendar."
          />
        ) : (
          <ul className="divide-y divide-line-soft">
            {waiting.map((entry, index) => {
              const inConsultation = entry.appointment.status === 'IN_PROGRESS';

              return (
                <li
                  key={entry.appointment.id}
                  className={
                    inConsultation
                      ? 'flex flex-wrap items-center gap-3 bg-accent-soft/40 px-3 py-3'
                      : 'flex flex-wrap items-center gap-3 px-3 py-3'
                  }
                >
                  {/* Position — the number the patient is told. */}
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-sunk text-sm font-bold tabular text-ink">
                    {index + 1}
                  </span>

                  {canManage ? (
                    <span className="flex shrink-0 flex-col">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6"
                        disabled={index === 0}
                        onClick={() => moveUp(index)}
                        aria-label={`Move ${entry.patient.fullName} up`}
                      >
                        <ArrowUp aria-hidden />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6"
                        disabled={index === waiting.length - 1}
                        onClick={() => moveDown(index)}
                        aria-label={`Move ${entry.patient.fullName} down`}
                      >
                        <ArrowDown aria-hidden />
                      </Button>
                    </span>
                  ) : null}

                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/patients/${entry.patient.id}`}
                        className="text-sm font-semibold text-ink hover:underline"
                      >
                        {entry.patient.fullName}
                      </Link>
                      <span className="text-sm text-ink-soft">
                        {ageGender(entry.patient)}
                      </span>
                      {entry.patient.hasHighCriticalityAllergy ? (
                        <Badge tone="critical">
                          <AlertTriangle aria-hidden />
                          Allergy
                        </Badge>
                      ) : null}
                      {inConsultation ? (
                        <Badge tone="accent">In consultation</Badge>
                      ) : null}
                      {entry.appointment.isWalkIn ? (
                        <Badge tone="neutral">Walk-in</Badge>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block truncate text-2xs text-ink-faint">
                      {entry.appointment.reasonText ?? 'No reason given'}
                      {entry.practitionerName ? ` · ${entry.practitionerName}` : ''}
                    </span>
                  </span>

                  <span className="shrink-0 text-right">
                    <span className="block text-sm font-medium tabular text-ink">
                      {formatMinutes(entry.waitingMinutes)}
                    </span>
                    <span className="block text-2xs text-ink-faint">
                      since {formatTime(entry.appointment.arrivedAt)}
                    </span>
                  </span>

                  <span className="flex shrink-0 gap-1.5">
                    {canConsult ? (
                      <Button
                        size="sm"
                        variant={inConsultation ? 'secondary' : 'primary'}
                        onClick={() => consult(entry)}
                      >
                        <Stethoscope aria-hidden />
                        {entry.encounterId ? 'Resume' : 'See now'}
                      </Button>
                    ) : null}
                    {canManage ? (
                      <>
                        <Button
                          size="icon"
                          variant="ghost"
                          title="Mark as seen"
                          aria-label={`Mark ${entry.patient.fullName} as seen`}
                          onClick={() =>
                            changeStatus.mutate({
                              appointmentId: entry.appointment.id,
                              status: 'FULFILLED',
                            })
                          }
                        >
                          <Check aria-hidden />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          title="Did not attend"
                          aria-label={`Mark ${entry.patient.fullName} as no-show`}
                          onClick={() =>
                            changeStatus.mutate({
                              appointmentId: entry.appointment.id,
                              status: 'NOSHOW',
                            })
                          }
                        >
                          <UserX aria-hidden />
                        </Button>
                      </>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {completed.length > 0 ? (
        <Panel>
          <PanelHeader title="Seen today" description={`${completed.length} completed`} />
          <ul className="divide-y divide-line-soft">
            {completed.map((entry) => (
              <li
                key={entry.appointment.id}
                className="flex items-center gap-3 px-4 py-2 text-ink-faint"
              >
                <Check className="size-3.5 shrink-0 text-positive" aria-hidden />
                <Link
                  href={`/patients/${entry.patient.id}`}
                  className="min-w-0 flex-1 truncate text-sm hover:underline"
                >
                  {entry.patient.fullName}
                </Link>
                <span className="shrink-0 text-2xs">
                  {formatTime(entry.appointment.completedAt)}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <AddWalkInDialog open={walkInOpen} onOpenChange={setWalkInOpen} />
    </div>
  );
}
