'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { LogOut, Menu, Settings, UserRound, X } from 'lucide-react';
import { ROLE_LABEL } from '@emr/contracts';
import { api } from '@/lib/api-client';
import { useSession } from '@/lib/session';
import { initials } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Sidebar } from './sidebar';
import { Omnibox } from './omnibox';
import { OfflineBanner } from './offline-banner';

/**
 * The authenticated shell.
 *
 * One shell for every clinic role — Front Desk, Doctor and Clinic Admin differ
 * by what the sidebar contains, not by being separate applications. Building
 * three would mean three copies of patient search and three copies of the
 * appointment picker.
 *
 * The Compliance panel is the one exception and lives in its own route group.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const session = useSession();
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  // Badge counts are one cheap call rather than three, and are deliberately
  // polled rather than pushed — the queue is polled anyway.
  const { data: counts } = useQuery({
    queryKey: ['nav-counts'],
    queryFn: () =>
      api.get<{ inbox: number; tasks: number; queue: number }>('/nav/counts'),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const signOut = async () => {
    await api.post('/auth/logout').catch(() => undefined);
    router.push('/login');
  };

  return (
    <div className="flex min-h-dvh bg-canvas">
      {/* Persistent rail on a clinic desktop; 1366×768 is the design target. */}
      <aside className="hidden w-56 shrink-0 border-r border-line bg-surface lg:block">
        <div className="sticky top-0 h-dvh">
          <Sidebar counts={counts} />
        </div>
      </aside>

      {/* Drawer for narrow windows. */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-overlay/50"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
          />
          <div className="absolute inset-y-0 left-0 w-64 border-r border-line bg-surface shadow-modal">
            <div className="flex justify-end p-2">
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close menu"
              >
                <X aria-hidden />
              </Button>
            </div>
            <Sidebar counts={counts} onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <OfflineBanner />

        <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-line bg-surface/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
          <Button
            size="icon"
            variant="ghost"
            className="lg:hidden"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
          >
            <Menu aria-hidden />
          </Button>

          <Omnibox />

          <div className="ml-auto flex items-center gap-1">
            <Button size="icon" variant="ghost" asChild>
              <Link href="/settings/account" aria-label="My account">
                <Settings aria-hidden />
              </Link>
            </Button>

            <div className="flex items-center gap-2 rounded-md px-1.5 py-1">
              <span
                className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-2xs font-semibold text-accent-ink"
                aria-hidden
              >
                {initials(session.fullName)}
              </span>
              <span className="hidden min-w-0 sm:block">
                <span className="block truncate text-xs font-medium text-ink">
                  {session.fullName}
                </span>
                <span className="block truncate text-2xs text-ink-faint">
                  {ROLE_LABEL[session.role]}
                </span>
              </span>
            </div>

            <Button size="icon" variant="ghost" onClick={signOut} aria-label="Sign out">
              <LogOut aria-hidden />
            </Button>
          </div>
        </header>

        {/*
          Two-factor is mandatory for Clinic Admin and Doctor. The grace period
          is surfaced rather than enforced silently, so nobody is locked out
          mid-consultation by a deadline they never saw.
        */}
        {!session.mfaEnabled && session.mfaGraceDaysRemaining !== null ? (
          <div className="border-b border-warning-line bg-warning-soft px-4 py-1.5 text-xs text-warning">
            <UserRound className="mr-1.5 inline size-3.5 align-text-bottom" aria-hidden />
            Two-factor sign-in becomes required in {session.mfaGraceDaysRemaining} days.{' '}
            <Link href="/settings/account" className="font-medium underline">
              Set it up now
            </Link>
          </div>
        ) : null}

        <main id="main" className="min-w-0 flex-1 px-4 py-5 lg:px-6">
          {children}
        </main>
      </div>
    </div>
  );
}
