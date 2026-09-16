'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * Surfaces.
 *
 * Border, fill, radius and shadow each say "separate object", so they are spent
 * by role rather than stamped on every block. A dense clinical screen that
 * wraps everything in an identical card flattens the hierarchy and makes the
 * one thing that matters — the allergy panel — look like everything else.
 */

export function Panel({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'rounded-lg border border-line bg-surface shadow-raise',
        className,
      )}
      {...props}
    />
  );
}

export function PanelHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-3 border-b border-line-soft px-4 py-3',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-xs text-ink-faint">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PanelBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...props} />;
}

/** A page-level heading block. One per screen. */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumb?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('flex flex-col gap-3', className)}>
      {breadcrumb}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-ink text-balance">
            {title}
          </h1>
          {description ? (
            <p className="mt-1 max-w-prose text-sm text-ink-soft">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </header>
  );
}

/** Label/value pairs that line up down a column. */
export function DataList({
  items,
  className,
  columns = 2,
}: {
  items: { label: string; value: React.ReactNode }[];
  className?: string;
  columns?: 1 | 2 | 3;
}) {
  const cols =
    columns === 1
      ? 'grid-cols-1'
      : columns === 2
        ? 'grid-cols-1 sm:grid-cols-2'
        : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';

  return (
    <dl className={cn('grid gap-x-6 gap-y-3', cols, className)}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-2xs uppercase tracking-wide text-ink-faint">
            {item.label}
          </dt>
          <dd className="mt-0.5 text-sm text-ink break-words">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A figure with its label. Used sparingly — only where the number is the point. */
export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: 'neutral' | 'critical' | 'warning' | 'positive';
}) {
  const valueTone = {
    neutral: 'text-ink',
    critical: 'text-critical',
    warning: 'text-warning',
    positive: 'text-positive',
  }[tone];

  return (
    <div className="min-w-0">
      <p className="text-2xs uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={cn('mt-1 text-2xl font-semibold tabular', valueTone)}>{value}</p>
      {hint ? <p className="mt-0.5 text-2xs text-ink-faint">{hint}</p> : null}
    </div>
  );
}

export function Separator({ className }: { className?: string }) {
  return <hr className={cn('border-0 border-t border-line-soft', className)} />;
}
