'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, CalendarPlus, LogIn } from 'lucide-react';
import {
  ALLOWED_STATUS_TRANSITIONS,
  APPOINTMENT_STATUS_LABEL,
  canTransitionAppointment,
  type Appointment,
  type PatientSummary,
} from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { useChangeAppointmentStatus, useCheckIn } from '@/features/queue/api';
import { useCan } from '@/lib/session';
import { ageGender, formatTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { APPOINTMENT_STATUS_TONE } from '@/lib/appointment-status';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { Panel, PanelHeader, PageHeader } from '@/components/ui/surface';
import { EmptyState, SkeletonRows } from '@/components/ui/feedback';

interface Row {
  appointment: Appointment;
  patient: PatientSummary;
  practitionerName: string | null;
}


/**
 * The appointment calendar.
 *
 * Booked appointments only — walk-ins live on the queue, because they are a
 * different workflow even though they share the same record underneath.
 */
export default function AppointmentsPage() {
  const canManage = useCan('appointment:update');
  const canBook = useCan('appointment:create');
  const changeStatus = useChangeAppointmentStatus();
  const checkIn = useCheckIn();

  const { data, isLoading } = useQuery({
    queryKey: qk.appointments('today', 'today'),
    queryFn: () => api.get<{ items: Row[] }>('/appointments'),
  });

  const rows = (data?.items ?? []).sort((a, b) =>
    a.appointment.scheduledStart.localeCompare(b.appointment.scheduledStart),
  );

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <PageHeader
        title="Appointments"
        description="Today's booked appointments. Walk-ins are on the queue."
        actions={
          canBook ? (
            <Button variant="primary" asChild>
              <Link href="/appointments/new">
                <CalendarPlus aria-hidden />
                Book appointment
              </Link>
            </Button>
          ) : null
        }
      />

      <Panel>
        <PanelHeader title="Today" description={`${rows.length} appointments`} />
        {isLoading ? (
          <SkeletonRows rows={5} />
        ) : rows.length === 0 ? (
          <EmptyState icon={CalendarDays} title="Nothing booked today" />
        ) : (
          <ul className="divide-y divide-line-soft">
            {rows.map((row) => (
              <li
                key={row.appointment.id}
                className="flex flex-wrap items-center gap-3 px-4 py-3"
              >
                <span className="w-16 shrink-0 text-sm font-medium tabular text-ink">
                  {formatTime(row.appointment.scheduledStart)}
                </span>

                <span className="min-w-0 flex-1">
                  <Link
                    href={`/patients/${row.patient.id}`}
                    className="text-sm font-medium text-ink hover:underline"
                  >
                    {row.patient.fullName}
                  </Link>
                  <span className="ml-2 text-sm text-ink-soft">
                    {ageGender(row.patient)}
                  </span>
                  <span className="mt-0.5 block truncate text-2xs text-ink-faint">
                    {row.appointment.reasonText ?? 'No reason given'}
                    {row.practitionerName ? ` · ${row.practitionerName}` : ''}
                  </span>
                </span>

                {canManage ? (
                  <div className="flex shrink-0 items-center gap-2">
                    {/*
                      CHECK IN IS A BUTTON, not an option buried in a dropdown.
                      It is the single most frequent action at a front desk — it
                      happens once per patient per day — and making somebody open
                      a select and find the right word for it is how a queue of
                      people forms at the counter.
                    */}
                    {canTransitionAppointment(row.appointment.status, 'ARRIVED') ? (
                      <Button
                        size="sm"
                        variant="primary"
                        loading={checkIn.isPending}
                        onClick={() => checkIn.mutate(row.appointment.id)}
                      >
                        <LogIn aria-hidden />
                        Check in
                      </Button>
                    ) : null}

                    {/*
                      The rest of the moves, and ONLY the legal ones.
                      This previously listed every status in the enum, so reception
                      could send a scheduled appointment straight to "Completed"
                      with nobody seen. The server refuses that now — which would
                      have turned a silently wrong action into a visible error,
                      which is better but still a screen offering what cannot work.
                    */}
                    {ALLOWED_STATUS_TRANSITIONS[row.appointment.status].length > 0 ? (
                      <Select
                        className="w-36"
                        aria-label={`Move ${row.patient.fullName} to another status`}
                        value=""
                        onChange={(event) => {
                          if (!event.target.value) return;
                          changeStatus.mutate({
                            appointmentId: row.appointment.id,
                            status: event.target.value as Appointment['status'],
                          });
                        }}
                      >
                        <option value="">
                          {APPOINTMENT_STATUS_LABEL[row.appointment.status]}…
                        </option>
                        {ALLOWED_STATUS_TRANSITIONS[row.appointment.status].map((value) => (
                          <option key={value} value={value}>
                            {APPOINTMENT_STATUS_LABEL[value]}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Badge tone={APPOINTMENT_STATUS_TONE[row.appointment.status]}>
                        {APPOINTMENT_STATUS_LABEL[row.appointment.status]}
                      </Badge>
                    )}
                  </div>
                ) : (
                  <Badge tone={APPOINTMENT_STATUS_TONE[row.appointment.status]}>
                    {APPOINTMENT_STATUS_LABEL[row.appointment.status]}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
