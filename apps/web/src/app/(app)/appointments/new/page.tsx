'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CalendarPlus, Search } from 'lucide-react';
import type { PatientSummary, ServiceItem, StaffUser } from '@emr/contracts';
import { api, idempotencyKey } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { ageGender, formatPhone } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Panel, PanelBody, PageHeader } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';

/**
 * Booking an appointment.
 *
 * The chosen service sets the slot length, so a new consultation books a longer
 * slot than a follow-up without anyone having to remember the difference.
 */
export default function NewAppointmentPage() {
  const router = useRouter();
  const toast = useToast();

  const [term, setTerm] = React.useState('');
  const [patient, setPatient] = React.useState<PatientSummary | null>(null);
  const [practitionerId, setPractitionerId] = React.useState('');
  const [serviceItemId, setServiceItemId] = React.useState('');
  const [start, setStart] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  const { data: results } = useQuery({
    queryKey: qk.patients(term.trim()),
    queryFn: () =>
      api.get<{ items: PatientSummary[] }>('/patients/search', {
        query: { q: term.trim(), limit: 6 },
      }),
    enabled: term.trim().length >= 2 && !patient,
  });

  const { data: staff } = useQuery({
    queryKey: qk.staff,
    queryFn: () => api.get<{ items: StaffUser[] }>('/users'),
  });

  const { data: services } = useQuery({
    queryKey: qk.services,
    queryFn: () =>
      api.get<{ items: ServiceItem[] }>('/services').catch(() => ({ items: [] })),
  });

  const doctors = (staff?.items ?? []).filter((s) => s.role === 'DOCTOR' && s.isActive);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!patient || !start) return;
    setSaving(true);
    try {
      await api.post(
        '/appointments',
        {
          patientId: patient.id,
          practitionerId: practitionerId || null,
          serviceItemId: serviceItemId || null,
          scheduledStart: new Date(start).toISOString(),
          reasonText: reason.trim() || null,
        },
        { idempotencyKey: idempotencyKey() },
      );
      toast.success('Appointment booked', `${patient.fullName} is on the calendar.`);
      router.push('/appointments');
    } catch {
      toast.error('Could not book', 'Try again in a moment.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <Link
        href="/appointments"
        className="inline-flex w-fit items-center gap-1.5 text-xs text-ink-faint hover:text-ink"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Appointments
      </Link>

      <PageHeader title="Book an appointment" />

      <form onSubmit={submit}>
        <Panel>
          <PanelBody className="flex flex-col gap-4">
            {patient ? (
              <div className="flex items-center gap-3 rounded-md border border-accent/40 bg-accent-soft/40 p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink">{patient.fullName}</p>
                  <p className="text-2xs text-ink-faint">
                    {ageGender(patient)} ·{' '}
                    <span className="token">{formatPhone(patient.mobileE164)}</span>
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setPatient(null)}>
                  Change
                </Button>
              </div>
            ) : (
              <div>
                <Field label="Patient" htmlFor="appt-patient" required>
                  <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5">
                    <Search className="size-4 shrink-0 text-ink-faint" aria-hidden />
                    <Input
                      id="appt-patient"
                      autoFocus
                      value={term}
                      onChange={(event) => setTerm(event.target.value)}
                      placeholder="Mobile number or name"
                      className="h-9 border-0 px-0 focus-visible:ring-0"
                    />
                  </div>
                </Field>
                {term.trim().length >= 2 ? (
                  <ul className="mt-2 max-h-48 overflow-y-auto scroll-thin rounded-md border border-line">
                    {(results?.items ?? []).map((row) => (
                      <li key={row.id}>
                        <button
                          type="button"
                          onClick={() => setPatient(row)}
                          className="w-full px-3 py-2 text-left text-sm hover:bg-surface-sunk"
                        >
                          {row.fullName}
                          <span className="ml-2 text-2xs text-ink-faint">
                            {ageGender(row)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Doctor" htmlFor="appt-doctor">
                <Select
                  id="appt-doctor"
                  value={practitionerId}
                  onChange={(event) => setPractitionerId(event.target.value)}
                >
                  <option value="">Any available</option>
                  {doctors.map((doctor) => (
                    <option key={doctor.id} value={doctor.id}>
                      {doctor.fullName}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="Service"
                htmlFor="appt-service"
                hint="Sets how long the slot is."
              >
                <Select
                  id="appt-service"
                  value={serviceItemId}
                  onChange={(event) => setServiceItemId(event.target.value)}
                >
                  <option value="">Standard consultation</option>
                  {(services?.items ?? []).map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field label="Date and time" htmlFor="appt-start" required>
              <Input
                id="appt-start"
                type="datetime-local"
                value={start}
                onChange={(event) => setStart(event.target.value)}
              />
            </Field>

            <Field label="Reason" htmlFor="appt-reason">
              <Input
                id="appt-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. Follow-up for blood pressure"
              />
            </Field>
          </PanelBody>
        </Panel>

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" asChild>
            <Link href="/appointments">Cancel</Link>
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={saving}
            disabled={!patient || !start}
          >
            <CalendarPlus aria-hidden />
            Book
          </Button>
        </div>
      </form>
    </div>
  );
}
