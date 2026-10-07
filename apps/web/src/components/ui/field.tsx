'use client';

import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';
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
  'w-full rounded-md border border-line-control bg-surface px-2.5 text-ink ' +
  'placeholder:text-ink-faint transition-colors ' +
  'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunk disabled:text-ink-faint ' +
  'aria-[invalid=true]:border-critical aria-[invalid=true]:ring-critical/20';

/**
 * A password field with a reveal toggle.
 *
 * ONE COMPONENT FOR ALL SIX, for the same reason `CredentialReveal` is shared
 * across the three flows that mint a credential: the handling rules are
 * identical, and writing them out six times is how one of them ends up without
 * the auto-hide or with a button that submits the form.
 *
 * WHY A REVEAL AT ALL. There is no self-service password reset in this product —
 * no mail provider is connected — so a password is issued by an administrator
 * and read out, or typed from something written down. That is exactly the
 * situation where a typo is invisible and the only feedback is "email or
 * password is incorrect", which does not say which. Worse, the issued passwords
 * are base64url: they mix l/I/1 and O/0 and carry hyphens and underscores, so
 * "I typed it right" and "I typed it wrong" feel the same.
 *
 * IT HIDES ITSELF AGAIN AFTER `revealSeconds`. A clinic reception terminal has
 * patients standing at it, and the failure this guards is not someone reading
 * over a shoulder during the two seconds it takes to check a password — it is
 * the receptionist who reveals it, gets called away mid-sign-in, and leaves a
 * credential in plaintext on a screen facing the waiting room. Twenty seconds
 * is long enough that nobody checking their typing ever sees it expire, and
 * short enough that walking away does not leave it up.
 *
 * `type="button"` IS LOAD-BEARING. A button inside a form defaults to submit, so
 * without it the toggle would attempt a sign-in with a half-typed password,
 * burn a failed-login attempt against the lockout counter, and re-render the
 * form.
 */
export const PasswordInput = React.forwardRef<
  HTMLInputElement,
  // `type` is ours to control. Everything else — including the `id`,
  // `aria-invalid` and `aria-describedby` that `Field` clones onto its child —
  // is forwarded to the real input untouched.
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & {
    /** Seconds before it re-hides itself. 0 disables the timer. */
    revealSeconds?: number;
  }
>(({ className, revealSeconds = 20, disabled, ...props }, ref) => {
  const [shown, setShown] = React.useState(false);

  React.useEffect(() => {
    if (!shown || revealSeconds <= 0) return;
    const timer = window.setTimeout(() => setShown(false), revealSeconds * 1000);
    return () => window.clearTimeout(timer);
  }, [shown, revealSeconds]);

  return (
    <div className="relative">
      <input
        ref={ref}
        type={shown ? 'text' : 'password'}
        disabled={disabled}
        /*
         * `pr-10` keeps the value clear of the button. Without it a long
         * password runs underneath and the last characters — the ones most
         * likely to be mistyped — are the ones you cannot see.
         */
        className={cn(inputBase, 'h-9 pr-10 text-sm', className)}
        {...props}
      />
      <button
        type="button"
        /*
         * Not aria-hidden and not tabIndex={-1}: somebody working the keyboard
         * has the same reason to check what they typed as somebody with a mouse.
         * It sits after the input in the tab order, which is where it belongs.
         */
        onClick={() => setShown((current) => !current)}
        disabled={disabled}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        title={shown ? 'Hide password' : 'Show password'}
        className={cn(
          'absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md',
          'text-ink-faint transition-colors hover:text-ink',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25',
          'disabled:cursor-not-allowed disabled:hover:text-ink-faint',
        )}
      >
        {shown ? (
          <EyeOff className="size-4" aria-hidden />
        ) : (
          <Eye className="size-4" aria-hidden />
        )}
      </button>
    </div>
  );
});
PasswordInput.displayName = 'PasswordInput';

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

  /* Always three children: label, control, footer. See the footer below. */
  return (
    <div data-field className={cn('flex flex-col gap-1.5', className)}>
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
      {error ? (
        /*
         * The error REPLACES the hint rather than joining it. Showing both puts
         * the sentence telling somebody what to do underneath the sentence
         * telling them they got it wrong, and the lower one is the one that
         * gets read.
         */
        <p id={errorId} className="text-2xs font-medium text-critical">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-2xs text-ink-faint">
          {hint}
        </p>
      ) : (
        /*
         * An empty third row. `subgrid` can only align fields against each
         * other if every field contributes the same number of rows — a field
         * that sometimes emits two and sometimes three would align on some
         * rows of a form and not others, which reads as a bug rather than as
         * no alignment at all. It has no content and no padding, so outside a
         * FieldGrid it occupies nothing.
         */
        <span aria-hidden />
      )}
    </div>
  );
}

/**
 * A grid of fields whose labels, controls and hints line up across columns.
 *
 * THE BUG THIS EXISTS FOR. Put "Medical registration number" and "Medical
 * council" side by side in a two-column grid at 640px and the first label
 * wraps onto a second line while the second does not. Each cell is its own
 * column of [label, control, hint], so the taller label pushes its input down
 * and the two inputs sit on different baselines — a few pixels out, across a
 * form somebody fills in twenty times a day.
 *
 * It is not fixable by shortening labels: the same form is used at 1366×768
 * and on a tablet, and whichever width you tune the wording for, the other one
 * wraps. `subgrid` removes the question — every field shares the grid's rows,
 * so all labels occupy one row and all controls the next, aligned by
 * construction.
 *
 * Use this anywhere two or more `Field`s sit side by side. A single-column
 * stack does not need it.
 */
export function FieldGrid({
  columns = 2,
  className,
  children,
}: {
  columns?: 1 | 2 | 3;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'field-grid grid',
        // Single column below `sm` regardless: two columns of inputs on a
        // phone are narrower than the text they have to hold.
        columns === 2 && 'sm:grid-cols-2',
        columns === 3 && 'sm:grid-cols-2 lg:grid-cols-3',
        className,
      )}
    >
      {children}
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
