'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Modal dialog.
 *
 * Used sparingly. The consultation screen in particular must not stack modals —
 * a doctor who has to dismiss two layers to see the patient's name will stop
 * using the product. The one place a blocking modal is correct is a safety
 * warning, where interrupting is the entire point.
 */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** Hides the corner close button — for dialogs that demand a decision. */
    mandatory?: boolean;
    size?: 'sm' | 'md' | 'lg';
  }
>(({ className, children, mandatory, size = 'md', ...props }, ref) => {
  const width = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl' }[size];

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          'fixed inset-0 z-50 bg-overlay/50 backdrop-blur-[2px]',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0',
          'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
        )}
      />
      <DialogPrimitive.Content
        ref={ref}
        onInteractOutside={mandatory ? (e) => e.preventDefault() : undefined}
        onEscapeKeyDown={mandatory ? (e) => e.preventDefault() : undefined}
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2',
          'max-h-[calc(100vh-4rem)] overflow-y-auto scroll-thin',
          'rounded-lg border border-line bg-surface shadow-modal',
          width,
          className,
        )}
        {...props}
      >
        {children}
        {!mandatory ? (
          <DialogPrimitive.Close
            className="absolute right-3 top-3 rounded-sm p-1 text-ink-faint hover:bg-surface-sunk hover:text-ink"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});
DialogContent.displayName = 'DialogContent';

export function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex flex-col gap-1 border-b border-line-soft px-5 py-4', className)}
      {...props}
    />
  );
}

export const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-md font-semibold text-ink text-balance', className)}
    {...props}
  />
));
DialogTitle.displayName = 'DialogTitle';

export const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-xs leading-relaxed text-ink-soft', className)}
    {...props}
  />
));
DialogDescription.displayName = 'DialogDescription';

export function DialogBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4', className)} {...props} />;
}

export function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-end gap-2 border-t border-line-soft px-5 py-3',
        className,
      )}
      {...props}
    />
  );
}
