'use client';

import * as React from 'react';
import { Clock, Lock } from 'lucide-react';
import type { WhatsappTemplate } from '@emr/contracts';
import { cn } from '@/lib/cn';
import { Badge } from '@/components/ui/badge';

/**
 * The 24-hour service window.
 *
 * WhatsApp lets a business reply freely for 24 hours after a patient's last
 * message. After that, only an approved template may be sent. This is not our
 * rule and cannot be overridden, so the interface's job is to make the deadline
 * visible BEFORE it passes rather than explaining a rejection afterwards.
 *
 * Hence a live countdown rather than an expiry timestamp. "Closes in 47m" tells
 * a receptionist to answer now; "expires at 14:12" makes them do arithmetic
 * while a patient waits.
 */

export function useWindowCountdown(expiresAt: string | null): {
  open: boolean;
  secondsLeft: number;
} {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!expiresAt) return undefined;
    // Once a second. The value shown changes by the minute for most of the
    // window, but the last minute counts down in seconds and that is the part
    // anyone is watching.
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  if (!expiresAt) return { open: false, secondsLeft: 0 };

  const secondsLeft = Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000));
  return { open: secondsLeft > 0, secondsLeft };
}

export function formatRemaining(seconds: number): string {
  if (seconds <= 0) return 'closed';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

export function WindowBar({
  expiresAt,
  templates,
  optedOut,
}: {
  expiresAt: string | null;
  templates: WhatsappTemplate[];
  optedOut: boolean;
}) {
  const { open, secondsLeft } = useWindowCountdown(expiresAt);

  if (optedOut) {
    return (
      <Bar tone="critical">
        <Lock className="size-3.5" aria-hidden />
        <span>
          This patient has opted out of messages. Print a copy or send a secure
          link instead — there is no clinical override for an opt-out.
        </span>
      </Bar>
    );
  }

  if (!open) {
    const approved = templates.filter((t) => t.status === 'APPROVED');

    return (
      <Bar tone="warning">
        <Lock className="size-3.5" aria-hidden />
        <span>
          The 24-hour reply window has closed.{' '}
          {approved.length > 0
            ? 'Choose an approved template to reach this patient.'
            : 'No approved template is available, so this patient cannot be messaged until they write again.'}
        </span>
      </Bar>
    );
  }

  // Under an hour is the point at which a reply stops being something to get to
  // later, so the bar changes colour rather than only changing its number.
  const urgent = secondsLeft < 3600;

  return (
    <Bar tone={urgent ? 'warning' : 'neutral'}>
      <Clock className="size-3.5" aria-hidden />
      <span>
        You can reply freely for{' '}
        <strong className="tabular">{formatRemaining(secondsLeft)}</strong>.
      </span>
      {urgent ? <Badge tone="warning">Closing soon</Badge> : null}
    </Bar>
  );
}

function Bar({
  tone,
  children,
}: {
  tone: 'neutral' | 'warning' | 'critical';
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 border-b px-4 py-2 text-xs',
        tone === 'neutral' && 'border-line-soft bg-surface-sunk text-ink-soft',
        tone === 'warning' && 'border-warning-line bg-warning-soft text-warning',
        tone === 'critical' && 'border-critical-line bg-critical-soft text-critical',
      )}
    >
      {children}
    </div>
  );
}
