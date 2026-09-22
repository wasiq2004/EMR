'use client';

import * as React from 'react';
import { Slot, Slottable } from '@radix-ui/react-slot';
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
    // Colour AND shadow, on the shared motion token. A button whose fill moves
    // while its shadow snaps is the small wrongness that reads as unfinished.
    'transition-[color,background-color,border-color,box-shadow] duration-[--duration-ui] ease-[--ease-ui] ' +
    'select-none ' +
    // Pressed state. 1px is enough to feel like the control took the press;
    // anything more moves the label and reads as a glitch.
    'active:translate-y-px ' +
    'disabled:pointer-events-none disabled:opacity-50 ' +
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-accent text-accent-contrast hover:bg-accent-hover shadow-raise hover:shadow-pop',
        secondary:
          'bg-surface text-ink border border-line hover:bg-surface-sunk hover:border-line-strong shadow-raise',
        ghost: 'text-ink-soft hover:bg-surface-sunk hover:text-ink',
        /** Destructive and irreversible. Used for finalise, revoke, delete. */
        critical:
          'bg-critical text-critical-contrast hover:opacity-90 shadow-raise hover:shadow-pop',
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
    /*
     * `Slottable` is load-bearing, not decoration.
     *
     * Slot merges this component's props onto a single child element and
     * requires exactly one. A spinner rendered as a sibling of `children`
     * gives it two, and it throws even when the spinner is null, because the
     * array still has two entries. Marking `children` as the slottable one
     * tells Slot which element to merge into and renders the spinner inside
     * it, so `<Button asChild><Link/></Button>` works and keeps its loading
     * state.
     *
     * These two children must be written inline. Wrapping them in a fragment
     * hands Slot the fragment as its single child, and it then tries to put
     * `className` on a `React.Fragment`.
     */
    if (asChild) {
      return (
        <Slot
          ref={ref}
          className={cn(button({ variant, size }), className)}
          // `disabled` is not a valid attribute on an anchor, which is what
          // asChild almost always wraps. State it accessibly instead.
          aria-disabled={disabled || loading || undefined}
          aria-busy={loading || undefined}
          {...props}
        >
          {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
          <Slottable>{children}</Slottable>
        </Slot>
      );
    }

    return (
      <button
        ref={ref}
        className={cn(button({ variant, size }), className)}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {children}
      </button>
    );
  },
);
Button.displayName = 'Button';

export { button as buttonVariants };
