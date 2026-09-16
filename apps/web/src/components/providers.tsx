'use client';

import * as React from 'react';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { TooltipProvider } from '@radix-ui/react-tooltip';
import type { Session } from '@emr/contracts';
import { createQueryClient, persistOptions } from '@/lib/query-client';
import { startOutboxWorker } from '@/lib/outbox';
import { SessionProvider } from '@/lib/session';
import { ToastProvider } from './ui/toast';

/**
 * Client-side providers.
 *
 * The query client is created once per browser session and its cache is
 * persisted to IndexedDB, so a dropout mid-consultation shows the last known
 * record rather than a spinner. The outbox worker replays queued mutations when
 * the connection comes back.
 */
export function Providers({
  children,
  session,
}: {
  children: React.ReactNode;
  session?: Session | null;
}) {
  const [queryClient] = React.useState<QueryClient>(() => createQueryClient());

  React.useEffect(() => startOutboxWorker(), []);

  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <SessionProvider initialSession={session}>
        <TooltipProvider delayDuration={300}>
          <ToastProvider>{children}</ToastProvider>
        </TooltipProvider>
      </SessionProvider>
    </PersistQueryClientProvider>
  );
}
