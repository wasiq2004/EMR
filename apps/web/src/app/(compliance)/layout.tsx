'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { LogOut, ShieldCheck } from 'lucide-react';
import type { Route } from 'next';
import { Providers } from '@/components/providers';
import { useOptionalSession } from '@/lib/session';
import { api } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/feedback';

/**
 * ====================== THE COMPLIANCE PANEL ================================
 *
 * The one place the single-application rule is broken deliberately.
 *
 * An auditor reads the trail, never the patient. An audit role with access to
 * clinical content defeats the purpose of having the role at all — so this
 * surface is built from its own layout and its own component set, and imports
 * NOTHING from the patient, encounter or prescribing features.
 *
 * That isolation is the point. Filtering a shared layout by role would leave
 * this screen one prop away from rendering a patient record; a separate route
 * group means the components simply are not here.
 *
 * The API enforces the same boundary independently: reports served to an
 * auditor are aggregate-only by response contract, not by what this UI asks
 * for.
 * ===========================================================================
 */
export default function ComplianceLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      <ComplianceShell>{children}</ComplianceShell>
    </Providers>
  );
}

function ComplianceShell({ children }: { children: React.ReactNode }) {
  const { session, isLoading } = useOptionalSession();
  const router = useRouter();
  const pathname = usePathname();

  React.useEffect(() => {
    if (!isLoading && !session) router.replace('/login');
  }, [isLoading, session, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas">
        <Spinner label="Loading" />
      </div>
    );
  }
  if (!session) return null;

  const tabs: { href: Route; label: string }[] = [
    { href: '/audit', label: 'Activity log' },
    { href: '/audit/reports', label: 'Aggregate reports' },
  ];

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3">
          <span
            className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-contrast"
            aria-hidden
          >
            <ShieldCheck className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-ink">
              {session.clinicName}
            </p>
            <p className="text-2xs text-ink-faint">Compliance · {session.fullName}</p>
          </div>

          <Button
            size="icon"
            variant="ghost"
            className="ml-auto"
            aria-label="Sign out"
            onClick={async () => {
              await api.post('/auth/logout').catch(() => undefined);
              router.push('/login');
            }}
          >
            <LogOut aria-hidden />
          </Button>
        </div>

        <nav className="mx-auto flex max-w-5xl gap-1 px-4" aria-label="Compliance">
          {tabs.map((tab) => {
            const active = pathname === tab.href;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                  active
                    ? 'border-accent text-ink'
                    : 'border-transparent text-ink-faint hover:text-ink',
                )}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </header>

      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-5">
        {children}
      </main>
    </div>
  );
}
