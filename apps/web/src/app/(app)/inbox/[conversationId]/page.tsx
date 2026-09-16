'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Clock, Send } from 'lucide-react';
import { isWindowOpen, windowRemainingMs } from '@emr/contracts';
import { useConversation, useSendReply } from '@/features/inbox/api';
import { formatCountdown, formatPhone, formatTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, Textarea } from '@/components/ui/field';
import { Panel } from '@/components/ui/surface';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';

const TEMPLATES = [
  { name: 'appointment_reminder_v2', label: 'Appointment reminder' },
  { name: 'prescription_ready_v1', label: 'Prescription ready' },
  { name: 'report_ready_v1', label: 'Report ready' },
  { name: 'follow_up_due_v1', label: 'Follow-up due' },
];

/**
 * One conversation.
 *
 * The 24-hour service window is the thing this screen exists to make visible.
 * Free-form replies are permitted only within 24 hours of the patient's last
 * message; outside it, only pre-approved templates go through. It fails
 * SILENTLY at the provider — the message is simply rejected — so the countdown
 * is on screen and the composer switches by itself rather than letting someone
 * type a message that will never arrive.
 */
export default function ConversationPage() {
  const params = useParams<{ conversationId: string }>();
  const { data, isLoading } = useConversation(params.conversationId);
  const send = useSendReply(params.conversationId);
  const toast = useToast();

  const [body, setBody] = React.useState('');
  const [templateName, setTemplateName] = React.useState(TEMPLATES[0]?.name ?? '');
  const [now, setNow] = React.useState(() => Date.now());

  // The countdown has to actually count down.
  React.useEffect(() => {
    const timer = globalThis.setInterval(() => setNow(Date.now()), 30_000);
    return () => globalThis.clearInterval(timer);
  }, []);

  const conversation = data?.conversation;
  const messages = data?.messages ?? [];
  const open = conversation ? isWindowOpen(conversation.windowExpiresAt, now) : false;
  const remaining = conversation
    ? windowRemainingMs(conversation.windowExpiresAt, now)
    : -1;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return;
    try {
      await send.mutateAsync({
        body: body.trim(),
        templateName: open ? null : templateName,
      });
      setBody('');
      toast.success(open ? 'Message sent' : 'Template sent');
    } catch {
      toast.error('Could not send', 'The message has not gone to the patient.');
    }
  };

  if (isLoading || !conversation) return <Skeleton className="h-[70vh] w-full" />;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Link
        href="/inbox"
        className="inline-flex w-fit items-center gap-1.5 text-xs text-ink-faint hover:text-ink"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Inbox
      </Link>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold text-ink">
          {conversation.patientName ?? formatPhone(conversation.counterpartyE164)}
        </h1>
        <span className="token text-xs text-ink-faint">
          {formatPhone(conversation.counterpartyE164)}
        </span>
        {conversation.patientId ? (
          <Button size="sm" variant="secondary" asChild>
            <Link href={`/patients/${conversation.patientId}`}>Open record</Link>
          </Button>
        ) : null}
      </div>

      {/* The window state, always visible. */}
      <div
        className={cn(
          'flex items-center gap-2 rounded-md border px-3 py-2 text-xs',
          open
            ? 'border-positive-line bg-positive-soft text-positive'
            : 'border-warning-line bg-warning-soft text-warning',
        )}
      >
        <Clock className="size-3.5 shrink-0" aria-hidden />
        {open ? (
          <span>
            You can reply freely for another{' '}
            <strong>{formatCountdown(remaining)}</strong>, because the patient
            messaged recently.
          </span>
        ) : (
          <span>
            The free-reply window has closed. Only an approved template can be
            sent until the patient messages again.
          </span>
        )}
      </div>

      {conversation.isOptedOut ? (
        <Alert tone="critical" title="This patient has opted out of messages">
          Nothing will be sent, including prescriptions. Print a copy or use a
          secure link instead.
        </Alert>
      ) : null}

      <Panel className="flex max-h-[50vh] flex-col overflow-y-auto scroll-thin p-4">
        <ul className="flex flex-col gap-3">
          {messages.map((message) => {
            const outbound = message.direction === 'OUTBOUND';
            return (
              <li
                key={message.id}
                className={cn('flex', outbound ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={cn(
                    'max-w-[80%] rounded-lg px-3 py-2',
                    outbound
                      ? 'bg-accent-soft text-ink'
                      : 'bg-surface-sunk text-ink',
                  )}
                >
                  <p className="whitespace-pre-line text-sm">{message.body}</p>
                  <p className="mt-1 flex items-center gap-1.5 text-2xs text-ink-faint">
                    {formatTime(message.queuedAt)}
                    {outbound ? (
                      <>
                        <span>·</span>
                        <span>
                          {message.status === 'READ'
                            ? 'Read'
                            : message.status === 'DELIVERED'
                              ? 'Delivered'
                              : message.status === 'FAILED'
                                ? 'Not delivered'
                                : 'Sent'}
                        </span>
                        {message.messageKind === 'TEMPLATE' ? (
                          <Badge tone="neutral">Template</Badge>
                        ) : null}
                      </>
                    ) : null}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </Panel>

      <form onSubmit={submit} className="flex flex-col gap-2">
        {!open ? (
          <Select
            value={templateName}
            onChange={(event) => setTemplateName(event.target.value)}
            aria-label="Approved template"
          >
            {TEMPLATES.map((template) => (
              <option key={template.name} value={template.name}>
                {template.label}
              </option>
            ))}
          </Select>
        ) : null}

        <Textarea
          rows={3}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={
            open
              ? 'Type your reply'
              : 'Fill in the template. Only approved wording can be sent right now.'
          }
          aria-label="Message to the patient"
          disabled={conversation.isOptedOut}
        />

        <div className="flex items-center justify-between gap-2">
          <span className="text-2xs text-ink-faint">
            {open
              ? 'Sent as a normal message.'
              : 'Sent as an approved template, which the provider charges for.'}
          </span>
          <Button
            type="submit"
            variant="primary"
            loading={send.isPending}
            disabled={!body.trim() || conversation.isOptedOut}
          >
            <Send aria-hidden />
            Send
          </Button>
        </div>
      </form>
    </div>
  );
}
