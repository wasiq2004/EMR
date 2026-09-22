'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CircleCheck,
  CircleSlash,
  Clock,
  ExternalLink,
  MessageSquare,
  Megaphone,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import type { WhatsappTemplate } from '@emr/contracts';
import { ApiError, api } from '@/lib/api-client';
import { relativeTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/surface';
import { Alert, EmptyState, Skeleton } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';

/**
 * The template panel.
 *
 * WhatsApp will not let a business open a conversation with free text, and
 * outside the 24-hour reply window nothing else can be sent at all. So this is
 * not a settings page in the ordinary sense — it is the list of things the
 * clinic is ABLE to say unprompted, and every reminder, every broadcast and
 * every reply to a patient who went quiet comes from it.
 *
 * APPROVAL IS NOT OURS TO GRANT. Templates are written and submitted in Meta
 * Business Manager and approved there; this mirrors that state and can be
 * re-read on demand. Approval can also be withdrawn retroactively and without
 * warning, which is why the status shown here is refreshed rather than
 * remembered, and why the screen presses for a spare.
 *
 * ONCE APPROVED, A TEMPLATE IS USABLE IN BOTH PLACES — a broadcast to many, and
 * a single reply in the inbox, window open or not. Each row says so, because
 * "where can I actually use this?" is the question someone has while reading it.
 */
export default function MessageTemplatesPage() {
  const session = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canConfigure = session.role === 'OWNER_ADMIN';

  const templates = useQuery({
    queryKey: ['whatsapp', 'templates'],
    queryFn: () => api.get<{ items: WhatsappTemplate[] }>('/whatsapp/templates'),
  });

  const sync = useMutation({
    mutationFn: () =>
      api.post<{ synced: number; approved: number }>('/whatsapp/templates/sync', {}),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'templates'] });
      toast.success(
        `${result.synced} template${result.synced === 1 ? '' : 's'} read from WhatsApp, ${result.approved} approved`,
      );
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiError ? error.message : 'Could not reach WhatsApp',
      ),
  });

  const items = templates.data?.items ?? [];
  const approved = items.filter((t) => t.status === 'APPROVED');
  const blocked = items.filter((t) => t.status === 'REJECTED' || t.status === 'PAUSED');
  const waiting = items.filter((t) => t.status === 'PENDING' || t.status === 'DRAFT');

  return (
    <div className="flex flex-col gap-4">
      {blocked.length > 0 ? (
        <Alert tone="critical" title={`${blocked.length} template${blocked.length === 1 ? '' : 's'} cannot be sent`}>
          WhatsApp has rejected or paused {blocked.length === 1 ? 'it' : 'them'}.
          Anything relying on {blocked.length === 1 ? 'it' : 'them'} — a reminder
          rule, a scheduled broadcast — will fail until{' '}
          {blocked.length === 1 ? 'it is' : 'they are'} fixed or replaced in Meta
          Business Manager.
        </Alert>
      ) : null}

      {/*
        Two per purpose. Approval can be withdrawn retroactively and without
        warning, and a single approved template means one rejection takes that
        whole kind of message down with no fallback.
      */}
      {approved.length === 1 ? (
        <Alert tone="warning" title="Only one approved template">
          WhatsApp can pause or reject a template without notice. With one
          approved, a single rejection stops the clinic sending anything
          unprompted.
        </Alert>
      ) : null}

      <Panel>
        <PanelHeader
          title="Message templates"
          description={
            items.length > 0
              ? `${approved.length} approved and usable, ${waiting.length} awaiting review, ${blocked.length} blocked`
              : 'The messages this clinic can send without the patient writing first.'
          }
          actions={
            canConfigure ? (
              <Button
                size="sm"
                variant="secondary"
                loading={sync.isPending}
                onClick={() => sync.mutate()}
              >
                <RefreshCw aria-hidden />
                Read from WhatsApp
              </Button>
            ) : null
          }
        />
        <PanelBody className="flex flex-col gap-2">
          {templates.isLoading ? <Skeleton className="h-24 w-full" /> : null}

          {!templates.isLoading && items.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title="No templates yet"
              description="Templates are written and approved in Meta Business Manager. Create one there, then read them in here."
              action={
                <Button variant="secondary" asChild>
                  <a
                    href="https://business.facebook.com/wa/manage/message-templates/"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Open Meta Business Manager
                    <ExternalLink aria-hidden />
                  </a>
                </Button>
              }
            />
          ) : null}

          {/* Approved first: these are the ones anyone came here to use. */}
          {[...approved, ...waiting, ...blocked].map((template) => (
            <TemplateRow key={template.id} template={template} />
          ))}
        </PanelBody>
      </Panel>

      {items.length > 0 ? (
        <p className="px-1 text-xs text-ink-faint">
          Templates are authored and submitted in Meta Business Manager. This
          screen mirrors what WhatsApp says about them — it cannot approve one,
          and neither can we.
        </p>
      ) : null}
    </div>
  );
}

function TemplateRow({ template }: { template: WhatsappTemplate }) {
  const approved = template.status === 'APPROVED';
  const blocked = template.status === 'REJECTED' || template.status === 'DISABLED';

  const [Icon, tone] = approved
    ? [CircleCheck, 'positive' as const]
    : blocked
      ? [CircleSlash, 'critical' as const]
      : [Clock, 'warning' as const];

  return (
    <article
      className={
        approved
          ? 'rounded-md border border-line bg-surface p-3'
          : 'rounded-md border border-line-soft bg-surface-sunk p-3'
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon
          className={
            approved
              ? 'size-4 text-positive'
              : blocked
                ? 'size-4 text-critical'
                : 'size-4 text-warning'
          }
          aria-hidden
        />
        <span className="token text-sm font-medium text-ink">{template.name}</span>
        <Badge tone={tone}>{template.status}</Badge>
        <Badge tone="neutral">{template.language}</Badge>

        {/*
          Which consent its content requires — the thing that decides who may
          lawfully receive it, and not the same question as whether WhatsApp
          approved the wording.
        */}
        {template.purpose === 'MARKETING' ? (
          <Badge tone="warning">Needs marketing consent</Badge>
        ) : null}

        {template.lastSyncedAt ? (
          <span className="ml-auto text-2xs text-ink-faint">
            Checked {relativeTime(template.lastSyncedAt)}
          </span>
        ) : null}
      </div>

      <p className="mt-2 text-sm whitespace-pre-wrap text-ink-soft">{template.body}</p>

      {template.variables.length > 0 ? (
        <p className="mt-1.5 text-2xs text-ink-faint">
          Fill in:{' '}
          {template.variables
            .map((variable) => `{{${variable.index}}} ${variable.label}`)
            .join(' · ')}
        </p>
      ) : null}

      {template.statusReason ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-critical">
          <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
          {template.statusReason}
        </p>
      ) : null}

      {/*
        Where it can be used. Stated per row because that is the question
        someone has while reading the template, and the answer is the same for
        every approved one: both places, window or not.
      */}
      {approved ? (
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-faint">
          <span className="inline-flex items-center gap-1">
            <Megaphone className="size-3" aria-hidden />
            Sendable in a broadcast
          </span>
          <span className="inline-flex items-center gap-1">
            <MessageSquare className="size-3" aria-hidden />
            Sendable in the inbox, whether or not the 24-hour window is open
          </span>
        </p>
      ) : (
        <p className="mt-2 text-2xs font-medium text-ink-faint">
          Not sendable until WhatsApp approves it.
        </p>
      )}
    </article>
  );
}
