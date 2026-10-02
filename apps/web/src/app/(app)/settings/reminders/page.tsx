'use client';

import * as React from 'react';
import {
  REMINDER_KIND_LABEL,
  REMINDER_STATUS_LABEL,
  type ReminderStatus,
} from '@emr/contracts';
import { cn } from '@/lib/cn';
import { useCan } from '@/lib/session';
import { formatDateTime, formatPhone, relativeTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Panel, PanelBody, PanelHeader, PageHeader } from '@/components/ui/surface';
import { Alert, EmptyState, Skeleton } from '@/components/ui/feedback';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import {
  useCancelReminder,
  useReminderLog,
  useReminderSettings,
  useSaveReminderSettings,
} from '@/features/reminders/api';

/**
 * Follow-up reminders.
 *
 * Settings and the log on one screen, because the only question anybody brings
 * here is "did it go out, and if not why" — and that is answered by the two
 * together. A settings page that could not show the consequence of its own
 * switches is how the previous reminder screen ended up reporting "Reminder
 * settings saved" while making no request at all.
 *
 * THERE IS NO SEND BUTTON. Reminders go out when they are due; the endpoint that
 * sends them is authenticated with a deployment secret for a cron line. A button
 * that fired them early would be pressed to test, and the test would reach a
 * real patient.
 */
export default function RemindersSettingsPage() {
  const toast = useToast();
  const canEdit = useCan('clinic:update');

  const settings = useReminderSettings();
  const save = useSaveReminderSettings();
  const log = useReminderLog();
  const cancel = useCancelReminder();

  /*
   * Local form state, seeded once the settings arrive.
   *
   * Not bound straight to the query data: a checkbox that writes on every click
   * means a half-finished configuration — "copy to clinic" on, number not yet
   * typed — is saved and refused, and the refusal arrives as a toast about a
   * field the user had not got to.
   */
  const [form, setForm] = React.useState<{
    followUpEnabled: boolean;
    leadTimeDays: string;
    quietHoursStart: string;
    quietHoursEnd: string;
    notifyClinicNumber: boolean;
    clinicNotifyMobileE164: string;
  } | null>(null);

  React.useEffect(() => {
    if (!settings.data || form) return;
    setForm({
      followUpEnabled: settings.data.followUpEnabled,
      leadTimeDays: String(settings.data.leadTimeDays),
      quietHoursStart: String(settings.data.quietHoursStart),
      quietHoursEnd: String(settings.data.quietHoursEnd),
      notifyClinicNumber: settings.data.notifyClinicNumber,
      clinicNotifyMobileE164: settings.data.clinicNotifyMobileE164 ?? '',
    });
  }, [settings.data, form]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!form) return;

    save.mutate(
      {
        followUpEnabled: form.followUpEnabled,
        leadTimeDays: Number.parseInt(form.leadTimeDays, 10) || 0,
        quietHoursStart: Number.parseInt(form.quietHoursStart, 10) || 0,
        quietHoursEnd: Number.parseInt(form.quietHoursEnd, 10) || 0,
        notifyClinicNumber: form.notifyClinicNumber,
        clinicNotifyMobileE164: form.clinicNotifyMobileE164.trim() || null,
      },
      {
        onSuccess: () => toast.success('Reminder settings saved'),
        onError: () =>
          toast.error(
            'Could not save',
            'Check the number for the clinic copy — it needs a country code.',
          ),
      },
    );
  };

  if (settings.isLoading || !form) return <Skeleton className="h-96 w-full" />;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Follow-up reminders"
        description="When a consultation sets a follow-up, the patient can be reminded on WhatsApp before it."
      />

      {/*
        Said plainly rather than discovered. A clinic turning reminders on
        without an approved template gets a log full of failures and no idea why;
        the template name is the one thing they need to know up front.
      */}
      <Alert tone="info" title="What this needs before it will work">
        A connected WhatsApp number, and an approved template named{' '}
        <span className="token text-xs">follow_up_reminder</span> taking the
        patient&rsquo;s name and the date. Patients who have not consented to WhatsApp are
        skipped, not messaged.
      </Alert>

      <form onSubmit={submit}>
        <Panel>
          <PanelHeader title="Settings" />
          <PanelBody className="flex flex-col gap-4">
            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={form.followUpEnabled}
                onChange={(event) =>
                  setForm({ ...form, followUpEnabled: event.target.checked })
                }
                className="mt-0.5 size-4 accent-accent"
              />
              <span>
                Send follow-up reminders
                <span className="block text-2xs text-ink-faint">
                  Off by default. Nothing is scheduled until this is on, and turning it
                  off later leaves reminders already scheduled in place — cancel those
                  individually below.
                </span>
              </span>
            </label>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field
                label="Days before"
                htmlFor="leadTimeDays"
                hint="A reminder on the morning of is too late to rearrange a day around."
              >
                <Input
                  type="number"
                  min={0}
                  max={14}
                  disabled={!canEdit}
                  className="token"
                  value={form.leadTimeDays}
                  onChange={(event) =>
                    setForm({ ...form, leadTimeDays: event.target.value })
                  }
                />
              </Field>

              <Field
                label="Not before"
                htmlFor="quietHoursStart"
                hint="Clinic time. Reminders due earlier wait for this hour."
              >
                <Select
                  disabled={!canEdit}
                  value={form.quietHoursStart}
                  onChange={(event) =>
                    setForm({ ...form, quietHoursStart: event.target.value })
                  }
                >
                  {HOURS.map((hour) => (
                    <option key={hour.value} value={hour.value}>
                      {hour.label}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Not after" htmlFor="quietHoursEnd" hint="Clinic time.">
                <Select
                  disabled={!canEdit}
                  value={form.quietHoursEnd}
                  onChange={(event) =>
                    setForm({ ...form, quietHoursEnd: event.target.value })
                  }
                >
                  {HOURS.map((hour) => (
                    <option key={hour.value} value={hour.value}>
                      {hour.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {/*
              Quiet hours are not politeness. A WhatsApp business number that
              messages people at 3am collects "report business" taps, and Meta's
              quality rating decides whether the clinic's messages are delivered
              at all.
            */}
            <p className="text-2xs text-ink-faint">
              Quiet hours protect the clinic&rsquo;s number: messages sent at
              unsociable hours get reported, and a reported number stops being
              delivered.
            </p>

            <div className="border-t border-line-soft pt-4">
              <label className="flex items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={form.notifyClinicNumber}
                  onChange={(event) =>
                    setForm({ ...form, notifyClinicNumber: event.target.checked })
                  }
                  className="mt-0.5 size-4 accent-accent"
                />
                <span>
                  Send a copy to the clinic
                  <span className="block text-2xs text-ink-faint">
                    Off by default. A clinic copied on every patient reminder has a
                    phone it cannot use — and the patient&rsquo;s name and follow-up
                    date leave the record to a second number, which is recorded in the
                    activity log.
                  </span>
                </span>
              </label>

              {form.notifyClinicNumber ? (
                <Field
                  className="mt-3 max-w-xs"
                  label="Copy goes to"
                  htmlFor="clinicNotifyMobileE164"
                  hint="With the country code, e.g. +919876543210"
                >
                  <Input
                    disabled={!canEdit}
                    className="token"
                    placeholder="+919876543210"
                    value={form.clinicNotifyMobileE164}
                    onChange={(event) =>
                      setForm({ ...form, clinicNotifyMobileE164: event.target.value })
                    }
                  />
                </Field>
              ) : null}
            </div>
          </PanelBody>

          {canEdit ? (
            <div className="flex justify-end border-t border-line-soft p-4">
              <Button type="submit" variant="primary" loading={save.isPending}>
                Save settings
              </Button>
            </div>
          ) : null}
        </Panel>
      </form>

      <Panel>
        <PanelHeader
          title="Reminder log"
          description="What was scheduled, and what became of it."
        />
        {log.isLoading ? (
          <div className="p-4">
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (log.data ?? []).length === 0 ? (
          <EmptyState
            title="No reminders yet"
            description="A reminder is scheduled when a consultation with a follow-up is signed."
          />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Patient</TH>
                <TH>Due</TH>
                <TH>Status</TH>
                <TH>Why</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {(log.data ?? []).map((reminder) => (
                <TR key={reminder.id}>
                  <TD>
                    <span className="text-sm text-ink">{reminder.patientName}</span>
                    <span className="block text-2xs text-ink-faint">
                      {REMINDER_KIND_LABEL[reminder.kind]}
                      {reminder.patientMobile
                        ? ` · ${formatPhone(reminder.patientMobile)}`
                        : ' · no mobile on record'}
                    </span>
                  </TD>
                  <TD>
                    <span className="text-sm tabular text-ink">
                      {formatDateTime(reminder.dueAt)}
                    </span>
                    {reminder.sentAt ? (
                      <span className="block text-2xs text-ink-faint">
                        sent {relativeTime(reminder.sentAt)}
                      </span>
                    ) : null}
                  </TD>
                  <TD>
                    <Badge tone={STATUS_TONE[reminder.status]}>
                      {REMINDER_STATUS_LABEL[reminder.status]}
                    </Badge>
                    {reminder.attempts > 1 ? (
                      <span className="block text-2xs text-ink-faint">
                        {reminder.attempts} attempts
                      </span>
                    ) : null}
                  </TD>
                  <TD>
                    {/*
                      The reason is on the row, because the question is always
                      asked about one patient — "why didn't Mrs Rao get hers" —
                      and an answer that needs a log file is an answer nobody
                      gets.
                    */}
                    <span
                      className={cn(
                        'text-2xs',
                        reminder.status === 'FAILED' ? 'text-critical' : 'text-ink-faint',
                      )}
                    >
                      {reminder.lastError ?? '—'}
                    </span>
                  </TD>
                  <TD>
                    {reminder.status === 'PENDING' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={cancel.isPending}
                        onClick={() => cancel.mutate(reminder.id)}
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Panel>
    </div>
  );
}

/*
 * SKIPPED is not a failure and must not be coloured like one.
 *
 * A patient who never consented, or who has already booked, was correctly not
 * messaged. Painting that red would make a working system look broken and bury
 * the real failures in the noise.
 */
const STATUS_TONE: Record<ReminderStatus, 'neutral' | 'info' | 'positive' | 'warning' | 'critical'> =
  {
    PENDING: 'info',
    SENDING: 'info',
    SENT: 'positive',
    FAILED: 'critical',
    SKIPPED: 'neutral',
    CANCELLED: 'neutral',
  };

const HOURS = Array.from({ length: 24 }, (_, hour) => ({
  value: String(hour),
  label: `${hour % 12 === 0 ? 12 : hour % 12}${hour < 12 ? 'am' : 'pm'}`,
}));
