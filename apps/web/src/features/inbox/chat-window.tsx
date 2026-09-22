'use client';

import * as React from 'react';
import { ArrowLeft, Link2Off, PanelRight, SendHorizonal } from 'lucide-react';
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
import { TemplateButton, TemplatePicker } from './template-picker';

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
  const [pending, setPending] = React.useState<Message[]>([]);
  const [pickerOpen, setPickerOpen] = React.useState(false);

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
    setPending([]);
    setPickerOpen(false);
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

  // Free text needs an open window. A template does not, which is why the
  // template button is not gated on it.
  const canSend = Boolean(
    conversation && !conversation.isOptedOut && windowOpen && draft.trim(),
  );

  /**
   * Adds the bubble immediately, sends, and reconciles.
   *
   * Shared by both paths so a template send behaves exactly like a typed one —
   * it appears at once and turns into the server's row when that arrives.
   */
  const sendWith = async (
    payload: { body?: string; templateId?: string; templateVariables?: Record<string, string> },
    optimisticBody: string,
    kind: 'SESSION' | 'TEMPLATE',
    templateLabel: string | null,
  ) => {
    if (!conversation) return;

    const optimistic: Message = {
      id: `pending-${Date.now()}`,
      conversationId,
      patientId: conversation.patientId,
      channel: 'WHATSAPP',
      direction: 'OUTBOUND',
      status: 'QUEUED',
      messageKind: kind,
      templateName: templateLabel,
      body: optimisticBody,
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
    atBottomRef.current = true;

    try {
      await send.mutateAsync(payload);
      setPickerOpen(false);
    } catch (error) {
      // Put the text back in the composer. Losing a typed reply to a failed
      // send is the single most annoying thing a chat client can do.
      setPending((current) => current.filter((m) => m.id !== optimistic.id));
      if (kind === 'SESSION') setDraft(optimisticBody);
      toast.error(
        error instanceof ApiError ? error.message : 'That message could not be sent',
      );
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    const body = draft.trim();
    setDraft('');
    await sendWith({ body }, body, 'SESSION', null);
  };

  const sendTemplate = async (templateId: string, variables: Record<string, string>) => {
    const template = approved.find((t) => t.id === templateId);
    if (!template) return;

    // The preview the picker showed is what goes on the thread, because that is
    // what the patient receives — a bubble reading "Namaste {{1}}" is a record
    // of nothing.
    const filled = template.body.replace(
      /\{\{\s*(\d+)\s*\}\}/g,
      (match, index: string) => variables[index]?.trim() || match,
    );

    await sendWith(
      { templateId, templateVariables: variables },
      filled,
      'TEMPLATE',
      template.name,
    );
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
        hasTemplates={approved.length > 0}
        onOpenTemplates={() => setPickerOpen(true)}
        canSend={canSend}
        sending={send.isPending}
        onSubmit={submit}
      />

      <TemplatePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        templates={templates}
        patientName={conversation.patientName}
        sending={send.isPending}
        onSend={sendTemplate}
      />
    </section>
  );
}

/**
 * The composer.
 *
 * The template button is ALWAYS there. Outside the window it is the primary
 * action, because a template is then the only thing that can be sent; inside
 * it, it sits beside the text box as the faster correct way to send the message
 * a clinic sends most — "your report is ready". Hiding it until the window
 * closes would put the common case behind the uncommon state.
 *
 * The text box itself does not appear outside the window. The rule is absolute,
 * and offering a control that is guaranteed to be refused is worse than not
 * offering it.
 */
function Composer({
  windowOpen,
  optedOut,
  draft,
  onDraftChange,
  hasTemplates,
  onOpenTemplates,
  canSend,
  sending,
  onSubmit,
}: {
  windowOpen: boolean;
  optedOut: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  hasTemplates: boolean;
  onOpenTemplates: () => void;
  canSend: boolean;
  sending: boolean;
  onSubmit: (event: React.FormEvent) => void;
}) {
  if (optedOut) return null;

  if (!windowOpen) {
    if (!hasTemplates) return null;

    return (
      <div className="flex items-center gap-3 border-t border-line bg-surface p-3">
        <p className="min-w-0 flex-1 text-xs text-ink-faint">
          Free replies are closed for this patient. An approved template can
          still be sent.
        </p>
        <TemplateButton onClick={onOpenTemplates} forced />
      </div>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex items-end gap-2 border-t border-line bg-surface p-3"
    >
      {hasTemplates ? <TemplateButton onClick={onOpenTemplates} forced={false} /> : null}

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
