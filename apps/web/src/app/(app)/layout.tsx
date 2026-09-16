'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Providers } from '@/components/providers';
import { AppShell } from '@/components/layout/app-shell';
import { useOptionalSession } from '@/lib/session';
import { Spinner } from '@/components/ui/feedback';

/**
 * The authenticated clinic shell — Front Desk, Doctor and Clinic Admin.
 *
 * Compliance is deliberately NOT in this group. It lives under (compliance)
 * with its own layout and its own component set, so an auditor's screens cannot
 * accidentally import a component that renders patient data.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <RequireSession>
        <AppShell>{children}</AppShell>
      </RequireSession>
    </Providers>
  );
}

function RequireSession({ children }: { children: React.ReactNode }) {
  const { session, isLoading } = useOptionalSession();
  const router = useRouter();

  React.useEffect(() => {
    if (!isLoading && !session) router.replace('/login');
  }, [isLoading, session, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner label="Loading your clinic…" />
      </div>
    );
  }

  if (!session) return null;

  return <>{children}</>;
}
