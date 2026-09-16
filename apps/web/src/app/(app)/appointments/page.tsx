'use client';

import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, CalendarPlus } from 'lucide-react';
import {
  APPOINTMENT_STATUS_LABEL,
  type Appointment,
  type PatientSummary,
} from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { useChangeAppointmentStatus } from '@/features/queue/api';
import { useCan } from '@/lib/session';
import { ageGender, formatTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { Panel, PanelHeader, PageHeader } from '@/components/ui/surface';
import { EmptyState, SkeletonRows } from '@/components/ui/feedback';

interface Row {
  appointment: Appointment;
  patient: PatientSummary;
  practitionerName: string | null;
}

const TONE: Record<string, 'neutral' | 'accent' | 'positive' | 'warning' | 'critical'> = {
  SCHEDULED: 'neutral',
  CONFIRMED: 'info' as never,
  ARRIVED: 'accent',
  IN_PROGRESS: 'accent',
  FULFILLED: 'positive',
  CANCELLED: 'neutral',
  NOSHOW: 'warning',
};

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
                  <Select
                    className="w-40 shrink-0"
                    aria-label={`Status for ${row.patient.fullName}`}
                    value={row.appointment.status}
                    onChange={(event) =>
                      changeStatus.mutate({
                        appointmentId: row.appointment.id,
                        status: event.target.value as Appointment['status'],
                      })
                    }
                  >
                    {Object.entries(APPOINTMENT_STATUS_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Badge tone={TONE[row.appointment.status] ?? 'neutral'}>
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
