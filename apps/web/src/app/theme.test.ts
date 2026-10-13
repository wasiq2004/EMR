import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Contrast is a build-time check, not a review opinion.
 *
 * The stated target is WCAG 2.2 AA on core flows: 4.5:1 for text, 3:1 for the
 * boundary of a control. This parses the real token file and measures it, so a
 * palette change that makes a timestamp or an allergy label unreadable fails
 * here rather than in a pilot session.
 *
 * All three theme states are checked, because they are genuinely different:
 * the default (nothing stamped, only prefers-color-scheme), an explicit dark
 * toggle, and light. A token defined only in the base block and used against a
 * background that the dark block redefines is the classic unreadable bug — it
 * is how the active navigation item ended up dark teal on dark teal.
 */

const css = readFileSync(
  fileURLToPath(new URL('./globals.css', import.meta.url)),
  'utf8',
);

function tokensIn(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of block.matchAll(/--color-([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    out[match[1]!] = match[2]!;
  }
  return out;
}

const base = tokensIn(css.split('@theme {')[1]!.split('\n}')[0]!);
const toggled = {
  ...base,
  ...tokensIn(css.split(":root[data-theme='dark'] {")[1]!.split('\n}')[0]!),
};
const system = {
  ...base,
  ...tokensIn(
    css.split('@media (prefers-color-scheme: dark)')[1]!.split('\n  }')[0]!,
  ),
};

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** [foreground, background, minimum ratio, where it appears]. */
const PAIRS: [string, string, number, string][] = [
  ['ink', 'surface', 4.5, 'body text on a panel'],
  ['ink', 'canvas', 4.5, 'body text on the page'],
  ['ink-soft', 'surface', 4.5, 'secondary text'],
  ['ink-faint', 'surface', 4.5, 'timestamps and hints'],
  ['ink-faint', 'canvas', 4.5, 'hints on the page ground'],
  ['accent', 'surface', 3.0, 'links and icons'],
  ['accent-contrast', 'accent', 4.5, 'primary button label'],
  ['accent-ink', 'accent-soft', 4.5, 'active navigation item'],
  ['critical', 'surface', 4.5, 'error text'],
  ['critical', 'critical-soft', 4.5, 'the allergy panel'],
  ['critical-contrast', 'critical', 4.5, 'the high-risk allergy badge'],
  ['warning', 'warning-soft', 4.5, 'warning text'],
  ['positive', 'positive-soft', 4.5, 'success text'],
  ['info', 'info-soft', 4.5, 'informational text'],
  ['chronic', 'chronic-soft', 4.5, 'chronic condition badge'],
  ['line-control', 'surface', 3.0, 'the border of a form control'],
  ['line-control', 'canvas', 3.0, 'a form control on the page ground'],
];

const THEMES: [string, Record<string, string>][] = [
  ['light', base],
  ['dark, toggled', toggled],
  ['dark, from the operating system', system],
];

describe.each(THEMES)('contrast in %s', (_label, palette) => {
  it.each(PAIRS)('%s on %s clears %s:1 — %s', (fg, bg, minimum, _use) => {
    expect(palette[fg], `--color-${fg} is not defined in this theme`).toBeDefined();
    expect(palette[bg], `--color-${bg} is not defined in this theme`).toBeDefined();
    expect(contrast(palette[fg]!, palette[bg]!)).toBeGreaterThanOrEqual(minimum);
  });
});

/**
 * The seven panel tints.
 *
 * Added because the panel identity work introduced twenty-one colour triples
 * across three themes, and the explicit PAIRS list above could not see any of
 * them: they live on `[data-panel]` selectors, not in the theme blocks. An
 * unreadable active-nav item is precisely the bug the comment at the top of
 * this file describes, and it had just been given seven new chances to happen.
 */
const PANELS = [
  'front-desk',
  'doctor',
  'nursing',
  'clinic-admin',
  'pharmacy',
  'analytics',
  'compliance',
];

/**
 * The `[data-panel]` block for one panel in one theme, as its own palette.
 *
 * Located by literal text rather than a built regex: the selectors contain
 * brackets, quotes and parentheses, and escaping them into a pattern is how
 * this helper broke the first time. The light block is written before the dark
 * ones in the file, so an empty prefix finds it first.
 */
function panelTokens(panel: string, prefix: string): Record<string, string> {
  const needle = `${prefix}[data-panel='${panel}'] {`;
  const at = css.indexOf(needle);
  expect(at, `globals.css has no ${needle}`).toBeGreaterThan(-1);
  return tokensIn(css.slice(at + needle.length, css.indexOf('}', at)));
}

const PANEL_THEMES: [string, string, Record<string, string>][] = [
  ['light', '', base],
  ['dark, toggled', ":root[data-theme='dark'] ", toggled],
  ['dark, from the operating system', ":root:not([data-theme='light']) ", system],
];

describe.each(PANEL_THEMES)('panel tints in %s', (_label, prefix, palette) => {
  it.each(PANELS)('%s stays readable', (panel) => {
    const tint = panelTokens(panel, prefix);

    // The active navigation item: panel-coloured text on the panel's own soft
    // background. This is the pairing that has gone wrong here before.
    expect(
      contrast(tint['panel-ink']!, tint['panel-soft']!),
      `${panel}: active nav text on its own background`,
    ).toBeGreaterThanOrEqual(4.5);

    // The indicator bar and the rule above the page title are non-text, so the
    // boundary rule applies rather than the text one.
    expect(
      contrast(tint['panel']!, palette['surface']!),
      `${panel}: the active indicator against the sidebar`,
    ).toBeGreaterThanOrEqual(3.0);

    // The mark inside the sidebar chip, which is an icon on the solid fill.
    expect(
      contrast(palette['panel-contrast']!, tint['panel']!),
      `${panel}: the chip mark on its own fill`,
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe('theme completeness', () => {
  it('redefines every colour the dark theme touches in both dark blocks', () => {
    // An explicit toggle and the system preference must agree. If one block
    // redefines a token and the other forgets, the two dark modes look
    // different — and one of them is usually the broken one.
    const toggledKeys = Object.keys(
      tokensIn(css.split(":root[data-theme='dark'] {")[1]!.split('\n}')[0]!),
    ).sort();
    const systemKeys = Object.keys(
      tokensIn(
        css.split('@media (prefers-color-scheme: dark)')[1]!.split('\n  }')[0]!,
      ),
    ).sort();
    expect(toggledKeys).toEqual(systemKeys);
  });

  it('defines every colour in the base block before any theme overrides it', () => {
    // A colour that exists only inside a dark block never applies in the
    // un-stamped default state, which is what most viewers actually see.
    for (const key of Object.keys(toggled)) {
      expect(base[key], `--color-${key} is missing from the base :root block`).toBeDefined();
    }
  });
});
