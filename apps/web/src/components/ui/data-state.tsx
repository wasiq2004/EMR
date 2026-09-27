'use client';

import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { EmptyState, ErrorState, SkeletonRows } from './feedback';
import { Panel, PanelBody, PanelHeader } from './surface';
import { cn } from '@/lib/cn';

/**
 * The four states every list in this product can be in.
 *
 * WHY THIS EXISTS. Six panels now read from the same API with the same query
 * library, and before this each screen spelled out its own loading, error and
 * empty branches. They drifted — some showed a spinner, some a skeleton, some
 * nothing; some offered a retry, most did not; several rendered `.map()` over
 * `undefined` on the first paint and relied on optional chaining to survive it.
 *
 * Passing the query through one component makes all four states identical
 * everywhere, and makes the content branch receive a NON-EMPTY, DEFINED array —
 * so a page can never render a list state it did not think about.
 *
 * This is the consistency mechanism, not a convenience wrapper. A new screen gets
 * the right behaviour by default rather than by remembering.
 */

interface QueryLike<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  refetch?: () => void;
}

export function DataState<T>({
  query,
  empty,
  children,
  skeletonRows = 5,
  className,
}: {
  query: QueryLike<T[]>;
  /** What to say when there is genuinely nothing — not an error, not loading. */
  empty: { icon?: LucideIcon; title: string; description?: string; action?: React.ReactNode };
  /** Receives a non-empty array. The empty and undefined cases never reach here. */
  children: (items: T[]) => React.ReactNode;
  skeletonRows?: number;
  className?: string;
}) {
  if (query.isLoading) {
    return <SkeletonRows rows={skeletonRows} className={className} />;
  }

  if (query.isError) {
    return (
      <ErrorState
        description={messageOf(query.error)}
        onRetry={query.refetch}
        className={className}
      />
    );
  }

  const items = query.data ?? [];
  if (items.length === 0) {
    return (
      <EmptyState
        icon={empty.icon}
        title={empty.title}
        description={empty.description}
        action={empty.action}
        className={className}
      />
    );
  }

  return <>{children(items)}</>;
}

/**
 * The same four states for a single record rather than a list.
 *
 * Separate because "not found" and "empty list" are different sentences, and
 * conflating them produces the classic "No items" on a detail page.
 */
export function RecordState<T>({
  query,
  notFound,
  children,
  className,
}: {
  query: QueryLike<T>;
  notFound: { icon?: LucideIcon; title: string; description?: string };
  children: (record: T) => React.ReactNode;
  className?: string;
}) {
  if (query.isLoading) return <SkeletonRows rows={4} className={className} />;

  if (query.isError) {
    return (
      <ErrorState
        description={messageOf(query.error)}
        onRetry={query.refetch}
        className={className}
      />
    );
  }

  if (!query.data) {
    return (
      <EmptyState
        icon={notFound.icon}
        title={notFound.title}
        description={notFound.description}
        className={className}
      />
    );
  }

  return <>{children(query.data)}</>;
}

/**
 * A panel whose body is a list with all four states handled.
 *
 * The most common shape in the product, so it gets a name. Keeps the header
 * visible during loading and error, which matters: a card that vanishes while it
 * loads makes the page jump, and a card that vanishes on error makes the failure
 * invisible.
 */
export function ListPanel<T>({
  title,
  description,
  actions,
  query,
  empty,
  children,
  className,
  skeletonRows = 4,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  query: QueryLike<T[]>;
  empty: { icon?: LucideIcon; title: string; description?: string; action?: React.ReactNode };
  children: (items: T[]) => React.ReactNode;
  className?: string;
  skeletonRows?: number;
}) {
  return (
    <Panel className={className}>
      <PanelHeader title={title} description={description} actions={actions} />
      <PanelBody>
        <DataState query={query} empty={empty} skeletonRows={skeletonRows}>
          {children}
        </DataState>
      </PanelBody>
    </Panel>
  );
}

/**
 * The standard figure row.
 *
 * Four across on a desktop, two on a phone, and never a horizontal scroll —
 * which is what happened when each panel chose its own grid. `Stat` is the atom;
 * this is the only layout it should appear in.
 */
export function StatRow({
  children,
  columns = 4,
  className,
}: {
  children: React.ReactNode;
  columns?: 2 | 3 | 4 | 5;
  className?: string;
}) {
  const cols = {
    2: 'grid-cols-2',
    3: 'grid-cols-2 sm:grid-cols-3',
    4: 'grid-cols-2 lg:grid-cols-4',
    5: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-5',
  }[columns];

  return (
    <Panel className={className}>
      <PanelBody className={cn('grid gap-4', cols)}>{children}</PanelBody>
    </Panel>
  );
}

/**
 * An error message fit to show a person.
 *
 * `ApiError` already carries a sentence written for the reader; anything else gets
 * a generic line rather than a stack trace or "[object Object]", which is what
 * several screens were showing.
 */
function messageOf(error: unknown): string | undefined {
  if (!error) return undefined;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0 && message.length < 300) {
      return message;
    }
  }
  return undefined;
}
