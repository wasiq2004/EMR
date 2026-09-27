'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Stethoscope } from 'lucide-react';
import { navigationFor, PANEL_FOR_ROLE, PANEL_LABEL, type BadgeCounts } from '@/lib/nav';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';

/**
 * The panel sidebar.
 *
 * Which panel a user sees is derived from their role, and every link is gated
 * on the permission the screen behind it needs. There is no hard-coded list per
 * role — that would drift from the matrix the first time someone changed a
 * permission without remembering the sidebar existed.
 */
export function Sidebar({
  counts,
  onNavigate,
}: {
  counts?: BadgeCounts;
  onNavigate?: () => void;
}) {
  const session = useSession();
  const pathname = usePathname();
  const sections = React.useMemo(() => navigationFor(session.role), [session.role]);
  const panel = PANEL_FOR_ROLE[session.role];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-contrast"
          aria-hidden
        >
          <Stethoscope className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">
            {session.clinicName}
          </p>
          {/*
            The panel, not the role. The role is shown beside the user's name in
            the top bar, where it belongs — it describes the person, not the
            workspace. Printing both here produced "Doctor · Doctor".
          */}
          <p className="truncate text-2xs font-medium uppercase tracking-wide text-ink-faint">
            {PANEL_LABEL[panel]}
          </p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto scroll-thin px-2 pb-4" aria-label="Main">
        {sections.map((section, index) => (
          <div key={section.title ?? `section-${index}`} className="mb-4">
            {section.title ? (
              <p className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wide text-ink-faint">
                {section.title}
              </p>
            ) : null}
            <ul className="flex flex-col gap-0.5">
              {section.items.map((item) => {
                const active =
                  pathname === item.href ||
                  (item.href !== '/today' && pathname.startsWith(`${item.href}/`));
                const Icon = item.icon;
                const count = item.badgeKey ? counts?.[item.badgeKey] : undefined;

                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-2.5 rounded-md px-2 py-2 text-sm transition-colors',
                        active
                          ? 'bg-accent-soft font-medium text-accent-ink'
                          : 'text-ink-soft hover:bg-surface-sunk hover:text-ink',
                      )}
                    >
                      <Icon className="size-4 shrink-0" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {count && count > 0 ? (
                        <Badge tone={active ? 'accent' : 'neutral'}>{count}</Badge>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}
