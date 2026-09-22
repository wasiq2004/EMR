'use client';

import * as React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useTheme, type ThemeChoice } from '@/lib/theme';

/**
 * Light, dark, or follow the machine.
 *
 * A SEGMENTED CONTROL, NOT A TOGGLE. There are three states and a toggle can
 * only express two — and the third, "follow the system", is the default and the
 * one most people will keep. Cycling through three on one button is worse: it
 * gives no way to see which of the three you are on without clicking, and the
 * two visible themes look identical when the machine happens to agree.
 *
 * All three options are always visible rather than hidden behind a menu. It
 * costs 96 pixels in a header that has room, and it means the setting can be
 * both read and changed in one glance — which is what someone reaches for when a
 * room's lighting has just changed and they are mid-consultation.
 *
 * This is a display preference, so it is a radiogroup rather than a set of
 * buttons: assistive technology should announce it as one setting with three
 * values and say which is selected, not as three unrelated controls.
 */

const OPTIONS: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'dark', label: 'Dark', Icon: Moon },
];

export function ThemeSwitcher({ className }: { className?: string }) {
  const { choice, setChoice } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={cn(
        'flex items-center gap-0.5 rounded-md border border-line bg-surface-sunk p-0.5',
        className,
      )}
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const selected = choice === value;

        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={
              value === 'system' ? 'Match the system theme' : `${label} theme`
            }
            title={value === 'system' ? 'Match the system theme' : `${label} theme`}
            onClick={() => setChoice(value)}
            className={cn(
              'flex size-7 items-center justify-center rounded-sm',
              'transition-[color,background-color,box-shadow] duration-[--duration-ui] ease-[--ease-ui]',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
              /*
                The selected pill uses the ACCENT pair, not surface-on-sunk.
                In dark those two are #141f23 and #101a1d — about 1.15:1 — so a
                selection drawn with them is invisible, and the shadow that
                rescues it in light mode barely registers on a dark background.
                accent-ink on accent-soft is the pair the contrast test already
                holds to 4.5:1 in both themes.
              */
              selected
                ? 'bg-accent-soft text-accent-ink shadow-raise'
                : 'text-ink-faint hover:bg-surface hover:text-ink',
            )}
          >
            <Icon className="size-3.5" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}
