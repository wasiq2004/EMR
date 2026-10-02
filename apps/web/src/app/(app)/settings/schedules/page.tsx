'use client';

import * as React from 'react';
import { CalendarClock, CalendarOff, Plus } from 'lucide-react';
import { WEEKDAYS, type PractitionerSchedule, type ScheduleException } from '@emr/contracts';
import {
  useRemoveException,
  useRemoveSchedule,
  useSaveException,
  useSaveSchedule,
  useScheduleExceptions,
  useSchedules,
} from '@/features/scheduling/api';
import { ApiError, api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { useCan } from '@/lib/session';
import { formatDate } from '@/lib/format';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { DataState } from '@/components/ui/data-state';
import { Alert } from '@/components/ui/feedback';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * When each doctor works.
 *
 * TWO LISTS, because a clinic's week is two different facts. The pattern is what
 * happens every week; the exceptions are the departures from it. Entering "Dr Rao
 * is off next Tuesday" as a change to the pattern would mean every future Tuesday
 * vanishes — which is the mistake this split exists to make impossible.
 *
 * A doctor working mornings and evenings has two sessions on that weekday, not one
 * with a lunch break inside it. Same information, no special case, and it is how a
 * clinic says it out loud.
 */
export default function SchedulesSettingsPage() {
  const canEdit = useCan('clinic:update');
  const canEditExceptions = useCan('appointment:update');

  const [editing, setEditing] = React.useState<PractitionerSchedule | 'new' | null>(null);
  const [excepting, setExcepting] = React.useState<ScheduleException | 'new' | null>(null);

  const schedules = useSchedules();

  /* Twelve weeks: far enough to plan leave, short enough to stay readable. */
  const from = React.useMemo(() => new Date().toISOString().slice(0, 10), []);
  const to = React.useMemo(
    () => new Date(Date.now() + 84 * 86_400_000).toISOString().slice(0, 10),
    [],
  );
  const exceptions = useScheduleExceptions(from, to);

  /* Grouped by doctor, because that is the unit somebody reasons about. */
  const byPractitioner = React.useMemo(() => {
    const map = new Map<string, { name: string; sessions: PractitionerSchedule[] }>();
    for (const row of schedules.data ?? []) {
      const entry = map.get(row.practitionerId) ?? {
        name: row.practitionerName,
        sessions: [],
      };
      entry.sessions.push(row);
      map.set(row.practitionerId, entry);
    }
    return [...map.entries()];
  }, [schedules.data]);

  return (
    <div className="flex flex-col gap-4">
      <Alert tone="info" title="This is what the calendar draws">
        Bookable slots are worked out from these sessions, minus anything below,
        minus what is already booked. Nothing is stored per slot — change a session
        and every future week changes with it.
      </Alert>

      <Panel>
        <PanelHeader
          title="Weekly sessions"
          description="What happens every week."
          actions={
            canEdit ? (
              <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
                <Plus aria-hidden />
                Add a session
              </Button>
            ) : null
          }
        />
        <PanelBody>
          <DataState
            query={schedules}
            empty={{
              icon: CalendarClock,
              title: 'No sessions yet',
              description:
                'Until a doctor has sessions, nothing is bookable and the calendar is empty.',
              action: canEdit ? (
                <Button variant="primary" onClick={() => setEditing('new')}>
                  Add a session
                </Button>
              ) : undefined,
            }}
          >
            {() => (
              <div className="space-y-4">
                {byPractitioner.map(([practitionerId, { name, sessions }]) => (
                  <div key={practitionerId}>
                    <p className="text-sm font-semibold text-ink">{name}</p>
                    <ul className="mt-1.5 space-y-1">
                      {sessions.map((session) => (
                        <li
                          key={session.id}
                          className="flex flex-wrap items-center gap-2 rounded-md border border-line px-2.5 py-1.5"
                        >
                          <Badge tone="accent">
                            {WEEKDAYS.find((d) => d.value === session.weekday)?.short}
                          </Badge>
                          <span className="tabular text-sm text-ink">
                            {session.startsAt.slice(0, 5)} – {session.endsAt.slice(0, 5)}
                          </span>
                          <span className="text-2xs text-ink-faint">
                            {session.slotMinutes}-minute slots
                            {session.capacityPerSlot > 1
                              ? ` · ${session.capacityPerSlot} per slot`
                              : ''}
                            {session.locationName ? ` · ${session.locationName}` : ''}
                          </span>
                          {!session.isActive ? <Badge>Inactive</Badge> : null}

                          {canEdit ? (
                            <span className="ml-auto flex gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setEditing(session)}
                              >
                                Edit
                              </Button>
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </DataState>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="Leave, holidays and extra sessions"
          description="The next twelve weeks. These override the pattern for one date."
          actions={
            canEditExceptions ? (
              <Button size="sm" variant="secondary" onClick={() => setExcepting('new')}>
                <Plus aria-hidden />
                Add an entry
              </Button>
            ) : null
          }
        />
        <PanelBody>
          <DataState
            query={exceptions}
            empty={{
              icon: CalendarOff,
              title: 'Nothing in the next twelve weeks',
              description: 'Add leave or a closure and the calendar stops offering those slots.',
            }}
            skeletonRows={3}
          >
            {(items) => (
              <ul className="space-y-1">
                {items.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-line px-2.5 py-1.5"
                  >
                    <Badge tone={entry.isAvailable ? 'positive' : 'critical'}>
                      {entry.isAvailable ? 'Working' : 'Closed'}
                    </Badge>
                    <span className="text-sm text-ink">{formatDate(entry.onDate)}</span>
                    <span className="text-xs text-ink-soft">
                      {entry.practitionerName ?? 'Whole clinic'}
                    </span>
                    {entry.isAvailable && entry.startsAt ? (
                      <span className="tabular text-2xs text-ink-faint">
                        {entry.startsAt.slice(0, 5)} – {entry.endsAt?.slice(0, 5)}
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1 truncate text-2xs text-ink-faint">
                      {entry.reason}
                    </span>

                    {canEditExceptions ? (
                      <Button size="sm" variant="ghost" onClick={() => setExcepting(entry)}>
                        Edit
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </DataState>
        </PanelBody>
      </Panel>

      <SessionDialog schedule={editing} onClose={() => setEditing(null)} />
      <ExceptionDialog entry={excepting} onClose={() => setExcepting(null)} />
    </div>
  );
}

/* ------------------------------------------------------------------------- */

const SLOT_CHOICES = [5, 10, 15, 20, 30, 45, 60] as const;

function SessionDialog({
  schedule,
  onClose,
}: {
  schedule: PractitionerSchedule | 'new' | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const save = useSaveSchedule();
  const remove = useRemoveSchedule();
  const existing = schedule !== 'new' && schedule !== null ? schedule : null;

  const { data: practitioners } = useQuery({
    queryKey: qk.practitioners,
    queryFn: () =>
      api.get<{ items: { id: string; fullName: string }[] }>('/practitioners'),
    enabled: schedule !== null,
  });

  const blank = {
    practitionerId: '',
    weekday: 1,
    startsAt: '09:00',
    endsAt: '13:00',
    slotMinutes: 15,
    capacityPerSlot: 1,
    isActive: true,
  };
  const [form, setForm] = React.useState(blank);

  React.useEffect(() => {
    if (!schedule) return;
    if (schedule === 'new') {
      setForm(blank);
      return;
    }
    setForm({
      practitionerId: schedule.practitionerId,
      weekday: schedule.weekday,
      startsAt: schedule.startsAt.slice(0, 5),
      endsAt: schedule.endsAt.slice(0, 5),
      slotMinutes: schedule.slotMinutes,
      capacityPerSlot: schedule.capacityPerSlot,
      isActive: schedule.isActive,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule]);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  /* Shown live, because "how many patients is that" is the actual question. */
  const slotCount = React.useMemo(() => {
    const minutes = (t: string) => {
      const [h, m] = t.split(':').map(Number);
      return (h ?? 0) * 60 + (m ?? 0);
    };
    const span = minutes(form.endsAt) - minutes(form.startsAt);
    return span > 0 ? Math.floor(span / form.slotMinutes) : 0;
  }, [form.startsAt, form.endsAt, form.slotMinutes]);

  return (
    <Dialog open={schedule !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit session' : 'New session'}</DialogTitle>
        </DialogHeader>

        <Field label="Doctor" htmlFor="sess-doctor" required>
          <Select
            id="sess-doctor"
            value={form.practitionerId}
            disabled={Boolean(existing)}
            onChange={(event) => set({ practitionerId: event.target.value })}
          >
            <option value="">Choose a doctor…</option>
            {(practitioners?.items ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullName}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Day" htmlFor="sess-day" required>
          <Select
            id="sess-day"
            value={String(form.weekday)}
            onChange={(event) => set({ weekday: Number(event.target.value) })}
          >
            {WEEKDAYS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From" htmlFor="sess-from" required>
            <Input
              id="sess-from"
              type="time"
              value={form.startsAt}
              onChange={(event) => set({ startsAt: event.target.value })}
            />
          </Field>
          <Field label="To" htmlFor="sess-to" required>
            <Input
              id="sess-to"
              type="time"
              value={form.endsAt}
              onChange={(event) => set({ endsAt: event.target.value })}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Slot length"
            htmlFor="sess-slot"
            required
            hint="Per session, not per clinic — follow-ups can be shorter than new patients."
          >
            <Select
              id="sess-slot"
              value={String(form.slotMinutes)}
              onChange={(event) => set({ slotMinutes: Number(event.target.value) })}
            >
              {SLOT_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Patients per slot"
            htmlFor="sess-capacity"
            hint="Above one only if you genuinely run a token system."
          >
            <Input
              id="sess-capacity"
              type="number"
              min={1}
              max={10}
              value={form.capacityPerSlot}
              onChange={(event) => set({ capacityPerSlot: Number(event.target.value) })}
            />
          </Field>
        </div>

        {slotCount > 0 ? (
          <p className="text-xs text-ink-soft">
            That is <span className="font-semibold text-ink">{slotCount} slots</span>
            {form.capacityPerSlot > 1
              ? ` · up to ${slotCount * form.capacityPerSlot} patients`
              : ''}
            {' '}in this session.
          </p>
        ) : (
          <Alert tone="warning" title="That session produces no slots">
            The end time has to be after the start, by at least one slot length.
          </Alert>
        )}

        <DialogFooter>
          {existing ? (
            <Button
              variant="ghost"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(existing.id, {
                  onSuccess: () => {
                    toast.success('Session removed');
                    onClose();
                  },
                })
              }
            >
              Remove
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!form.practitionerId || slotCount === 0}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                { id: existing?.id, locationId: null, effectiveFrom: null, effectiveTo: null, ...form },
                {
                  onSuccess: () => {
                    toast.success('Session saved');
                    onClose();
                  },
                  onError: (error) =>
                    toast.error(
                      error instanceof ApiError ? error.message : 'That did not save',
                    ),
                },
              )
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExceptionDialog({
  entry,
  onClose,
}: {
  entry: ScheduleException | 'new' | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const save = useSaveException();
  const remove = useRemoveException();
  const existing = entry !== 'new' && entry !== null ? entry : null;

  const { data: practitioners } = useQuery({
    queryKey: qk.practitioners,
    queryFn: () =>
      api.get<{ items: { id: string; fullName: string }[] }>('/practitioners'),
    enabled: entry !== null,
  });

  const blank = {
    practitionerId: '',
    onDate: new Date().toISOString().slice(0, 10),
    isAvailable: false,
    startsAt: '',
    endsAt: '',
    reason: '',
  };
  const [form, setForm] = React.useState(blank);

  React.useEffect(() => {
    if (!entry) return;
    if (entry === 'new') {
      setForm(blank);
      return;
    }
    setForm({
      practitionerId: entry.practitionerId ?? '',
      onDate: entry.onDate,
      isAvailable: entry.isAvailable,
      startsAt: entry.startsAt?.slice(0, 5) ?? '',
      endsAt: entry.endsAt?.slice(0, 5) ?? '',
      reason: entry.reason,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry]);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <Dialog open={entry !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit entry' : 'Leave, holiday or extra session'}</DialogTitle>
        </DialogHeader>

        <Field
          label="Who"
          htmlFor="exc-who"
          hint="Leave blank for a clinic-wide closure — a public holiday is not entered per doctor."
        >
          <Select
            id="exc-who"
            value={form.practitionerId}
            onChange={(event) => set({ practitionerId: event.target.value })}
          >
            <option value="">Whole clinic</option>
            {(practitioners?.items ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.fullName}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Date" htmlFor="exc-date" required>
          <Input
            id="exc-date"
            type="date"
            value={form.onDate}
            onChange={(event) => set({ onDate: event.target.value })}
          />
        </Field>

        <Field label="What happens" htmlFor="exc-kind" required>
          <Select
            id="exc-kind"
            value={form.isAvailable ? 'available' : 'closed'}
            onChange={(event) => set({ isAvailable: event.target.value === 'available' })}
          >
            <option value="closed">Not working — leave or closure</option>
            <option value="available">Working, with different hours</option>
          </Select>
        </Field>

        {form.isAvailable ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="From" htmlFor="exc-from" required>
              <Input
                id="exc-from"
                type="time"
                value={form.startsAt}
                onChange={(event) => set({ startsAt: event.target.value })}
              />
            </Field>
            <Field label="To" htmlFor="exc-to" required>
              <Input
                id="exc-to"
                type="time"
                value={form.endsAt}
                onChange={(event) => set({ endsAt: event.target.value })}
              />
            </Field>
          </div>
        ) : null}

        <Field
          label="Reason"
          htmlFor="exc-reason"
          required
          hint="Shown on the empty day. “Why is Dr Rao not bookable” gets asked with a patient waiting."
        >
          <Input
            id="exc-reason"
            value={form.reason}
            onChange={(event) => set({ reason: event.target.value })}
            placeholder="Conference in Mumbai"
          />
        </Field>

        <DialogFooter>
          {existing ? (
            <Button
              variant="ghost"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(existing.id, {
                  onSuccess: () => {
                    toast.success('Entry removed');
                    onClose();
                  },
                })
              }
            >
              Remove
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={
              form.reason.trim().length < 3 ||
              (form.isAvailable && (!form.startsAt || !form.endsAt))
            }
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                {
                  id: existing?.id,
                  practitionerId: form.practitionerId || null,
                  onDate: form.onDate,
                  isAvailable: form.isAvailable,
                  startsAt: form.isAvailable ? form.startsAt : null,
                  endsAt: form.isAvailable ? form.endsAt : null,
                  slotMinutes: null,
                  reason: form.reason,
                },
                {
                  onSuccess: () => {
                    toast.success('Saved');
                    onClose();
                  },
                  onError: (error) =>
                    toast.error(
                      error instanceof ApiError ? error.message : 'That did not save',
                    ),
                },
              )
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
