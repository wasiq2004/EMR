'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Conversation, Message } from '@emr/contracts';
import { api, idempotencyKey } from '@/lib/api-client';
import { qk } from '@/lib/query-client';

export function useConversations(filter: 'all' | 'open' | 'unlinked') {
  return useQuery({
    queryKey: qk.conversations(filter),
    queryFn: () =>
      api.get<{ items: Conversation[] }>('/inbox/conversations', {
        query: { filter: filter === 'all' ? undefined : filter },
      }),
    refetchInterval: 20_000,
  });
}

export function useConversation(id: string) {
  return useQuery({
    queryKey: qk.conversation(id),
    queryFn: () =>
      api.get<{ conversation: Conversation; messages: Message[] }>(
        `/inbox/conversations/${id}`,
      ),
    enabled: Boolean(id),
    refetchInterval: 15_000,
  });
}

/**
 * Sending a reply.
 *
 * The caller does not choose between a free-form message and a template — the
 * composer resolves the service window and tells the user what will be sent.
 * An idempotency key is attached because a retried request must not message the
 * patient twice.
 */
export function useSendReply(conversationId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { body: string; templateName?: string | null }) =>
      api.post<Message>(
        `/inbox/conversations/${conversationId}/reply`,
        { ...input, idempotencyKey: idempotencyKey() },
        { idempotencyKey: idempotencyKey() },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.conversation(conversationId) });
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });
    },
  });
}

export function useLinkConversation(conversationId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (patientId: string) =>
      api.post(`/inbox/conversations/${conversationId}/link`, { patientId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });
      void queryClient.invalidateQueries({ queryKey: ['nav-counts'] });
    },
  });
}
