'use client';

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import type {
  CommunicationStatus,
  Conversation,
  WhatsappTemplate,
} from '@emr/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-client';
import { useServerEvents, useStreamStatus, type ServerEvent } from '@/lib/server-events';
import { EmptyState } from '@/components/ui/feedback';
import { useConversations } from '@/features/inbox/api';
import { ConversationList, type InboxFilter } from '@/features/inbox/conversation-list';
import { ChatWindow } from '@/features/inbox/chat-window';
import { PatientContextPanel } from '@/features/inbox/patient-context';
import { LinkConversationDialog } from '@/features/inbox/link-dialog';
import { highestStatus } from '@/features/inbox/message-bubble';

/**
 * The patient inbox.
 *
 * Three panes: conversations, the thread, and who the patient is. The third one
 * is the reason this is not a generic chat client — someone answering "is my
 * report ready?" needs the allergy banner and the last visit in the same glance,
 * not a tab away.
 *
 * THE SELECTED CONVERSATION IS NOT IN THE URL. It is component state. A URL
 * carrying a conversation id ends up in browser history, in the referrer of any
 * outbound link, and in every screenshot of a clinic screen — and it identifies
 * a patient. The cost is that a thread cannot be deep-linked, which is a real
 * loss and the right trade here.
 */
export default function InboxPage() {
  const queryClient = useQueryClient();
  const streamStatus = useStreamStatus();

  const [filter, setFilter] = React.useState<InboxFilter>('all');
  const [selected, setSelected] = React.useState<Conversation | null>(null);
  const [contextOpen, setContextOpen] = React.useState(true);
  const [linking, setLinking] = React.useState<Conversation | null>(null);

  /**
   * Live delivery state.
   *
   * Held here rather than in the message list because the events arrive for the
   * whole clinic, including conversations that are not open — switching threads
   * should not lose ticks already seen. Folded with highestStatus so a late
   * `delivered` cannot pull a bubble back from two ticks to one.
   */
  const [statusOverrides, setStatusOverrides] = React.useState<
    Record<string, CommunicationStatus>
  >({});

  const conversations = useConversations(filter);
  const templates = useQuery({
    queryKey: ['whatsapp', 'templates'],
    queryFn: () =>
      api
        .get<{ items: WhatsappTemplate[] }>('/whatsapp/templates')
        .catch(() => ({ items: [] as WhatsappTemplate[] })),
    staleTime: 5 * 60_000,
  });

  const onEvent = React.useCallback(
    (event: ServerEvent) => {
      if (event.type === 'message-status') {
        const messageId = event.data.messageId as string | undefined;
        const status = event.data.status as CommunicationStatus | undefined;
        if (!messageId || !status) return;

        setStatusOverrides((current) => ({
          ...current,
          [messageId]: highestStatus(current[messageId] ?? 'QUEUED', status),
        }));
        return;
      }

      if (event.type === 'message-new' || event.type === 'conversation-changed') {
        // Refetch rather than patching the cache from the payload. The event
        // deliberately carries identifiers only, so the list and the thread are
        // reloaded through the ordinary RLS-scoped endpoints — which is also
        // what keeps a stale client from rendering something it may no longer
        // be entitled to.
        void queryClient.invalidateQueries({ queryKey: ['inbox'] });
        void queryClient.invalidateQueries({ queryKey: ['nav-counts'] });

        const conversationId = event.data.conversationId as string | undefined;
        if (conversationId) {
          void queryClient.invalidateQueries({ queryKey: qk.conversation(conversationId) });
        }
      }
    },
    [queryClient],
  );

  useServerEvents(onEvent);

  // Keep the selected conversation's own row fresh as the list reloads, so the
  // header and the window countdown do not drift from the list beside them.
  // Memoised because it is an effect dependency: `?? []` allocates a new array
  // every render, which would re-run the effect continuously.
  const items = React.useMemo(
    () => conversations.data?.items ?? [],
    [conversations.data],
  );
  React.useEffect(() => {
    if (!selected) return;
    const latest = items.find((c) => c.id === selected.id);
    if (latest && latest !== selected) setSelected(latest);
  }, [items, selected]);

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] min-h-0 overflow-hidden rounded-lg border border-line bg-surface shadow-raise">
      {/*
        On a phone the list and the thread are one pane at a time: 1366×768 is
        the stated design target, but a receptionist checks the inbox on a phone
        between patients and two panes at 375px is neither.
      */}
      <div className={selected ? 'hidden lg:flex' : 'flex w-full lg:w-auto'}>
        <ConversationList
          conversations={items}
          loading={conversations.isLoading}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
          filter={filter}
          onFilterChange={setFilter}
          streamStatus={streamStatus}
        />
      </div>

      {selected ? (
        <ChatWindow
          conversationId={selected.id}
          templates={templates.data?.items ?? []}
          statusOverrides={statusOverrides}
          onBack={() => setSelected(null)}
          contextOpen={contextOpen}
          onToggleContext={() => setContextOpen((open) => !open)}
          onLinkRequested={setLinking}
        />
      ) : (
        <div className="hidden flex-1 items-center justify-center lg:flex">
          <EmptyState
            icon={MessageSquare}
            title="Choose a conversation"
            description="Messages from patients arrive here on the clinic's own number."
          />
        </div>
      )}

      {selected && contextOpen ? (
        <PatientContextPanel
          conversation={selected}
          onLinkRequested={() => setLinking(selected)}
        />
      ) : null}

      <LinkConversationDialog
        conversation={linking}
        onClose={() => setLinking(null)}
        onLinked={() => {
          setLinking(null);
          void queryClient.invalidateQueries({ queryKey: ['inbox'] });
        }}
      />
    </div>
  );
}
