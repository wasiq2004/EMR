'use client';

import * as React from 'react';
import { AlertCircle, Check, CheckCheck, Clock, FileText } from 'lucide-react';
import type { CommunicationStatus, Message } from '@emr/contracts';
import { cn } from '@/lib/cn';

/**
 * One message.
 *
 * STATUS ONLY EVER MOVES FORWARD. Delivery receipts arrive out of order — a
 * `read` can land before the `delivered` for the same message — so a bubble
 * that simply applies the latest event flickers backwards from two ticks to
 * one. `highestStatus` makes the progression monotonic, which is both correct
 * and the difference between a chat client that feels solid and one that does
 * not.
 *
 * FAILED IS NOT A TICK. It is a different thing entirely — the patient did not
 * get this — so it is coloured, labelled in words, and carries the provider's
 * reason. A greyed-out tick would read as "still sending".
 */

const ORDER: Record<CommunicationStatus, number> = {
  QUEUED: 0,
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
  // Terminal and off the progression: once a message has failed, a late
  // `sent` for it is stale information, not progress.
  FAILED: 4,
  RECEIVED: 0,
};

/** The further-along of two statuses. Never moves a bubble backwards. */
export function highestStatus(
  a: CommunicationStatus,
  b: CommunicationStatus,
): CommunicationStatus {
  if (a === 'FAILED' || b === 'FAILED') return 'FAILED';
  return ORDER[b] > ORDER[a] ? b : a;
}

export function MessageBubble({
  message,
  status,
}: {
  message: Message;
  /** Live status from the event stream, already folded to the highest seen. */
  status?: CommunicationStatus;
}) {
  const outbound = message.direction === 'OUTBOUND';
  const effective = status ? highestStatus(message.status, status) : message.status;
  const failed = effective === 'FAILED';

  return (
    <div className={cn('flex w-full', outbound ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[min(34rem,78%)] rounded-lg px-3 py-2 shadow-raise',
          outbound
            ? 'rounded-br-xs bg-accent-soft text-accent-ink'
            : 'rounded-bl-xs border border-line bg-surface text-ink',
          failed && 'border border-critical-line bg-critical-soft text-ink',
        )}
      >
        {/*
          A template that started a conversation is labelled. A patient sees a
          different thing from a free reply, and so should whoever is reading
          the thread back later.
        */}
        {message.messageKind === 'TEMPLATE' && message.templateName ? (
          <p className="mb-1 text-2xs font-medium uppercase tracking-wide opacity-70">
            Template · {message.templateName}
          </p>
        ) : null}

        {message.body ? (
          <p className="text-sm whitespace-pre-wrap break-words">{message.body}</p>
        ) : null}

        {/*
          Documents travel as a secure link, never as raw clinical content in a
          message body — so the bubble shows the attachment, not the contents.
        */}
        {message.documentId ? (
          <p className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium">
            <FileText className="size-3.5" aria-hidden />
            {message.documentTitle ?? 'Document'}
          </p>
        ) : null}

        <div className="mt-1 flex items-center justify-end gap-1.5 text-2xs opacity-70">
          <time dateTime={message.queuedAt}>{clockTime(message.queuedAt)}</time>
          {outbound ? <StatusTick status={effective} /> : null}
        </div>

        {failed && message.providerErrorMessage ? (
          <p className="mt-1.5 flex items-start gap-1.5 text-2xs font-medium text-critical">
            <AlertCircle className="mt-px size-3 shrink-0" aria-hidden />
            {message.providerErrorMessage}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The ticks.
 *
 * Each one carries a text label for assistive technology, because the whole
 * meaning here is conveyed by a shape and a colour — which is exactly the
 * pattern that leaves a screen-reader user with no information at all.
 */
function StatusTick({ status }: { status: CommunicationStatus }) {
  if (status === 'FAILED') {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-critical">
        <AlertCircle className="size-3" aria-hidden />
        Not delivered
      </span>
    );
  }

  const [Icon, label, tone] =
    status === 'READ'
      ? [CheckCheck, 'Read', 'text-info']
      : status === 'DELIVERED'
        ? [CheckCheck, 'Delivered', '']
        : status === 'SENT'
          ? [Check, 'Sent', '']
          : [Clock, 'Sending', ''];

  return (
    <span className={cn('inline-flex items-center', tone)}>
      <Icon className="size-3" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** A day separator, so a long thread does not become one undated wall. */
export function DayDivider({ date }: { date: string }) {
  return (
    <div className="my-3 flex items-center gap-3">
      <span className="h-px flex-1 bg-line-soft" />
      <span className="text-2xs font-medium uppercase tracking-wide text-ink-faint">
        {dayLabel(date)}
      </span>
      <span className="h-px flex-1 bg-line-soft" />
    </div>
  );
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(date, today)) return 'Today';
  if (same(date, yesterday)) return 'Yesterday';

  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}
