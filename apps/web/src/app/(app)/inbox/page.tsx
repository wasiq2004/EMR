'use client';

import * as React from 'react';
import Link from 'next/link';
import { Inbox, Link2Off, MessageSquare } from 'lucide-react';
import { useConversations } from '@/features/inbox/api';
import { isWindowOpen } from '@emr/contracts';
import { formatPhone, relativeTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel, PanelHeader, PageHeader } from '@/components/ui/surface';
import { EmptyState, SkeletonRows } from '@/components/ui/feedback';

/**
 * The patient inbox.
 *
 * Conversations carry a triage state (open, waiting, closed) and an assignee,
 * because a shared inbox with no owner is a shared inbox nobody answers.
 */
export default function InboxPage() {
  const [filter, setFilter] = React.useState<'all' | 'open'>('all');
  const { data, isLoading } = useConversations(filter);
  const conversations = data?.items ?? [];
  const unlinked = conversations.filter((c) => c.isUnlinked).length;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <PageHeader
        title="Inbox"
        description="Messages from patients, on the clinic's own number."
        actions={
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={filter === 'all' ? 'primary' : 'secondary'}
              onClick={() => setFilter('all')}
            >
              All
            </Button>
            <Button
              size="sm"
              variant={filter === 'open' ? 'primary' : 'secondary'}
              onClick={() => setFilter('open')}
            >
              Needs a reply
            </Button>
          </div>
        }
      />

      {unlinked > 0 ? (
        <Link
          href="/inbox/unlinked"
          className="flex items-center gap-2.5 rounded-md border border-info-line bg-info-soft px-3 py-2 text-sm text-info hover:bg-info-soft/70"
        >
          <Link2Off className="size-4 shrink-0" aria-hidden />
          <span className="flex-1">
            {unlinked} conversation{unlinked === 1 ? '' : 's'} could not be matched to a
            patient
          </span>
          <span className="font-medium">Review →</span>
        </Link>
      ) : null}

      <Panel>
        <PanelHeader title="Conversations" description={`${conversations.length} total`} />
        {isLoading ? (
          <SkeletonRows rows={5} />
        ) : conversations.length === 0 ? (
          <EmptyState icon={Inbox} title="No messages yet" />
        ) : (
          <ul className="divide-y divide-line-soft">
            {conversations.map((conversation) => {
              const open = isWindowOpen(conversation.windowExpiresAt);
              return (
                <li key={conversation.id}>
                  <Link
                    href={`/inbox/${conversation.id}`}
                    className="flex items-start gap-3 px-4 py-3 hover:bg-surface-sunk"
                  >
                    <MessageSquare
                      className="mt-0.5 size-4 shrink-0 text-ink-faint"
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-ink">
                          {conversation.patientName ?? formatPhone(conversation.counterpartyE164)}
                        </span>
                        {conversation.isUnread ? (
                          <Badge tone="accent">{conversation.unreadCount} new</Badge>
                        ) : null}
                        {conversation.isUnlinked ? (
                          <Badge tone="info">Not linked</Badge>
                        ) : null}
                        {conversation.isOptedOut ? (
                          <Badge tone="warning">Opted out</Badge>
                        ) : null}
                        {!open ? <Badge tone="neutral">Window closed</Badge> : null}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-ink-soft">
                        {conversation.lastMessagePreview ?? 'No messages'}
                      </p>
                    </div>
                    <span className="shrink-0 text-2xs text-ink-faint">
                      {relativeTime(conversation.lastInboundAt)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
