'use client';

import * as React from 'react';
import { ArrowLeft, Link2Off, PanelRight, Send, SendHorizonal } from 'lucide-react';
import type {
  CommunicationStatus,
  Conversation,
  Message,
  WhatsappTemplate,
} from '@emr/contracts';
import { cn } from '@/lib/cn';
import { formatPhone } from '@/lib/format';
import { ApiError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Alert, Skeleton } from '@/components/ui/feedback';
import { useToast } from '@/components/ui/toast';
import { DayDivider, MessageBubble } from './message-bubble';
import { WindowBar, useWindowCountdown } from './window-bar';
import { useConversation, useSendReply } from './api';

/**
 * One conversation.
 *
 * OPTIMISTIC SEND. The bubble appears the moment Send is pressed, marked
 * QUEUED, and is replaced when the server's row arrives. A composer that waits
 * for a round trip feels broken at the front desk on clinic wifi — and the
 * patient in front of the receptionist is waiting on that reply.
 *
 * The optimistic bubble is dropped by MATCHING THE SERVER'S ROW, not by a
 * timer: the request can succeed while the refetch is still in flight, and
 * removing on a timeout would blink the message out and back.
 */
export function ChatWindow({
  conversationId,
  templates,
  statusOverrides,
  onBack,
  onToggleContext,
  contextOpen,
  onLinkRequested,
}: {
  conversationId: string;
  templates: WhatsappTemplate[];
  /** Live delivery state from the event stream, already folded monotonically. */
  statusOverrides: Record<string, CommunicationStatus>;
  onBack?: () => void;
  onToggleContext: () => void;
  contextOpen: boolean;
  onLinkRequested: (conversation: Conversation) => void;
}) {
  const toast = useToast();
  const { data, isLoading } = useConversation(conversationId);
  const send = useSendReply(conversationId);

  const [draft, setDraft] = React.useState('');
  const [templateName, setTemplateName] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<Message[]>([]);

  const conversation = data?.conversation;
  const { open: windowOpen } = useWindowCountdown(conversation?.windowExpiresAt ?? null);

  const approved = React.useMemo(
    () => templates.filter((t) => t.status === 'APPROVED'),
    [templates],
  );

  // Reset the composer when the conversation changes, so a half-typed reply
  // cannot be sent to the wrong patient.
  React.useEffect(() => {
    setDraft('');
    setTemplateName(null);
    setPending([]);
  }, [conversationId]);

  const messages = React.useMemo(() => {
    const server = data?.messages ?? [];
    const serverBodies = new Set(server.map((m) => `${m.direction}:${m.body ?? ''}`));
    // Drop an optimistic bubble once its real row has arrived. Matched on
    // direction and body rather than on id, because the id is assigned by the
    // server and the optimistic row never had it.
    const stillPending = pending.filter(
      (p) => !serverBodies.has(`${p.direction}:${p.body ?? ''}`),
    );
    return [...server, ...stillPending];
  }, [data?.messages, pending]);

  // Keep the newest message in view. Only when already near the bottom — a
  // reader scrolled up through history should not be yanked down by an
  // incoming message.
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const atBottomRef = React.useRef(true);

  React.useEffect(() => {
    const element = scrollRef.current;
    if (!element || !atBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [messages.length, conversationId]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    atBottomRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 120;
  };

  const canSend = Boolean(
    conversation &&
      !conversation.isOptedOut &&
      (windowOpen ? draft.trim() : templateName),
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSend || !conversation) return;

    const body = windowOpen
      ? draft.trim()
      : (approved.find((t) => t.name === templateName)?.body ?? '');

    const optimistic: Message = {
      id: `pending-${Date.now()}`,
      conversationId,
      patientId: conversation.patientId,
      channel: 'WHATSAPP',
      direction: 'OUTBOUND',
      status: 'QUEUED',
      messageKind: windowOpen ? 'SESSION' : 'TEMPLATE',
      templateName: windowOpen ? null : templateName,
      body,
      documentId: null,
      documentTitle: null,
      providerErrorMessage: null,
      queuedAt: new Date().toISOString(),
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      failedAt: null,
      sentByName: null,
      costPaise: null,
    };

    setPending((current) => [...current, optimistic]);
    setDraft('');
    atBottomRef.current = true;

    try {
      await send.mutateAsync({ body, templateName: windowOpen ? null : templateName });
      setTemplateName(null);
    } catch (error) {
      // Put the text back in the composer. Losing a typed reply to a failed
      // send is the single most annoying thing a chat client can do.
      setPending((current) => current.filter((m) => m.id !== optimistic.id));
      if (windowOpen) setDraft(body);
      toast.error(
        error instanceof ApiError ? error.message : 'That message could not be sent',
      );
    }
  };

  if (isLoading || !conversation) {
    return (
      <div className="flex flex-1 flex-col gap-3 p-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-canvas" aria-label="Conversation">
      <header className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2">
        {onBack ? (
          <Button size="icon" variant="ghost" onClick={onBack} aria-label="Back to conversations" className="lg:hidden">
            <ArrowLeft aria-hidden />
          </Button>
        ) : null}

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink">
            {conversation.patientName ?? formatPhone(conversation.counterpartyE164)}
          </p>
          <p className="truncate text-2xs text-ink-faint">
            <span className="token">{formatPhone(conversation.counterpartyE164)}</span>
            {conversation.assignedToName ? ` · ${conversation.assignedToName}` : ''}
          </p>
        </div>

        {conversation.isUnlinked ? (
          <Button size="sm" variant="secondary" onClick={() => onLinkRequested(conversation)}>
            <Link2Off aria-hidden />
            Link to a patient
          </Button>
        ) : null}

        <Button
          size="icon"
          variant="ghost"
          onClick={onToggleContext}
          aria-label={contextOpen ? 'Hide patient details' : 'Show patient details'}
          aria-pressed={contextOpen}
          className="hidden xl:inline-flex"
        >
          <PanelRight aria-hidden />
        </Button>
      </header>

      <WindowBar
        expiresAt={conversation.windowExpiresAt}
        templates={templates}
        optedOut={conversation.isOptedOut}
      />

      {conversation.isUnlinked ? (
        <Alert
          tone="info"
          title="Not linked to a patient yet"
          className="m-3"
        >
          One mobile number often serves a whole family here, so an inbound
          message can match several patients or none. Link it before replying so
          the thread lands in the right record.
        </Alert>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="scroll-thin flex-1 overflow-y-auto px-3 py-4"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
          {messages.map((message, index) => {
            const previous = messages[index - 1];
            const newDay =
              !previous ||
              new Date(previous.queuedAt).toDateString() !==
                new Date(message.queuedAt).toDateString();

            return (
              <React.Fragment key={message.id}>
                {newDay ? <DayDivider date={message.queuedAt} /> : null}
                <MessageBubble message={message} status={statusOverrides[message.id]} />
              </React.Fragment>
            );
          })}

          {messages.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-faint">
              No messages yet.
            </p>
          ) : null}
        </div>
      </div>

      <Composer
        windowOpen={windowOpen}
        optedOut={conversation.isOptedOut}
        draft={draft}
        onDraftChange={setDraft}
        templates={approved}
        templateName={templateName}
        onTemplateChange={setTemplateName}
        canSend={canSend}
        sending={send.isPending}
        onSubmit={submit}
      />
    </section>
  );
}

/**
 * The composer.
 *
 * It does not offer free text outside the window and then fail — the control
 * itself changes, because the rule is absolute and the interface should not
 * invite an action it knows will be refused.
 */
function Composer({
  windowOpen,
  optedOut,
  draft,
  onDraftChange,
  templates,
  templateName,
  onTemplateChange,
  canSend,
  sending,
  onSubmit,
}: {
  windowOpen: boolean;
  optedOut: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  templates: WhatsappTemplate[];
  templateName: string | null;
  onTemplateChange: (name: string | null) => void;
  canSend: boolean;
  sending: boolean;
  onSubmit: (event: React.FormEvent) => void;
}) {
  if (optedOut) return null;

  if (!windowOpen) {
    if (templates.length === 0) return null;

    return (
      <form onSubmit={onSubmit} className="border-t border-line bg-surface p-3">
        <label
          htmlFor="reply-template"
          className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-ink-faint"
        >
          Send an approved template
        </label>
        <div className="flex gap-2">
          <select
            id="reply-template"
            value={templateName ?? ''}
            onChange={(event) => onTemplateChange(event.target.value || null)}
            className="h-9 min-w-0 flex-1 rounded-md border border-line-control bg-surface px-2 text-sm text-ink"
          >
            <option value="">Choose a template…</option>
            {templates.map((template) => (
              <option key={template.id} value={template.name}>
                {template.name}
              </option>
            ))}
          </select>
          <Button type="submit" variant="primary" disabled={!canSend} loading={sending}>
            <Send aria-hidden />
            Send
          </Button>
        </div>

        {templateName ? (
          <p className="mt-2 rounded-md bg-surface-sunk px-2.5 py-2 text-xs whitespace-pre-wrap text-ink-soft">
            {templates.find((t) => t.name === templateName)?.body}
          </p>
        ) : null}
      </form>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex items-end gap-2 border-t border-line bg-surface p-3">
      <label htmlFor="reply-body" className="sr-only">
        Your reply
      </label>
      <textarea
        id="reply-body"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends, Shift+Enter breaks the line — what every chat client
          // does, and what a receptionist's hands already expect.
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            (event.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
          }
        }}
        rows={1}
        placeholder="Type a reply…"
        className={cn(
          'max-h-32 min-h-9 flex-1 resize-none rounded-md border border-line-control bg-surface',
          'px-3 py-2 text-sm text-ink placeholder:text-ink-faint',
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
        )}
      />
      <Button type="submit" variant="primary" disabled={!canSend} loading={sending}>
        <SendHorizonal aria-hidden />
        <span className="sr-only sm:not-sr-only">Send</span>
      </Button>
    </form>
  );
}
