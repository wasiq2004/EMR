'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { Route } from 'next';
import { cn } from '@/lib/cn';

export const Tabs = TabsPrimitive.Root;

export const TabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn('flex items-center gap-1 border-b border-line', className)}
    {...props}
  />
));
TabsList.displayName = 'TabsList';

export const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'relative -mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-ink-faint',
      'transition-colors hover:text-ink',
      'data-[state=active]:border-accent data-[state=active]:text-ink',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = 'TabsTrigger';

export const TabsContent = TabsPrimitive.Content;

/**
 * Route-backed tabs.
 *
 * The patient record uses real routes rather than local tab state so a
 * particular tab can be linked to, opened in a second window, and survives a
 * reload — all three of which happen constantly at a front desk.
 */
export function RouteTabs({
  items,
  className,
}: {
  items: { label: string; href: string; exact?: boolean }[];
  className?: string;
}) {
  const pathname = usePathname();

  return (
    <nav className={cn('flex items-center gap-1 overflow-x-auto border-b border-line scroll-thin', className)}>
      {items.map((item) => {
        const active = item.exact
          ? pathname === item.href
          : pathname === item.href || pathname.startsWith(`${item.href}/`);

        return (
          <Link
            key={item.href}
            /*
             * Cast once, here. Typed routes cannot narrow a template literal
             * built from a runtime id, and every href reaching this component
             * is composed from a route the build has already validated.
             */
            href={item.href as Route}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative -mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'border-accent text-ink'
                : 'border-transparent text-ink-faint hover:text-ink',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
