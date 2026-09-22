'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, LayoutDashboard, LogOut, ScrollText, ShieldAlert } from 'lucide-react';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { Providers } from '@/components/providers';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/feedback';

/**
 * The operations console.
 *
 * A separate shell from the clinic application, on purpose. It has a different
 * session, a different cookie and a different backend role, and anything that
 * made them look like one product would invite someone to assume a clinic admin
 * could reach it.
 *
 * `Providers session={null}` because there is no CLINIC session here and never
 * will be. An operator is not a member of any clinic.
 */

export interface Operator {
  id: string;
  fullName: string;
  email: string;
  role: 'SUPPORT' | 'OPERATOR' | 'PLATFORM_ADMIN';
}

const NAV = [
  { href: '/platform', label: 'Overview', icon: LayoutDashboard, exact: true },
  { href: '/platform/tenants', label: 'Clinics', icon: Building2, exact: false },
  { href: '/platform/audit', label: 'Operator log', icon: ScrollText, exact: false },
] as const;

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers session={null}>
      <PlatformShell>{children}</PlatformShell>
    </Providers>
  );
}

function PlatformShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();

  // The sign-in screen is inside this route group but outside the shell: it is
  // the one page that must render without an operator.
  const isLogin = pathname === '/platform/login';

  const me = useQuery({
    queryKey: ['platform', 'me'],
    queryFn: () => api.get<Operator>('/platform/auth/me'),
    enabled: !isLogin,
    retry: false,
  });

  React.useEffect(() => {
    if (isLogin || me.isLoading) return;
    if (me.isError) router.replace('/platform/login');
  }, [isLogin, me.isLoading, me.isError, router]);

  if (isLogin) return <div className="flex min-h-dvh flex-col bg-canvas">{children}</div>;

  if (me.isLoading || !me.data) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }

  const signOut = async () => {
    await api.post('/platform/auth/logout', {}).catch(() => undefined);
    queryClient.clear();
    router.replace('/platform/login');
  };

  return (
    <div className="flex min-h-dvh bg-canvas">
      <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-surface">
        <div className="flex items-center gap-2.5 border-b border-line-soft px-4 py-3.5">
          {/*
            Deliberately not the clinic product's mark. An operator should never
            be in any doubt about which of the two systems they are looking at.
          */}
          <span
            className="flex size-8 items-center justify-center rounded-md bg-ink text-ink-inverse"
            aria-hidden
          >
            <ShieldAlert className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">Operations</p>
            <p className="truncate text-2xs uppercase tracking-wide text-ink-faint">
              {me.data.role.replace('_', ' ')}
            </p>
          </div>
        </div>

        <nav className="flex-1 p-2" aria-label="Console">
          {NAV.map((item) => {
            const active = item.exact
              ? pathname === item.href
              : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'mb-0.5 flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm',
                  'transition-colors duration-[--duration-ui] ease-[--ease-ui]',
                  active
                    ? 'bg-accent-soft font-medium text-accent-ink'
                    : 'text-ink-soft hover:bg-surface-sunk hover:text-ink',
                )}
              >
                <item.icon className="size-4" aria-hidden />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-line-soft p-3">
          <p className="truncate text-xs font-medium text-ink">{me.data.fullName}</p>
          <p className="truncate text-2xs text-ink-faint">{me.data.email}</p>
          <Button size="sm" variant="ghost" onClick={signOut} className="mt-2 w-full">
            <LogOut aria-hidden />
            Sign out
          </Button>
        </div>
      </aside>

      <main id="main" className="min-w-0 flex-1 overflow-y-auto p-6">
        {/*
          Stated on every screen, not buried in documentation. An operator
          looking for a patient should find out here that there is nothing to
          find, rather than concluding the search is broken.
        */}
        <div className="mx-auto mb-5 max-w-5xl rounded-md border border-line-soft bg-surface-sunk px-3 py-2">
          <p className="text-xs text-ink-soft">
            This console holds no patient data. Clinic activity appears here only
            as daily counts — there is no screen, and no query, that reaches a
            medical record.
          </p>
        </div>
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
