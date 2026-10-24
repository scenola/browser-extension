/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The contrast gate: every colour pair the extension's pages paint,
// measured against WCAG 2.2 AA in both themes, and the build fails on any pair under its
// threshold — 4.5:1 for text (1.4.3), 3:1 for large text and for the parts of a control or a
// graphic a person needs to see (1.4.11). Run it with `pnpm contrast:check`.
//
// Ported from the web app's contrast check (its colour maths, its glass rule, and
// its stance: the conversion is written here, not installed, and is pinned by a test against
// values known without this file). What differs is where the pairs come from:
//
//   - The tokens are read from `apps/extension/src/ui/tokens.css`: `:root` is the dark theme
//     (dark is primary) and `@media (prefers-color-scheme: light) { :root {…} }` the
//     light one. A token the table needs and the file lacks stops the check.
//   - The pairs are a table (`PAIRS`), one row per foreground on a ground, each with the classes
//     that paint it. The pages are then read for every token class they use, and **a class the
//     table does not name fails the check**: a colour painted and not measured is the gap this
//     gate exists to close.
//   - The toolbar badge cannot read CSS, so its two colours are read from
//     `src/platform/status-display.ts` and measured as text.
//
// What this does not measure: a colour dimmed by `opacity-*` (a disabled control, whose
// contrast WCAG does not require), and anything drawn over a page's own content.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APP = join(ROOT, 'apps/extension');
const TOKENS = join(APP, 'src/ui/tokens.css');
const UI = join(APP, 'src/ui');
const BADGE = join(APP, 'src/platform/status-display.ts');

/** WCAG 2.2 §1.4.3 (text) and §1.4.11 (non-text: a control's parts, a graphic). */
export const TEXT_AA = 4.5;
export const NON_TEXT_AA = 3;

// ── colour maths (the web app's, ported) ────────────────────────────────────────────────────

export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

export type Rgb = readonly [number, number, number];

export function parseOklch(value: string): Oklch {
  const match = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)(%?)\s+([\d.]+)(?:deg)?\s*\)$/iu.exec(
    value.trim(),
  );
  if (match === null) throw new Error(`not an oklch triple: ${value}`);
  const [, lightness = '', lightnessPct, chroma = '', chromaPct, hue = ''] = match;
  return {
    l: Number(lightness) / (lightnessPct === '%' ? 100 : 1),
    c: (Number(chroma) * (chromaPct === '%' ? 0.4 : 1)) / (chromaPct === '%' ? 100 : 1),
    h: Number(hue),
  };
}

const encode = (v: number): number =>
  v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
const decode = (v: number): number =>
  v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
const clamp = (v: number): number => Math.min(1, Math.max(0, v));

/** oklch → gamma-encoded sRGB, clamped per channel (conservative: it can only understate). */
export function oklchToSrgb({ l, c, h }: Oklch): Rgb {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const lp = l + 0.3963377774 * a + 0.2158037573 * b;
  const mp = l - 0.1055613458 * a - 0.0638541728 * b;
  const sp = l - 0.0894841775 * a - 1.291485548 * b;
  const L = lp ** 3;
  const M = mp ** 3;
  const S = sp ** 3;
  return [
    clamp(encode(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S)),
    clamp(encode(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S)),
    clamp(encode(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S)),
  ];
}

export function parseHex(hex: string): Rgb {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex.trim());
  if (match === null) throw new Error(`not a #rrggbb colour: ${hex}`);
  return [
    Number.parseInt(match[1] ?? '', 16) / 255,
    Number.parseInt(match[2] ?? '', 16) / 255,
    Number.parseInt(match[3] ?? '', 16) / 255,
  ];
}

/** WCAG relative luminance of a gamma-encoded sRGB colour. */
function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * decode(r) + 0.7152 * decode(g) + 0.0722 * decode(b);
}

/** The WCAG contrast ratio, 1..21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Alpha compositing in encoded sRGB, as the browser does for an opaque page. */
function blend(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return [
    alpha * fg[0] + (1 - alpha) * bg[0],
    alpha * fg[1] + (1 - alpha) * bg[1],
    alpha * fg[2] + (1 - alpha) * bg[2],
  ];
}

// ── the tokens ──────────────────────────────────────────────────────────────────────────────

export type Theme = 'dark' | 'light';
export type Palette = Readonly<Record<string, Rgb>>;

/** A rule's body from its `{`, by brace depth. */
function bodyFrom(css: string, open: number): string {
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error('a rule in tokens.css is not closed');
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of body.matchAll(/--([a-z][a-z0-9-]*)\s*:\s*([^;]+);/gu)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) out.set(name, value.trim());
  }
  return out;
}

/**
 * Both themes of tokens.css: the top-level `:root` (dark) and the `:root` inside
 * `@media (prefers-color-scheme: light)` (light, overriding the dark values it names).
 */
export function readThemes(css: string): {
  readonly colours: Readonly<Record<Theme, Palette>>;
  readonly glassAlpha: Readonly<Record<Theme, number>>;
} {
  const stripped = css.replace(/\/\*[^]*?\*\//gu, (comment) => ' '.repeat(comment.length));
  const media = /@media\s*\(\s*prefers-color-scheme\s*:\s*light\s*\)\s*\{/u.exec(stripped);
  if (media === null) throw new Error('tokens.css has no prefers-color-scheme: light block');
  const mediaBody = bodyFrom(stripped, media.index + media[0].length - 1);
  const outside =
    stripped.slice(0, media.index) +
    stripped.slice(media.index + media[0].length + mediaBody.length + 1);
  const darkRoot = /(?:^|\})\s*:root\s*\{/u.exec(outside);
  const lightRoot = /:root\s*\{/u.exec(mediaBody);
  if (darkRoot === null) throw new Error('tokens.css has no top-level :root block');
  if (lightRoot === null) throw new Error('the light block of tokens.css has no :root');
  const dark = declarations(bodyFrom(outside, darkRoot.index + darkRoot[0].length - 1));
  const light = new Map([
    ...dark,
    ...declarations(bodyFrom(mediaBody, lightRoot.index + lightRoot[0].length - 1)),
  ]);
  const palette = (vars: Map<string, string>): Palette =>
    Object.fromEntries(
      [...vars]
        .filter(([, value]) => value.startsWith('oklch(') && !value.includes('/'))
        .map(([name, value]) => [name, oklchToSrgb(parseOklch(value))]),
    );
  const alpha = (vars: Map<string, string>, theme: Theme): number => {
    const found = /^([\d.]+)%$/u.exec(vars.get('glass-alpha') ?? '');
    if (found === null) throw new Error(`--glass-alpha is not a percentage in the ${theme} theme`);
    return Number(found[1]) / 100;
  };
  return {
    colours: { dark: palette(dark), light: palette(light) },
    glassAlpha: { dark: alpha(dark, 'dark'), light: alpha(light, 'light') },
  };
}

// ── the pairs ───────────────────────────────────────────────────────────────────────────────

export interface Pair {
  readonly fg: string;
  /**
   * The ground: a token, or `glass` — the popup's and the settings page's header (`.glass`,
   * styles.css: the background at `--glass-alpha` over whatever scrolls beneath, bounded by white
   * and black as the web app bounds it).
   */
  readonly on: string;
  readonly min: number;
  /** Where it is painted, in words. */
  readonly where: string;
}

const text = (fg: string, on: string, where: string): Pair => ({ fg, on, min: TEXT_AA, where });
const part = (fg: string, on: string, where: string): Pair => ({ fg, on, min: NON_TEXT_AA, where });

/**
 * Every pair the pages paint. The grounds text sits on: the page (`background`), a card, a
 * secondary surface (a note, a secondary button, a hovered row), the hovered secondary button
 * (`accent`), a primary or a danger button, and the glass header.
 */
export const PAIRS: readonly Pair[] = [
  text('foreground', 'background', 'body text, headings'),
  text('foreground', 'card', 'rows of a settings card'),
  text('foreground', 'secondary', 'a note; a ghost button or a row, hovered'),
  // Glass carries primary ink only (the web app's rule, K1): "Connected" and the settings
  // page's heading are `text-foreground`, so no muted pair is measured on it.
  text('foreground', 'glass', 'the header: the product name, "Connected", the page heading'),
  text('muted-foreground', 'background', 'captions, section headings, the state line'),
  text('muted-foreground', 'card', "a row's detail"),
  text('muted-foreground', 'secondary', "a hovered row's caption"),
  text('card-foreground', 'card', 'Card'),
  text('secondary-foreground', 'secondary', 'a secondary button'),
  text('secondary-foreground', 'accent', 'a secondary button, hovered'),
  text('primary-foreground', 'primary', 'a primary button'),
  text('primary-foreground', 'destructive', 'the danger button (Clear, Disconnect)'),
  part('lamp', 'background', 'the Waiting glyph; an attention verdict'),
  part('lamp', 'secondary', 'the alert glyph of a connection notice'),
  part('lamp', 'card', 'a switch that is on: its track against the card'),
  part('primary-foreground', 'lamp', 'a switch that is on: its thumb'),
  part('foreground', 'secondary', 'a switch that is off: its thumb on the track'),
  part('primary', 'secondary', 'a segmented choice: the chosen one on its track'),
  part('ring', 'background', 'the focus ring (2 px, offset onto the ground)'),
  part('ring', 'card', 'the focus ring on a card'),
  part('muted-foreground', 'background', "a text field's border"),
  part('destructive', 'background', 'an invalid text field’s border'),
  part('primary', 'border', 'the progress beam: its value on its track'),
];

/**
 * The token classes the table accounts for, beyond its own pairs' foregrounds and grounds:
 * hairlines and tracks that separate rather than inform (WCAG 1.4.11 asks nothing of a
 * decorative border), each with why.
 */
const DECORATIVE: Readonly<Record<string, string>> = {
  'border-border': 'hairlines between sections and around cards; the content says where it is',
  'bg-border': "the welcome page's step bars (aria-hidden; 'Step n of 3' says it in words)",
  'border-input': "a switch that is off: its track's edge (the thumb is the state, measured)",
};

const CLASS =
  /\b(?:hover:|disabled:|focus-visible:|aria-invalid:|placeholder:)?(text|bg|border)-([a-z]+(?:-[a-z]+)*)\b/gu;

/** Every `text-`, `bg-` and `border-` token class the pages use, by file. */
export function tokenClassesIn(source: string, tokens: ReadonlySet<string>): ReadonlySet<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(CLASS)) {
    const [, kind, token] = match;
    if (kind === undefined || token === undefined || !tokens.has(token)) continue;
    found.add(`${kind}-${token}`);
  }
  return found;
}

/** The classes a pair (or the decorative list) accounts for. */
export function accountedFor(pairs: readonly Pair[]): ReadonlySet<string> {
  const out = new Set(Object.keys(DECORATIVE));
  for (const pair of pairs) {
    out.add(`text-${pair.fg}`);
    out.add(`bg-${pair.fg}`);
    out.add(`border-${pair.fg}`);
    if (pair.on !== 'glass') out.add(`bg-${pair.on}`);
  }
  return out;
}

export interface Measured extends Pair {
  readonly theme: Theme;
  readonly ratio: number;
  readonly backdrop?: string;
}

/** Every pair in both themes; glass twice, over white and over black. */
export function measure(
  pairs: readonly Pair[],
  colours: Readonly<Record<Theme, Palette>>,
  glassAlpha: Readonly<Record<Theme, number>>,
): Measured[] {
  const out: Measured[] = [];
  for (const theme of ['dark', 'light'] as const) {
    const palette = colours[theme];
    const colour = (name: string): Rgb => {
      const found = palette[name];
      if (found === undefined) throw new Error(`--${name} is not in the ${theme} theme`);
      return found;
    };
    for (const pair of pairs) {
      const fg = colour(pair.fg);
      if (pair.on === 'glass') {
        const ground = colour('background');
        for (const [backdrop, under] of [
          ['over white', [1, 1, 1]],
          ['over black', [0, 0, 0]],
        ] as const) {
          const glass = blend(ground, under, glassAlpha[theme]);
          out.push({ ...pair, theme, backdrop, ratio: contrastRatio(fg, glass) });
        }
      } else {
        out.push({ ...pair, theme, ratio: contrastRatio(fg, colour(pair.on)) });
      }
    }
  }
  return out;
}

/** The badge's colours (status-display.ts): `<name>: { background: '#…', text: '#…' }`. */
export function readBadges(source: string): { name: string; background: Rgb; text: Rgb }[] {
  const out: { name: string; background: Rgb; text: Rgb }[] = [];
  const pattern =
    /\b([a-z]+):\s*\{\s*background:\s*'(#[0-9a-fA-F]{6})',\s*text:\s*'(#[0-9a-fA-F]{6})'\s*\}/gu;
  for (const match of source.matchAll(pattern)) {
    const [, name = '', background = '', fgText = ''] = match;
    out.push({ name, background: parseHex(background), text: parseHex(fgText) });
  }
  return out;
}

function uiSources(dir = UI): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...uiSources(path));
    else if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) out.push(path);
  }
  return out;
}

const pad = (value: string, width: number): string => value.padEnd(width);

function main(): void {
  const { colours, glassAlpha } = readThemes(readFileSync(TOKENS, 'utf8'));
  const failures: string[] = [];

  console.log(`contrast:check — ${relative(ROOT, TOKENS)}, WCAG 2.2 AA\n`);
  for (const theme of ['dark', 'light'] as const) {
    console.log(theme);
    for (const m of measure(PAIRS, colours, glassAlpha).filter((x) => x.theme === theme)) {
      const ok = m.ratio >= m.min;
      const ground = m.on === 'glass' ? `glass ${m.backdrop ?? ''}` : m.on;
      // Three decimals: a ratio of 4.4996 must not print as a passing 4.50.
      const shown = m.ratio.toFixed(3).padStart(6);
      console.log(
        `  ${ok ? 'ok  ' : 'FAIL'} ${pad(m.fg, 22)} on ${pad(ground, 18)} ${shown} ≥ ${m.min.toFixed(1)}  ${m.where}`,
      );
      if (!ok) {
        failures.push(
          `${theme}: ${m.fg} on ${ground} is ${m.ratio.toFixed(3)}:1 (${m.where}) — under ${String(m.min)}:1`,
        );
      }
    }
    console.log('');
  }

  console.log('the toolbar badge (status-display.ts), text on its colour');
  const badges = readBadges(readFileSync(BADGE, 'utf8'));
  if (badges.length === 0) failures.push('no badge colours found in status-display.ts');
  for (const badge of badges) {
    const ratio = contrastRatio(badge.text, badge.background);
    const ok = ratio >= TEXT_AA;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${pad(badge.name, 22)} ${ratio.toFixed(2).padStart(5)} ≥ 4.5`,
    );
    if (!ok) failures.push(`badge ${badge.name}: ${ratio.toFixed(2)}:1 — under 4.5:1`);
  }
  console.log('');

  const tokens = new Set(Object.keys(colours.dark));
  const known = accountedFor(PAIRS);
  for (const path of uiSources()) {
    for (const used of tokenClassesIn(readFileSync(path, 'utf8'), tokens)) {
      if (!known.has(used)) {
        failures.push(`${relative(ROOT, path)} paints ${used}, which no pair measures`);
      }
    }
  }

  if (failures.length === 0) {
    console.log('OK — every pair the pages paint clears WCAG 2.2 AA in both themes.');
    return;
  }
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error: unknown) {
    console.error(`contrast:check: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
