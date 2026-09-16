'use client';

import * as React from 'react';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Field, Input, Select } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import { useCan } from '@/lib/session';

const RULES = [
  { key: 'APPOINTMENT_REMINDER', label: 'Appointment reminder', offset: '-24', on: true },
  { key: 'APPOINTMENT_CONFIRMATION', label: 'Booking confirmation', offset: '0', on: true },
  { key: 'FOLLOW_UP_DUE', label: 'Follow-up due', offset: '0', on: true },
  { key: 'MISSED_APPOINTMENT', label: 'Missed appointment', offset: '2', on: false },
];

/**
 * Reminder rules.
 *
 * Quiet hours are not a nicety. A reminder at 6am is how a clinic's number gets
 * reported, and a reported number gets suspended — taking prescription delivery
 * down with it.
 */
export default function RemindersSettingsPage() {
  const canEdit = useCan('communication:create');
  const toast = useToast();
  const [rules, setRules] = React.useState(RULES);
  const [quietStart, setQuietStart] = React.useState('21:00');
  const [quietEnd, setQuietEnd] = React.useState('08:00');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        toast.success('Reminder settings saved');
      }}
      className="flex flex-col gap-4"
    >
      <Panel>
        <PanelHeader
          title="Quiet hours"
          description="Nothing is sent between these times. Messages queue until the window opens."
        />
        <PanelBody className="grid gap-4 sm:grid-cols-2">
          <Field label="Stop sending at" htmlFor="quietStart">
            <Input
              id="quietStart"
              type="time"
              className="token"
              disabled={!canEdit}
              value={quietStart}
              onChange={(event) => setQuietStart(event.target.value)}
            />
          </Field>
          <Field label="Resume at" htmlFor="quietEnd">
            <Input
              id="quietEnd"
              type="time"
              className="token"
              disabled={!canEdit}
              value={quietEnd}
              onChange={(event) => setQuietEnd(event.target.value)}
            />
          </Field>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="What gets sent" />
        <ul className="divide-y divide-line-soft">
          {rules.map((rule, index) => (
            <li key={rule.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <label className="flex min-w-48 flex-1 items-center gap-2.5">
                <input
                  type="checkbox"
                  className="size-4 accent-accent"
                  checked={rule.on}
                  disabled={!canEdit}
                  onChange={(event) =>
                    setRules((current) =>
                      current.map((r, i) =>
                        i === index ? { ...r, on: event.target.checked } : r,
                      ),
                    )
                  }
                />
                <span className="text-sm text-ink">{rule.label}</span>
              </label>

              <Select
                className="w-44 shrink-0"
                aria-label={`When to send the ${rule.label}`}
                disabled={!canEdit || !rule.on}
                value={rule.offset}
                onChange={(event) =>
                  setRules((current) =>
                    current.map((r, i) =>
                      i === index ? { ...r, offset: event.target.value } : r,
                    ),
                  )
                }
              >
                <option value="-48">2 days before</option>
                <option value="-24">1 day before</option>
                <option value="-2">2 hours before</option>
                <option value="0">At the time</option>
                <option value="2">2 hours after</option>
              </Select>
            </li>
          ))}
        </ul>
      </Panel>

      <Alert tone="info" title="Patients who opt out are never messaged">
        An opt-out is honoured immediately and applies to everything, including
        prescriptions. Those fall back to print or a secure link.
      </Alert>

      {canEdit ? (
        <div className="flex justify-end">
          <Button type="submit" variant="primary">
            Save reminders
          </Button>
        </div>
      ) : null}
    </form>
  );
}
