'use client';

import * as React from 'react';

/**
 * Light, dark, or whatever the machine says.
 *
 * THREE STATES, NOT TWO. The stylesheet already distinguishes them:
 *
 *   no attribute        → `@media (prefers-color-scheme: dark)` decides
 *   data-theme="light"  → forced light; the media query is blocked by
 *                         `:root:not([data-theme='light'])`
 *   data-theme="dark"   → forced dark
 *
 * A binary toggle would have to pick a side on first paint and would therefore
 * throw away "follow the system", which is the right default and the one most
 * people never change. It also matters on a clinic desktop that dims itself in
 * the evening: the machine changes, and the app should follow unless someone
 * said otherwise.
 *
 * PER VIEWER, PER BROWSER. This is a display preference, not clinical data, so
 * it lives in localStorage and never goes near the server. It does not follow a
 * user to another machine, and that is correct — the reason to want dark mode is
 * usually the room, not the person.
 */

export type ThemeChoice = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'emr-theme';

/**
 * Runs before first paint, inlined into <head>.
 *
 * Without this the page renders in the default theme and then repaints once
 * React hydrates — a white flash on every navigation for anyone who chose dark,
 * which is worse than having no switcher at all.
 *
 * Deliberately tiny and dependency-free: it is a blocking script, so every byte
 * is on the critical path. It stamps nothing for 'system', because absent is
 * what the stylesheet reads as "let the media query decide".
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})()`;

function readStored(): ThemeChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'dark' || value === 'light' ? value : 'system';
  } catch {
    // Private browsing, or site data blocked. Following the system is a fine
    // answer and the page must not fail to render over a colour preference.
    return 'system';
  }
}

function apply(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

const ThemeContext = React.createContext<{
  choice: ThemeChoice;
  setChoice: (choice: ThemeChoice) => void;
  /** What is actually on screen right now, with 'system' resolved. */
  resolved: 'light' | 'dark';
} | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Starts at 'system' on the server and on first client render so the markup
  // matches; the real value is read in the effect below. The inline script has
  // already stamped the attribute, so nothing flashes while that happens.
  const [choice, setChoiceState] = React.useState<ThemeChoice>('system');
  const [systemDark, setSystemDark] = React.useState(false);

  React.useEffect(() => {
    setChoiceState(readStored());

    const query = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(query.matches);

    // The machine can change theme while the app is open — most laptops do it
    // on a schedule — and on 'system' the app should follow without a reload.
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const setChoice = React.useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    apply(next);
    try {
      if (next === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice still applies for this session. Failing to persist a colour
      // preference is not worth an error the user has to dismiss.
    }
  }, []);

  const value = React.useMemo(
    () => ({
      choice,
      setChoice,
      resolved: (choice === 'system' ? (systemDark ? 'dark' : 'light') : choice) as
        | 'light'
        | 'dark',
    }),
    [choice, setChoice, systemDark],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = React.useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}
