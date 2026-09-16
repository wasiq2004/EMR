'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

/**
 * State is encoded in shape and word as well as colour. Colour alone is not an
 * accessible signal, and in this product several badges carry clinical meaning
 * — an allergy chip is not decoration.
 */
const badge = cva(
  'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-2xs font-medium ' +
    'whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'border-line bg-surface-sunk text-ink-soft',
        accent: 'border-accent/30 bg-accent-soft text-accent-ink',
        critical: 'border-critical-line bg-critical-soft text-critical',
        warning: 'border-warning-line bg-warning-soft text-warning',
        positive: 'border-positive-line bg-positive-soft text-positive',
        info: 'border-info-line bg-info-soft text-info',
        chronic: 'border-chronic/30 bg-chronic-soft text-chronic',
        /** Loud. Reserved for a HIGH-criticality allergy. */
        alarm: 'border-critical bg-critical text-critical-contrast',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badge> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}

/** A small dot used in lists where a full badge would be too heavy. */
export function StatusDot({
  tone = 'neutral',
  label,
}: {
  tone?: 'neutral' | 'critical' | 'warning' | 'positive' | 'info' | 'accent';
  label: string;
}) {
  const colour = {
    neutral: 'bg-ink-faint',
    critical: 'bg-critical',
    warning: 'bg-warning',
    positive: 'bg-positive',
    info: 'bg-info',
    accent: 'bg-accent',
  }[tone];

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('size-1.5 shrink-0 rounded-full', colour)} aria-hidden />
      <span>{label}</span>
    </span>
  );
}
