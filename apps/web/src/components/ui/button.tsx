'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Every control says exactly what happens when you press it. The label is the
 * verb — "Sign & finalise", not "Submit" — because the confirmation dialog it
 * opens has to make sense on its own.
 *
 * Minimum height is 36px for dense table rows and 40px elsewhere; the hit area
 * is padded to 44px via `.tap-target` wherever the visual control is smaller.
 */
const button = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium ' +
    'transition-colors select-none ' +
    'disabled:pointer-events-none disabled:opacity-50 ' +
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-accent text-accent-contrast hover:bg-accent-hover shadow-raise',
        secondary:
          'bg-surface text-ink border border-line hover:bg-surface-sunk shadow-raise',
        ghost: 'text-ink-soft hover:bg-surface-sunk hover:text-ink',
        /** Destructive and irreversible. Used for finalise, revoke, delete. */
        critical:
          'bg-critical text-critical-contrast hover:opacity-90 shadow-raise',
        /** Reads as a link but behaves as a button. */
        link: 'text-accent underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-2.5 text-xs [&_svg]:size-3.5',
        md: 'h-9 px-3 text-sm [&_svg]:size-4',
        lg: 'h-10 px-4 text-md [&_svg]:size-4',
        icon: 'size-9 [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  asChild?: boolean;
  /** Shows a spinner and blocks repeat presses. */
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, loading, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        ref={ref}
        className={cn(button({ variant, size }), className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {children}
      </Comp>
    );
  },
);
Button.displayName = 'Button';

export { button as buttonVariants };
