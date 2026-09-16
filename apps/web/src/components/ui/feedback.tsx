'use client';

import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from './button';

/**
 * Alerts, empty states and loading.
 *
 * An error message names what went wrong and what to do next. No apologies, no
 * "something went wrong", no raw status codes — a receptionist mid-rush needs
 * an instruction, not a diagnosis.
 */

type Tone = 'info' | 'warning' | 'critical' | 'positive';

const TONE: Record<Tone, { icon: LucideIcon; wrap: string; icon_: string }> = {
  info: {
    icon: Info,
    wrap: 'border-info-line bg-info-soft text-info',
    icon_: 'text-info',
  },
  warning: {
    icon: AlertTriangle,
    wrap: 'border-warning-line bg-warning-soft text-warning',
    icon_: 'text-warning',
  },
  critical: {
    icon: ShieldAlert,
    wrap: 'border-critical-line bg-critical-soft text-critical',
    icon_: 'text-critical',
  },
  positive: {
    icon: CheckCircle2,
    wrap: 'border-positive-line bg-positive-soft text-positive',
    icon_: 'text-positive',
  },
};

export function Alert({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: Tone;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  const config = TONE[tone];
  const Icon = config.icon;

  return (
    <div
      role={tone === 'critical' ? 'alert' : 'status'}
      className={cn('flex gap-3 rounded-md border p-3', config.wrap, className)}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', config.icon_)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        {children ? (
          <div className="mt-0.5 text-xs leading-relaxed opacity-90">{children}</div>
        ) : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-12 text-center',
        className,
      )}
    >
      {Icon ? <Icon className="size-6 text-ink-faint" aria-hidden /> : null}
      <p className="text-sm font-medium text-ink">{title}</p>
      {description ? (
        <p className="max-w-sm text-xs text-ink-faint">{description}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/**
 * Shown when a read fails. Offers the retry rather than asking the user to
 * reload the whole page and lose their place.
 */
export function ErrorState({
  title = 'That did not load',
  description,
  onRetry,
  className,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div className={cn('p-4', className)}>
      <Alert
        tone="critical"
        title={title}
        action={
          onRetry ? (
            <Button size="sm" variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          ) : undefined
        }
      >
        {description ?? 'Check your connection and try again.'}
      </Alert>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('animate-pulse rounded-sm bg-surface-sunk', className)}
      aria-hidden
    />
  );
}

/** Rows of skeleton, sized to the table they stand in for. */
export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2 p-4', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-ink-faint">
      <Loader2 className="size-3.5 animate-spin" aria-hidden />
      <span>{label}</span>
    </span>
  );
}

/**
 * The saved indicator on autosaving screens. Says the state plainly so a doctor
 * never wonders whether the note is safe.
 */
export function SaveState({
  state,
  savedAt,
}: {
  state: 'idle' | 'saving' | 'saved' | 'offline' | 'error';
  savedAt?: number | null;
}) {
  if (state === 'saving') return <Spinner label="Saving…" />;

  if (state === 'offline') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-warning">
        <AlertTriangle className="size-3.5" aria-hidden />
        Saved on this device
      </span>
    );
  }

  if (state === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-critical">
        <ShieldAlert className="size-3.5" aria-hidden />
        Not saved — will retry
      </span>
    );
  }

  if (state === 'saved') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-ink-faint">
        <CheckCircle2 className="size-3.5 text-positive" aria-hidden />
        Saved
        {savedAt ? ` ${new Date(savedAt).toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
        })}` : ''}
      </span>
    );
  }

  return null;
}
