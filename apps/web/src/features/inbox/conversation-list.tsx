'use client';

import * as React from 'react';
import { Link2Off, Search, Wifi, WifiOff } from 'lucide-react';
import type { Conversation } from '@emr/contracts';
import { cn } from '@/lib/cn';
import { formatPhone, relativeTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/field';
import { SkeletonRows } from '@/components/ui/feedback';
import type { StreamStatus } from '@/lib/server-events';
import { useWindowCountdown, formatRemaining } from './window-bar';

export type InboxFilter = 'all' | 'open' | 'unlinked';

const FILTERS: { value: InboxFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Needs a reply' },
  { value: 'unlinked', label: 'Unlinked' },
];

/**
 * The conversation rail.
 *
 * Searched in the browser rather than on the server. The whole list is already
 * loaded, a clinic of this size has tens of conversations rather than
 * thousands, and a filter that responds on the keystroke is worth more here
 * than one that is correct at scale we do not have. When that stops being true
 * it becomes a server query, and the component's surface does not change.
 */
export function ConversationList({
  conversations,
  loading,
  selectedId,
  onSelect,
  filter,
  onFilterChange,
  streamStatus,
}: {
  conversations: Conversation[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (conversation: Conversation) => void;
  filter: InboxFilter;
  onFilterChange: (filter: InboxFilter) => void;
  streamStatus: StreamStatus;
}) {
  const [term, setTerm] = React.useState('');

  const visible = React.useMemo(() => {
    const needle = term.trim().toLowerCase();
    if (!needle) return conversations;
    const digits = needle.replace(/\D/g, '');

    return conversations.filter((conversation) => {
      if (conversation.patientName?.toLowerCase().includes(needle)) return true;
      if (conversation.lastMessagePreview?.toLowerCase().includes(needle)) return true;
      // Digits only, so "98765 43210" finds "+919876543210". A receptionist
      // reads a number off a phone screen with whatever spacing it has.
      return digits.length >= 3 && conversation.counterpartyE164.includes(digits);
    });
  }, [conversations, term]);

  return (
    <div className="flex w-full min-w-0 flex-col border-r border-line bg-surface lg:w-[22rem]">
      <div className="border-b border-line-soft p-3">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-sm font-semibold text-ink">Inbox</h1>
          <StreamIndicator status={streamStatus} />
        </div>

        <div className="relative mt-2">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint"
            aria-hidden
          />
          <Input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Search name, number or message"
            aria-label="Search conversations"
            className="pl-8"
          />
        </div>

        <div className="mt-2 flex gap-1" role="tablist" aria-label="Filter conversations">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={filter === option.value}
              onClick={() => onFilterChange(option.value)}
              className={cn(
                'rounded-md px-2 py-1 text-xs font-medium',
                'transition-colors duration-[--duration-ui] ease-[--ease-ui]',
                filter === option.value
                  ? 'bg-accent-soft text-accent-ink'
                  : 'text-ink-faint hover:bg-surface-sunk hover:text-ink',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto">
        {loading ? <SkeletonRows rows={6} /> : null}

        {!loading && visible.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-ink-faint">
            {term ? 'Nothing matches that.' : 'No conversations yet.'}
          </p>
        ) : null}

        <ul>
          {visible.map((conversation) => (
            <li key={conversation.id}>
              <ConversationRow
                conversation={conversation}
                selected={conversation.id === selectedId}
                onSelect={() => onSelect(conversation)}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ConversationRow({
  conversation,
  selected,
  onSelect,
}: {
  conversation: Conversation;
  selected: boolean;
  onSelect: () => void;
}) {
  const { open, secondsLeft } = useWindowCountdown(conversation.windowExpiresAt);
  const closingSoon = open && secondsLeft < 3600;

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full flex-col gap-1 border-b border-line-soft px-3 py-2.5 text-left',
        'transition-colors duration-[--duration-ui] ease-[--ease-ui]',
        selected ? 'bg-accent-soft' : 'hover:bg-surface-sunk',
      )}
    >
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-sm',
            conversation.isUnread ? 'font-semibold text-ink' : 'font-medium text-ink',
          )}
        >
          {conversation.patientName ?? formatPhone(conversation.counterpartyE164)}
        </span>
        <span className="shrink-0 text-2xs text-ink-faint">
          {conversation.lastInboundAt ? relativeTime(conversation.lastInboundAt) : ''}
        </span>
      </div>

      <p
        className={cn(
          'truncate text-xs',
          conversation.isUnread ? 'text-ink-soft' : 'text-ink-faint',
        )}
      >
        {conversation.lastMessagePreview ?? 'No messages yet'}
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        {conversation.isUnread && conversation.unreadCount > 0 ? (
          <Badge tone="accent">{conversation.unreadCount}</Badge>
        ) : null}

        {conversation.isUnlinked ? (
          <Badge tone="warning">
            <Link2Off aria-hidden />
            Unlinked
          </Badge>
        ) : null}

        {conversation.isOptedOut ? <Badge tone="critical">Opted out</Badge> : null}

        {/*
          The countdown on the row, not only inside the conversation. Whoever is
          triaging the list needs to see which reply will stop being possible
          first — that is the ordering decision they are actually making.
        */}
        {closingSoon ? (
          <Badge tone="warning">Closes in {formatRemaining(secondsLeft)}</Badge>
        ) : null}

        {!open && conversation.lastInboundAt ? (
          <Badge tone="neutral">Template only</Badge>
        ) : null}
      </div>
    </button>
  );
}

/**
 * Whether live updates are working.
 *
 * Small and quiet while it is fine, explicit when it is not. A screen that has
 * silently stopped updating looks exactly like a quiet afternoon, and that is
 * how a message sits unanswered for an hour.
 */
function StreamIndicator({ status }: { status: StreamStatus }) {
  if (status === 'live') {
    return (
      <span className="inline-flex items-center gap-1 text-2xs text-ink-faint">
        <Wifi className="size-3 text-positive" aria-hidden />
        <span className="sr-only">Live updates are working</span>
        Live
      </span>
    );
  }

  if (status === 'off') {
    return (
      <span className="inline-flex items-center gap-1 text-2xs font-medium text-critical">
        <WifiOff className="size-3" aria-hidden />
        Not live — reload
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1 text-2xs text-ink-faint">
      <Wifi className="size-3" aria-hidden />
      Connecting…
    </span>
  );
}
