'use client';

import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '@/lib/cn';

/**
 * Form fields.
 *
 * Labels are always visible. A placeholder is not a label — it disappears the
 * moment someone types, which is exactly when they need to check what they are
 * filling in. Errors sit next to the field they belong to, not collected at the
 * top of the form, and say what to do rather than what is wrong.
 */

export const Label = React.forwardRef<
  React.ComponentRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & { required?: boolean }
>(({ className, children, required, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn('text-xs font-medium text-ink-soft', className)}
    {...props}
  >
    {children}
    {required ? (
      <span className="text-critical" aria-hidden>
        {' '}
        *
      </span>
    ) : null}
  </LabelPrimitive.Root>
));
Label.displayName = 'Label';

const inputBase =
  'w-full rounded-md border border-line bg-surface px-2.5 text-ink ' +
  'placeholder:text-ink-faint transition-colors ' +
  'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunk disabled:text-ink-faint ' +
  'aria-[invalid=true]:border-critical aria-[invalid=true]:ring-critical/20';

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(inputBase, 'h-9 text-sm', className)} {...props} />
));
Input.displayName = 'Input';

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(inputBase, 'min-h-20 resize-y py-2 text-sm leading-relaxed', className)}
    {...props}
  />
));
Textarea.displayName = 'Textarea';

/** Native select. Faster to operate by keyboard than a custom listbox. */
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select ref={ref} className={cn(inputBase, 'h-9 pr-8 text-sm', className)} {...props}>
    {children}
  </select>
));
Select.displayName = 'Select';

export interface FieldProps {
  label: string;
  htmlFor: string;
  required?: boolean;
  /** Guidance shown before the user makes a mistake, not after. */
  hint?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}

export function Field({
  label,
  htmlFor,
  required,
  hint,
  error,
  className,
  children,
}: FieldProps) {
  const hintId = hint ? `${htmlFor}-hint` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={htmlFor} required={required}>
        {label}
      </Label>
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
            id: htmlFor,
            'aria-invalid': error ? true : undefined,
            'aria-describedby':
              [hintId, errorId].filter(Boolean).join(' ') || undefined,
          })
        : children}
      {hint && !error ? (
        <p id={hintId} className="text-2xs text-ink-faint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-2xs font-medium text-critical">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Groups related fields with a heading, for longer settings forms. */
export function FieldSet({
  legend,
  description,
  children,
  className,
}: {
  legend: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={cn('flex flex-col gap-3', className)}>
      <div>
        <legend className="text-sm font-semibold text-ink">{legend}</legend>
        {description ? (
          <p className="mt-0.5 text-xs text-ink-faint">{description}</p>
        ) : null}
      </div>
      {children}
    </fieldset>
  );
}
