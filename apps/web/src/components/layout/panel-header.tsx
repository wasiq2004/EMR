'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { PANEL_FOR_ROLE } from '@/lib/nav';
import { PANELS } from '@/lib/panels';
import { useCan, useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/surface';

/**
 * The header every panel's landing screen opens with.
 *
 * WHAT IT REPLACED. The landing led with "Good morning, Priya" and the date,
 * set in the largest type on the screen. That is a greeting, not information:
 * it is identical on the busiest morning of the year and the quietest, and the
 * four role-specific homes underneath it — which are well built — sat below a
 * salutation at equal visual weight.
 *
 * So the heading now names the workspace, and the line under it says what the
 * day currently looks like. The person's name is in the top bar already; it did
 * not need to be the first thing they read.
 *
 * THE SUMMARY IS NEVER FAKED. While counts are loading, or when a panel has
 * nothing cheap to count, the line falls back to what the panel is FOR. It
 * never prints "0 waiting" before the data arrives — on a busy morning that is
 * a lie in the most reassuring possible direction, and the person believes it
 * because it is the first thing on screen.
 */
export function PanelPageHeader({
  summary,
  actions,
}: {
  /** Live state of this panel's work. `null` while loading or unavailable. */
  summary?: string | null;
  /** Extra actions, placed before the panel's primary one. */
  actions?: React.ReactNode;
}) {
  const session = useSession();
  const panel = PANELS[PANEL_FOR_ROLE[session.role]];

  // Hooks cannot be called conditionally, so the permission is always read and
  // the button is what is conditional.
  const mayDoPrimary = useCan(panel.primary?.permission ?? 'clinic:read');
  const primary = panel.primary && mayDoPrimary ? panel.primary : null;

  return (
    <PageHeader
      title={panel.label}
      description={summary ?? panel.purpose}
      actions={
        actions || primary ? (
          <>
            {actions}
            {primary ? (
              /*
                One primary action per panel, in the same corner on every one of
                them. Not a row of equally weighted cards to choose between: the
                thing this role does most should be reachable without reading.
              */
              <Button asChild size="lg">
                <Link href={primary.href}>
                  {primary.label}
                  <ArrowRight aria-hidden />
                </Link>
              </Button>
            ) : null}
          </>
        ) : null
      }
    />
  );
}

/**
 * Joins the parts of a summary line, dropping the ones that are not known yet.
 *
 * Returns `null` rather than an empty string when nothing is known, so the
 * caller falls back to the panel's purpose instead of rendering a bare
 * separator.
 */
export function summarise(...parts: Array<string | null | undefined | false>): string | null {
  const kept = parts.filter((p): p is string => typeof p === 'string' && p.length > 0);
  return kept.length ? kept.join(' · ') : null;
}
