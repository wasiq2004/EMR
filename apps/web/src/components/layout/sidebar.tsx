'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { navigationFor, PANEL_FOR_ROLE, type BadgeCounts } from '@/lib/nav';
import { PANELS } from '@/lib/panels';
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
  const definition = PANELS[PANEL_FOR_ROLE[session.role]];
  const PanelMark = definition.mark;

  return (
    <div className="flex h-full flex-col">
      {/*
        TOUCHPOINT 1 of 3 — the chip.

        The mark is per panel, not one stethoscope for everybody: it is the
        identity cue that survives greyscale and a bad monitor, which colour
        alone does not. The panel is named directly underneath, so nobody has
        to learn what a colour means.
      */}
      <div className="flex items-center gap-2.5 px-4 py-4">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-md bg-panel text-panel-contrast"
          aria-hidden
        >
          <PanelMark className="size-4" />
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
          <p className="truncate text-2xs font-semibold uppercase tracking-wide text-panel-ink">
            {definition.label}
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
                        // TOUCHPOINT 2 of 3 — where you are, in the panel's
                        // own colour. `aria-current` already carries this for
                        // a screen reader; the bar carries it for everyone
                        // else, and the weight change carries it without
                        // colour at all.
                        active
                          ? 'bg-panel-soft font-medium text-panel-ink shadow-[inset_2px_0_0_0_var(--color-panel)]'
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
