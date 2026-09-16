'use client';

import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * Data tables.
 *
 * A clinic desktop is 1366×768 and shows a lot at once, so rows are dense and
 * the header sticks. Every table lives inside its own horizontal scroller so
 * the page body never scrolls sideways — a table that pushes the whole layout
 * off-screen is how a narrow browser window becomes unusable.
 */

export function TableScroller({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('w-full overflow-x-auto scroll-thin', className)} {...props} />
  );
}

export function Table({
  className,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <table
      className={cn('w-full border-collapse text-left text-sm', className)}
      {...props}
    />
  );
}

export function THead({
  className,
  sticky = true,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement> & { sticky?: boolean }) {
  return (
    <thead
      className={cn(
        'bg-surface-sunk',
        sticky && 'sticky top-0 z-10',
        className,
      )}
      {...props}
    />
  );
}

export function TH({
  className,
  align = 'left',
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' }) {
  return (
    <th
      scope="col"
      className={cn(
        'whitespace-nowrap border-b border-line px-3 py-2 text-2xs font-semibold uppercase tracking-wide text-ink-faint',
        align === 'right' && 'text-right',
        className,
      )}
      {...props}
    />
  );
}

export function TBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('divide-y divide-line-soft', className)} {...props} />;
}

export function TR({
  className,
  interactive,
  ...props
}: React.HTMLAttributes<HTMLTableRowElement> & { interactive?: boolean }) {
  return (
    <tr
      className={cn(
        interactive && 'cursor-pointer transition-colors hover:bg-surface-sunk',
        className,
      )}
      {...props}
    />
  );
}

export function TD({
  className,
  align = 'left',
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' }) {
  return (
    <td
      className={cn(
        'px-3 py-2 align-middle text-ink-soft',
        align === 'right' && 'text-right',
        className,
      )}
      {...props}
    />
  );
}

/** Wraps a whole table in a panel with an optional toolbar above it. */
export function TableShell({
  toolbar,
  footer,
  children,
  className,
}: {
  toolbar?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-line bg-surface shadow-raise',
        className,
      )}
    >
      {toolbar ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3 py-2">
          {toolbar}
        </div>
      ) : null}
      <TableScroller className="max-h-[calc(100vh-18rem)]">{children}</TableScroller>
      {footer ? (
        <div className="flex items-center justify-between border-t border-line-soft px-3 py-2 text-xs text-ink-faint">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
