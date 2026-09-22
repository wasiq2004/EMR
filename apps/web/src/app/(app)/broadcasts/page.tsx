'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Plus, RotateCcw, Send, TriangleAlert, Users } from 'lucide-react';
import type { WhatsappTemplate } from '@emr/contracts';
import { ApiError, api } from '@/lib/api-client';
import { formatDate } from '@/lib/format';
import { useServerEvents, type ServerEvent } from '@/lib/server-events';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { PageHeader, Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Alert, EmptyState, Skeleton } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Broadcasts.
 *
 * THE EXCLUSION COUNT IS THE POINT OF THIS SCREEN. "Reaches 312 of 480", with a
 * breakdown, is what someone needs before pressing send — a screen showing only
 * the audience size invites them to widen the filter until the number looks big
 * enough, never learning that a third of the register never consented to be
 * contacted this way.
 *
 * A clinic holds these phone numbers because people were ill, not because they
 * joined a mailing list. Making that visible at the moment of sending is the
 * difference between a tool that helps a clinic and one that gets its number
 * blocked.
 */

interface Broadcast {
  id: string;
  name: string;
  purpose: 'CLINICAL' | 'MARKETING';
  status: string;
  recipientCount: number;
  sentCount: number;
  deliveredCount: number;
  failedCount: number;
  exclusionSummary: Record<string, number>;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface AudienceFilter {
  tags?: string[];
  notSeenForDays?: number;
  seenWithinDays?: number;
  ageMin?: number;
  ageMax?: number;
}

interface Preview {
  reaches: number;
  considered: number;
  exclusions: Record<string, number>;
  samples: Record<string, string[]>;
  preview: { patientId: string; fullName: string }[];
}

const EXCLUSION_LABEL: Record<string, string> = {
  NO_CONSENT: 'have not consented to this kind of message',
  OPTED_OUT: 'have opted out of messages',
  NO_MOBILE: 'have no mobile number on file',
  DUPLICATE_NUMBER: 'share a number with someone already included',
  DECEASED_OR_MERGED: 'have a merged record',
};

export default function BroadcastsPage() {
  const queryClient = useQueryClient();
  const [composing, setComposing] = React.useState(false);

  const broadcasts = useQuery({
    queryKey: ['broadcasts'],
    queryFn: () => api.get<{ items: Broadcast[] }>('/broadcasts'),
  });

  // A send takes minutes. Progress arrives over the same stream the inbox uses,
  // so the list moves without anyone reloading a page to find out.
  const onEvent = React.useCallback(
    (event: ServerEvent) => {
      if (event.type !== 'broadcast-progress') return;
      void queryClient.invalidateQueries({ queryKey: ['broadcasts'] });
    },
    [queryClient],
  );
  useServerEvents(onEvent);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <PageHeader
        title="Broadcasts"
        description="One message to many patients — only those who agreed to receive it."
        actions={
          <Button variant="primary" onClick={() => setComposing(true)}>
            <Plus aria-hidden />
            New broadcast
          </Button>
        }
      />

      {broadcasts.isLoading ? <Skeleton className="h-40 w-full" /> : null}

      {!broadcasts.isLoading && (broadcasts.data?.items.length ?? 0) === 0 ? (
        <Panel>
          <EmptyState
            icon={Megaphone}
            title="No broadcasts yet"
            description="Send a clinic closure notice, a recall for patients due a review, or a camp invitation."
            action={
              <Button variant="primary" onClick={() => setComposing(true)}>
                New broadcast
              </Button>
            }
          />
        </Panel>
      ) : null}

      {broadcasts.data?.items.map((broadcast) => (
        <BroadcastCard key={broadcast.id} broadcast={broadcast} />
      ))}

      <ComposeDialog open={composing} onOpenChange={setComposing} />
    </div>
  );
}

function BroadcastCard({ broadcast }: { broadcast: Broadcast }) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const retry = useMutation({
    mutationFn: () => api.post(`/broadcasts/${broadcast.id}/retry`, {}),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['broadcasts'] });
      toast.success('Retrying the failed messages');
    },
  });

  const tone =
    broadcast.status === 'SENT'
      ? 'positive'
      : broadcast.status === 'SENDING'
        ? 'info'
        : broadcast.status === 'FAILED' || broadcast.status === 'CANCELLED'
          ? 'critical'
          : 'neutral';

  const excluded = Object.entries(broadcast.exclusionSummary).filter(([, n]) => n > 0);

  return (
    <Panel>
      <PanelHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {broadcast.name}
            <Badge tone={tone as never}>{broadcast.status}</Badge>
            {broadcast.purpose === 'MARKETING' ? (
              <Badge tone="warning">Marketing</Badge>
            ) : null}
          </span>
        }
        description={
          broadcast.startedAt
            ? `Sent ${formatDate(broadcast.startedAt)}`
            : `Created ${formatDate(broadcast.createdAt)}`
        }
        actions={
          broadcast.failedCount > 0 ? (
            <Button size="sm" variant="secondary" loading={retry.isPending} onClick={() => retry.mutate()}>
              <RotateCcw aria-hidden />
              Retry {broadcast.failedCount} failed
            </Button>
          ) : null
        }
      />
      <PanelBody className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-6">
          <Figure label="Recipients" value={broadcast.recipientCount} />
          <Figure label="Sent" value={broadcast.sentCount} />
          <Figure label="Delivered" value={broadcast.deliveredCount} />
          <Figure
            label="Failed"
            value={broadcast.failedCount}
            tone={broadcast.failedCount > 0 ? 'critical' : undefined}
          />
        </div>

        {/*
          Kept on the record after sending, not only shown while composing.
          Months later, "why did only 312 of our 480 patients get this?" is a
          question someone will ask, and the answer should be on the broadcast.
        */}
        {excluded.length > 0 ? (
          <p className="text-xs text-ink-faint">
            Not sent to{' '}
            {excluded
              .map(([reason, count]) => `${count} who ${EXCLUSION_LABEL[reason] ?? reason}`)
              .join(', ')}
            .
          </p>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'critical';
}) {
  return (
    <div>
      <p className="text-2xs uppercase tracking-wide text-ink-faint">{label}</p>
      <p
        className={
          tone === 'critical'
            ? 'text-lg font-semibold tabular text-critical'
            : 'text-lg font-semibold tabular text-ink'
        }
      >
        {value}
      </p>
    </div>
  );
}

/* --------------------------------------------------------------------------- */

function ComposeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [name, setName] = React.useState('');
  const [templateId, setTemplateId] = React.useState('');
  const [filter, setFilter] = React.useState<AudienceFilter>({});
  const [variables, setVariables] = React.useState<Record<string, string>>({});
  const [sending, setSending] = React.useState(false);

  const templates = useQuery({
    queryKey: ['whatsapp', 'templates'],
    queryFn: () => api.get<{ items: WhatsappTemplate[] }>('/whatsapp/templates'),
    enabled: open,
  });

  const approved = (templates.data?.items ?? []).filter((t) => t.status === 'APPROVED');
  const template = approved.find((t) => t.id === templateId) ?? null;

  // The template decides the purpose, not a separate control. They have to
  // agree — the server refuses when they do not — and asking twice invites
  // someone to answer differently.
  const purpose = template?.purpose ?? 'CLINICAL';

  const preview = useQuery({
    queryKey: ['broadcasts', 'preview', purpose, JSON.stringify(filter)],
    queryFn: () =>
      api.post<Preview>('/broadcasts/preview', { purpose, audienceFilter: filter }),
    enabled: open,
  });

  const submit = async () => {
    if (!template || !name.trim()) return;
    setSending(true);
    try {
      const created = await api.post<{ id: string }>('/broadcasts', {
        name: name.trim(),
        templateId: template.id,
        purpose,
        audienceFilter: filter,
        templateVariables: variables,
      });
      await api.post(`/broadcasts/${created.id}/send`, {});
      await queryClient.invalidateQueries({ queryKey: ['broadcasts'] });
      onOpenChange(false);
      setName('');
      setTemplateId('');
      setFilter({});
      toast.success('Broadcast started');
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : 'That broadcast could not be sent',
      );
    } finally {
      setSending(false);
    }
  };

  const reaches = preview.data?.reaches ?? 0;
  const excluded = Object.entries(preview.data?.exclusions ?? {}).filter(([, n]) => n > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>New broadcast</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {approved.length === 0 ? (
            <Alert tone="warning" title="No approved template">
              WhatsApp will not let a business start a conversation with free
              text, so a broadcast needs an approved template. Create one in Meta
              Business Manager and sync it from Settings.
            </Alert>
          ) : null}

          <Field label="Name" htmlFor="bc-name" hint="For your own records." required>
            <Input
              id="bc-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Diwali closure notice"
            />
          </Field>

          <Field label="Template" htmlFor="bc-template" required>
            <select
              id="bc-template"
              value={templateId}
              onChange={(event) => {
                setTemplateId(event.target.value);
                setVariables({});
              }}
              className="h-9 w-full rounded-md border border-line-control bg-surface px-2 text-sm text-ink"
            >
              <option value="">Choose a template…</option>
              {approved.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.purpose === 'MARKETING' ? 'marketing' : 'clinical'})
                </option>
              ))}
            </select>
          </Field>

          {template ? (
            <>
              <p className="rounded-md bg-surface-sunk px-3 py-2 text-sm whitespace-pre-wrap text-ink-soft">
                {template.body}
              </p>

              {template.variables.map((variable) => (
                <Field
                  key={variable.index}
                  label={`${'{{'}${variable.index}${'}}'} — ${variable.label}`}
                  htmlFor={`bc-var-${variable.index}`}
                >
                  <Input
                    id={`bc-var-${variable.index}`}
                    value={variables[String(variable.index)] ?? ''}
                    onChange={(event) =>
                      setVariables((current) => ({
                        ...current,
                        [String(variable.index)]: event.target.value,
                      }))
                    }
                  />
                </Field>
              ))}

              {template.purpose === 'MARKETING' ? (
                <Alert tone="warning" title="This is a marketing message">
                  It goes only to patients who separately consented to marketing,
                  which is far fewer than those who agreed to hear about their
                  care. That is not a bug in the count below.
                </Alert>
              ) : null}
            </>
          ) : null}

          <AudienceBuilder filter={filter} onChange={setFilter} />

          {/* The number, and everyone it leaves out. */}
          <div className="rounded-md border border-line bg-surface-sunk p-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Users className="size-4" aria-hidden />
              Reaches{' '}
              <span className="tabular text-lg">{reaches}</span> of{' '}
              <span className="tabular">{preview.data?.considered ?? 0}</span> matching
              patients
            </p>

            {excluded.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-1">
                {excluded.map(([reason, count]) => (
                  <li key={reason} className="flex items-start gap-1.5 text-xs text-ink-soft">
                    <TriangleAlert className="mt-px size-3 shrink-0 text-warning" aria-hidden />
                    <span>
                      <strong className="tabular">{count}</strong>{' '}
                      {EXCLUSION_LABEL[reason] ?? reason}
                      {preview.data?.samples?.[reason]?.length ? (
                        <span className="text-ink-faint">
                          {' '}
                          — {preview.data.samples[reason]!.slice(0, 3).join(', ')}
                          {count > 3 ? ' and others' : ''}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            {reaches === 0 ? (
              <p className="mt-2 text-xs font-medium text-critical">
                This would reach nobody, so it cannot be sent.
              </p>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!template || !name.trim() || reaches === 0}
            loading={sending}
            onClick={submit}
          >
            <Send aria-hidden />
            Send to {reaches}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Who to send to.
 *
 * Four controls, not a query builder. A clinic of this size sends a closure
 * notice, a recall for people overdue a review, or an invitation to a camp for
 * a condition — and every one of those is expressible here. A general-purpose
 * filter UI would cost more to use and get used less.
 */
function AudienceBuilder({
  filter,
  onChange,
}: {
  filter: AudienceFilter;
  onChange: (filter: AudienceFilter) => void;
}) {
  const set = (patch: Partial<AudienceFilter>) => onChange({ ...filter, ...patch });

  const TAGS = ['Chronic care', 'Geriatric', 'Paediatric'];

  return (
    <fieldset className="rounded-md border border-line-soft p-3">
      <legend className="px-1 text-2xs font-medium uppercase tracking-wide text-ink-faint">
        Who receives it
      </legend>

      <div className="mt-1 flex flex-wrap gap-1.5">
        {TAGS.map((tag) => {
          const on = filter.tags?.includes(tag) ?? false;
          return (
            <button
              key={tag}
              type="button"
              aria-pressed={on}
              onClick={() =>
                set({
                  tags: on
                    ? filter.tags?.filter((t) => t !== tag)
                    : [...(filter.tags ?? []), tag],
                })
              }
              className={
                on
                  ? 'rounded-md bg-accent-soft px-2 py-1 text-xs font-medium text-accent-ink'
                  : 'rounded-md border border-line px-2 py-1 text-xs text-ink-soft hover:bg-surface-sunk'
              }
            >
              {tag}
            </button>
          );
        })}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field
          label="Not seen for at least"
          htmlFor="bc-notseen"
          hint="Days. The recall case — includes patients who never returned."
        >
          <Input
            id="bc-notseen"
            type="number"
            min={1}
            value={filter.notSeenForDays ?? ''}
            onChange={(event) =>
              set({ notSeenForDays: event.target.value ? Number(event.target.value) : undefined })
            }
          />
        </Field>

        <Field label="Age from" htmlFor="bc-agemin" hint="Uses a stated age where there is no date of birth.">
          <div className="flex items-center gap-2">
            <Input
              id="bc-agemin"
              type="number"
              min={0}
              max={130}
              value={filter.ageMin ?? ''}
              onChange={(event) =>
                set({ ageMin: event.target.value ? Number(event.target.value) : undefined })
              }
            />
            <span className="text-xs text-ink-faint">to</span>
            <Input
              type="number"
              min={0}
              max={130}
              aria-label="Age to"
              value={filter.ageMax ?? ''}
              onChange={(event) =>
                set({ ageMax: event.target.value ? Number(event.target.value) : undefined })
              }
            />
          </div>
        </Field>
      </div>
    </fieldset>
  );
}
