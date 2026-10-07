'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Activity, FlaskConical, PillBottle, ShieldCheck, Stethoscope } from 'lucide-react';
import { LoginInput } from '@emr/contracts';
import { ApiError, api } from '@/lib/api-client';
import { useTilt } from '@/features/auth/tilt';
import { Button } from '@/components/ui/button';
import { Field, Input, PasswordInput } from '@/components/ui/field';
import { Alert } from '@/components/ui/feedback';

/**
 * Sign in.
 *
 * WHAT THIS SCREEN IS FOR, which decided every choice below: a receptionist
 * opens it at 8:40am with people already at the desk, and a doctor opens it
 * between consultations. It is used more often than any other screen in the
 * product and is looked at for about four seconds at a time. So the brief is
 * not "impress a visitor" — it is "feel like a product somebody paid for, and
 * get out of the way".
 *
 * That rules a few things out, and they are worth naming because they are the
 * obvious ways to make a sign-in screen look expensive:
 *
 *   - NO BACKGROUND VIDEO OR GIF. A looping clinic photo is a megabyte or more
 *     on the first screen of the day, on a connection that is frequently a
 *     clinic's ADSL line, and it cannot adapt to dark mode. The depth here is
 *     two blurred radial gradients and a grid, which cost nothing and are
 *     resolution-independent.
 *   - NO ANIMATION LIBRARY. GSAP or Framer Motion is 30–120 KB of JavaScript
 *     before anybody can type a password. Eight CSS keyframes do this.
 *   - NO STOCK PHOTOGRAPHY OF SMILING CLINICIANS. It dates immediately, it is
 *     never the clinic's own staff, and every competitor has the same one.
 *
 * The 3D is real but small: `perspective` on the wrapper and a pointer-driven
 * `rotate3d` on the card, which is a composited transform and therefore free.
 * It switches itself off for touch and for reduced motion.
 *
 * THE TENANT is resolved from the host, not from anything typed here — email is
 * unique per clinic, not globally, so two clinics can both have
 * admin@example.com. A deployment on its own domain resolves across clinics
 * instead; see `clinic-host.ts`.
 *
 * There is no password-reset endpoint, so this screen points at the clinic
 * administrator rather than offering a link that goes nowhere.
 */
export default function LoginPage() {
  const router = useRouter();
  const [formError, setFormError] = React.useState<string | null>(null);
  const card = useTilt<HTMLDivElement>();

  const form = useForm({
    resolver: zodResolver(LoginInput),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      const result = await api.post<{ mfaRequired: boolean }>('/auth/login', values);
      router.push(result.mfaRequired ? '/login/mfa' : '/today');
    } catch (error) {
      setFormError(
        error instanceof ApiError
          ? error.message
          : 'Could not sign in. Check your connection and try again.',
      );
    }
  });

  return (
    <div className="relative flex min-h-dvh flex-1 overflow-hidden bg-canvas">
      <Backdrop />

      {/*
        max-w-5xl, not 6xl. At 6xl on a 1440px screen the two columns drift to
        opposite edges and the eye has to travel across empty centre to get from
        the product name to the password field. 5xl keeps them reading as one
        composition.
      */}
      <div className="relative z-10 mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center gap-12 px-4 py-10 lg:flex-row lg:items-center lg:gap-14 lg:py-16">
        <BrandPanel />

        {/* The card, and the only thing on the page that matters. */}
        <div className="perspective w-full max-w-sm lg:max-w-md">
          {/*
            The mark, on small screens only.

            The brand panel is hidden below `lg`, which left a phone showing a
            card headed "Sign in" and nothing saying what it signs into —
            indistinguishable from any other login page, which is a poor thing
            to be when somebody has followed a link to a system holding their
            clinic's records.
          */}
          <div className="animate-rise mb-5 flex items-center gap-2.5 lg:hidden">
            <span className="relative flex size-9 items-center justify-center rounded-lg bg-accent text-accent-contrast shadow-pop">
              <Stethoscope className="size-4.5" aria-hidden />
            </span>
            <div>
              <p className="text-md font-semibold tracking-tight text-ink">Clinic EMR</p>
              <p className="text-2xs text-ink-faint">
                For small Indian outpatient practices
              </p>
            </div>
          </div>

          <div ref={card} className="tilt preserve-3d animate-rise">
            <form
              onSubmit={onSubmit}
              noValidate
              /*
               * The depth at rest, before anybody moves a pointer.
               *
               * A highlight along the top edge and a shadow beneath is how a
               * real surface catches a light that is above it — the same reason
               * a physical card looks raised. Without the highlight the card is
               * a rectangle with a drop shadow, which reads as flat no matter
               * how large the shadow gets.
               */
              className="relative overflow-hidden rounded-xl border border-line bg-surface/85 p-6 shadow-modal backdrop-blur-md before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/70 before:to-transparent dark:bg-surface/75 dark:before:via-white/15 sm:p-7"
            >
              <div className="stagger flex flex-col gap-4">
                <header className="flex flex-col gap-1">
                  <h1 className="text-xl font-semibold tracking-tight text-ink">
                    Sign in
                  </h1>
                  <p className="text-xs text-ink-soft">
                    Your clinic&apos;s record, prescribing and front desk.
                  </p>
                </header>

                {/*
                  `role="alert"` so a screen reader announces the refusal. A
                  sign-in failure that is only a colour change is a sign-in
                  failure some people never learn about.
                */}
                {formError ? (
                  <div role="alert">
                    <Alert tone="critical" title={formError} />
                  </div>
                ) : null}

                <Field
                  label="Email"
                  htmlFor="email"
                  required
                  error={form.formState.errors.email?.message}
                >
                  <Input
                    type="email"
                    autoComplete="username"
                    autoFocus
                    placeholder="you@clinic.in"
                    {...form.register('email')}
                  />
                </Field>

                <Field
                  label="Password"
                  htmlFor="password"
                  required
                  error={form.formState.errors.password?.message}
                >
                  <PasswordInput
                    autoComplete="current-password"
                    {...form.register('password')}
                  />
                </Field>

                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  loading={form.formState.isSubmitting}
                  className="mt-1 w-full"
                >
                  Sign in
                </Button>

                <p className="text-xs leading-relaxed text-ink-soft">
                  Forgotten your password? A clinic administrator can reset it for
                  you from Staff and roles.
                </p>
              </div>
            </form>
          </div>

          {/*
            The reassurance sits OUTSIDE the card, under it, where a footnote
            goes. Inside, it would compete with the two fields that are the
            entire job of this screen.
          */}
          <p className="mt-4 flex items-center justify-center gap-1.5 text-2xs text-ink-faint">
            <ShieldCheck className="size-3.5" aria-hidden />
            Every action in this record is logged against your name.
          </p>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------- */

/**
 * The depth behind everything.
 *
 * Two blurred radial gradients on slow opposing drifts, over a faint grid. The
 * grid is a repeating-linear-gradient rather than an image, so it is a few
 * bytes, stays crisp at any zoom, and recolours itself in dark mode along with
 * everything else.
 *
 * `pointer-events-none` throughout: none of this is interactive, and a
 * decorative layer that swallows a click on the field beneath it is a bug that
 * takes an afternoon to find.
 */
function Backdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {/*
        The grid. `--color-line` rather than `line-soft`: at 1px, masked and
        behind a blur, the soft one is invisible in light mode — which is what
        the first pass of this screen looked like, a flat grey page.
      */}
      <div
        className="absolute inset-0 opacity-70 dark:opacity-40"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, var(--color-line) 0 1px, transparent 1px 56px),' +
            'repeating-linear-gradient(90deg, var(--color-line) 0 1px, transparent 1px 56px)',
          maskImage: 'radial-gradient(ellipse 75% 65% at 50% 45%, #000 20%, transparent 95%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 75% 65% at 50% 45%, #000 20%, transparent 95%)',
        }}
      />

      {/*
        The two lights. Sized in viewport units so they scale with the window
        rather than becoming a small blob on a large screen, and blurred by a
        radial gradient rather than a `filter: blur()` — a large blur filter is
        one of the few genuinely expensive things in CSS, and this looks the
        same.
      */}
      <div
        className="animate-drift absolute -left-[12vw] -top-[22vh] h-[75vh] w-[75vw] rounded-full"
        style={{
          background:
            'radial-gradient(circle, color-mix(in oklab, var(--color-accent) 42%, transparent) 0%, transparent 68%)',
        }}
      />
      <div
        className="animate-drift-slow absolute -bottom-[28vh] -right-[16vw] h-[70vh] w-[70vw] rounded-full"
        style={{
          background:
            'radial-gradient(circle, color-mix(in oklab, var(--color-info) 30%, transparent) 0%, transparent 68%)',
        }}
      />
      {/*
        A third light, low and centred, to stop the middle of the page reading
        as a dead band between the two corner washes.
      */}
      <div
        className="animate-drift-slow absolute -bottom-[35vh] left-1/4 h-[55vh] w-[55vw] rounded-full"
        style={{
          background:
            'radial-gradient(circle, color-mix(in oklab, var(--color-chronic) 16%, transparent) 0%, transparent 70%)',
        }}
      />
    </div>
  );
}

/**
 * The panel beside the form.
 *
 * Hidden below `lg`. On a phone this would push the password field below the
 * fold, and the job of the screen is the password field.
 *
 * It names what the product does rather than making a claim about it. "Charting
 * that keeps up with the room" is a sentence a doctor can disagree with;
 * "Trusted by thousands" is one nobody can check, on a screen where the reader
 * is already a customer.
 */
function BrandPanel() {
  return (
    <div className="hidden flex-1 flex-col gap-7 lg:flex">
      <div className="animate-rise flex items-center gap-3">
        <span className="relative flex size-11 items-center justify-center rounded-lg bg-accent text-accent-contrast shadow-pop">
          {/* The pulse. One ring, under the mark, so it reads as a halo. */}
          <span className="animate-pulse-ring absolute inset-0 rounded-lg bg-accent" />
          <Stethoscope className="relative size-5.5" aria-hidden />
        </span>
        <div>
          <p className="text-lg font-semibold tracking-tight text-ink">Clinic EMR</p>
          <p className="text-xs text-ink-faint">For small Indian outpatient practices</p>
        </div>
      </div>

      <h2
        className="animate-rise text-3xl font-semibold leading-tight tracking-tight text-ink text-balance"
        style={{ animationDelay: '80ms' }}
      >
        The whole clinic,
        <span className="text-accent"> on one screen.</span>
      </h2>

      <ul className="stagger flex flex-col gap-3.5">
        {FEATURES.map((feature) => (
          <li key={feature.title} className="flex items-start gap-3">
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface/80 text-accent shadow-raise backdrop-blur-sm">
              <feature.icon className="size-4" aria-hidden />
            </span>
            <div>
              <p className="text-sm font-medium text-ink">{feature.title}</p>
              <p className="text-xs leading-relaxed text-ink-soft">{feature.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const FEATURES = [
  {
    icon: Activity,
    title: 'Consult without typing twice',
    detail:
      'Vitals, diagnosis and a dosed prescription in one pass, with the allergy check running as you prescribe.',
  },
  {
    icon: PillBottle,
    title: 'A counter that balances',
    detail:
      'Dispensing against the finalised prescription, with batch and expiry tracked from the receipt to the sale.',
  },
  {
    icon: FlaskConical,
    title: 'Nothing waiting unread',
    detail:
      'Lab results come back to the doctor who ordered them, and the ones nobody has opened stay visible.',
  },
] as const;
