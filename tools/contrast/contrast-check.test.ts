/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The contrast gate's own correctness. A checker that is quietly wrong
// prints reassuring numbers about text nobody can read, so its maths is pinned against values
// known without it — WCAG's definition (white on black is 21:1), the sRGB transfer function
// (#808080 on white is 3.95:1), CSS Color 4 (oklch(1 0 0) is white) — and each of its gates is
// shown to fire on an input built to fail it.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import {
  NON_TEXT_AA,
  PAIRS,
  TEXT_AA,
  accountedFor,
  contrastRatio,
  measure,
  oklchToSrgb,
  parseHex,
  parseOklch,
  readBadges,
  readThemes,
  tokenClassesIn,
} from './contrast-check.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('the colour maths', () => {
  test('white on black is 21:1, and a colour on itself 1:1 (WCAG 2.2 definition)', () => {
    expect(contrastRatio([1, 1, 1], [0, 0, 0])).toBeCloseTo(21, 10);
    expect(contrastRatio([0.3, 0.5, 0.7], [0.3, 0.5, 0.7])).toBe(1);
  });

  test('#808080 on white is 3.95:1 (the sRGB transfer function)', () => {
    expect(contrastRatio(parseHex('#808080'), parseHex('#ffffff'))).toBeCloseTo(3.949, 3);
  });

  test('WCAG thresholds: 4.5:1 for text, 3:1 for a control or a graphic (2.2 §1.4.3, §1.4.11)', () => {
    expect(TEXT_AA).toBe(4.5);
    expect(NON_TEXT_AA).toBe(3);
  });

  test('oklch: white, black and the mid grey of CSS Color 4', () => {
    const near = (rgb: readonly number[], expected: readonly number[]) => {
      rgb.forEach((v, i) => {
        expect(v).toBeCloseTo(expected[i] ?? Number.NaN, 3);
      });
    };
    near(oklchToSrgb(parseOklch('oklch(1 0 0)')), [1, 1, 1]);
    near(oklchToSrgb(parseOklch('oklch(0 0 0)')), [0, 0, 0]);
    // L = 0.6 is linear 0.216: encoded 0.5007, #808080 to the byte.
    near(oklchToSrgb(parseOklch('oklch(0.6 0 0)')), [128 / 255, 128 / 255, 128 / 255]);
  });

  test('a string that is not an oklch triple is refused, not read as black', () => {
    expect(() => parseOklch('rgb(0 0 0)')).toThrow();
    expect(() => parseHex('#fff')).toThrow();
  });
});

const CSS = `
:root {
  --background: oklch(0.13 0.005 70);
  --foreground: oklch(0.97 0.003 80);
  --glass-alpha: 80%;
}
@media (prefers-color-scheme: light) {
  :root {
    --background: oklch(0.975 0.006 85);
    --glass-alpha: 82%;
  }
}`;

describe('reading tokens.css', () => {
  test('the top-level :root is dark; the light block overrides what it names', () => {
    const { colours, glassAlpha } = readThemes(CSS);
    expect(glassAlpha).toEqual({ dark: 0.8, light: 0.82 });
    expect(colours.dark.background).not.toEqual(colours.light.background);
    // Not named in the light block: the dark value stands.
    expect(colours.light.foreground).toEqual(colours.dark.foreground);
  });

  test('a file without a light block stops the check', () => {
    expect(() => readThemes(':root { --background: oklch(0.1 0 0); --glass-alpha: 80%; }')).toThrow(
      /light/u,
    );
  });

  test('a token a pair needs and the file lacks stops the check', () => {
    const { colours, glassAlpha } = readThemes(CSS);
    expect(() =>
      measure([{ fg: 'lamp', on: 'background', min: 3, where: 'x' }], colours, glassAlpha),
    ).toThrow(/--lamp/u);
  });
});

describe('the gates fire', () => {
  test('a pair under its threshold is measured under it', () => {
    const { colours, glassAlpha } = readThemes(CSS);
    const [dark] = measure(
      [{ fg: 'background', on: 'background', min: TEXT_AA, where: 'x' }],
      colours,
      glassAlpha,
    );
    expect(dark?.ratio).toBe(1);
  });

  test('glass is measured over white and over black', () => {
    const { colours, glassAlpha } = readThemes(CSS);
    const rows = measure(
      [{ fg: 'foreground', on: 'glass', min: TEXT_AA, where: 'x' }],
      colours,
      glassAlpha,
    );
    expect(rows.map((r) => `${r.theme} ${r.backdrop ?? ''}`)).toEqual([
      'dark over white',
      'dark over black',
      'light over white',
      'light over black',
    ]);
  });

  test('a token class no pair measures is found', () => {
    const tokens = new Set(['foreground', 'success', 'lamp']);
    const used = tokenClassesIn('class="text-body-s text-foreground hover:bg-success"', tokens);
    expect([...used].sort()).toEqual(['bg-success', 'text-foreground']);
    expect(accountedFor(PAIRS).has('bg-success')).toBe(false);
  });

  test('the badge colours are read as the file writes them', () => {
    const badges = readBadges(`
      lamp: { background: '#eec474', text: '#0f0d0b' },
      danger: { background: '#cc272b', text: '#ffffff' },`);
    expect(badges.map((b) => b.name)).toEqual(['lamp', 'danger']);
  });
});

describe('the real tree', () => {
  const tokensCss = readFileSync(join(ROOT, 'apps/extension/src/ui/tokens.css'), 'utf8');
  const { colours } = readThemes(tokensCss);

  function pages(dir = join(ROOT, 'apps/extension/src/ui')): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return pages(path);
      return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [path] : [];
    });
  }

  test('reads the pages it should (a gate that sees nothing proves nothing)', () => {
    const used = new Set(
      pages().flatMap((p) => [
        ...tokenClassesIn(readFileSync(p, 'utf8'), new Set(Object.keys(colours.dark))),
      ]),
    );
    expect(used.has('text-muted-foreground')).toBe(true);
    expect(used.has('bg-primary')).toBe(true);
  });

  test('every token class the pages paint is one a pair measures', () => {
    const known = accountedFor(PAIRS);
    const unmeasured = pages().flatMap((p) =>
      [...tokenClassesIn(readFileSync(p, 'utf8'), new Set(Object.keys(colours.dark)))]
        .filter((c) => !known.has(c))
        .map((c) => `${p}: ${c}`),
    );
    expect(unmeasured).toEqual([]);
  });

  test('the badge colours are found in status-display.ts', () => {
    const source = readFileSync(
      join(ROOT, 'apps/extension/src/platform/status-display.ts'),
      'utf8',
    );
    expect(
      readBadges(source)
        .map((b) => b.name)
        .sort(),
    ).toEqual(['danger', 'lamp']);
  });
});
