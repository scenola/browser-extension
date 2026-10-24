/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The recording mark's colours: the `go` token and the green and tile the SVG
// spells, measured the way the contrast gate measures the pages (WCAG 2.2 §1.4.11, 3:1 for a
// graphic a person needs to see).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { NON_TEXT_AA, contrastRatio, parseHex, readThemes } from './contrast-check.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APP = join(ROOT, 'apps/extension');
const svg = readFileSync(join(APP, 'assets/icons/mark-recording.svg'), 'utf8');
const { colours } = readThemes(readFileSync(join(APP, 'src/ui/tokens.css'), 'utf8'));

const TILE = parseHex(/<rect[^>]*fill="(#[0-9a-f]{6})"/iu.exec(svg)?.[1] ?? '');
const MARK = parseHex(/<g fill="(#[0-9a-f]{6})"/iu.exec(svg)?.[1] ?? '');
// Chrome's toolbar: white (light), and the dark theme's #35363a.
const LIGHT_TOOLBAR = parseHex('#ffffff');
const DARK_TOOLBAR = parseHex('#35363a');

const go = colours.dark.go;

describe('the recording mark', () => {
  test('the SVG spells the dark theme’s `go` token, to the byte', () => {
    expect(go).toBeDefined();
    go?.forEach((channel, i) => {
      expect(Math.round(channel * 255)).toBe(Math.round((MARK[i] ?? Number.NaN) * 255));
    });
  });

  test('the green mark against its dark tile is at least 3:1', () => {
    expect(contrastRatio(MARK, TILE)).toBeGreaterThanOrEqual(NON_TEXT_AA);
  });

  test('the green mark is seen on a light and on a dark toolbar (3:1)', () => {
    expect(contrastRatio(MARK, DARK_TOOLBAR)).toBeGreaterThanOrEqual(NON_TEXT_AA);
    // The mark sits on its tile, so against the light toolbar the tile is what is seen.
    expect(contrastRatio(TILE, LIGHT_TOOLBAR)).toBeGreaterThanOrEqual(NON_TEXT_AA);
  });

  // The ratios stated for the mark: what a person is promised, to the digit stated.
  test.each<[string, () => number, number, number]>([
    ['the mark on its tile', () => contrastRatio(MARK, TILE), 10.0, 1],
    ['the mark on the dark toolbar', () => contrastRatio(MARK, DARK_TOOLBAR), 6.4, 1],
    ['the tile on the light toolbar', () => contrastRatio(TILE, LIGHT_TOOLBAR), 18.7, 1],
    ['the tile on the dark toolbar', () => contrastRatio(TILE, DARK_TOOLBAR), 1.55, 2],
  ])('%s is %f:1', (_name, ratio, stated, digits) => {
    expect(ratio().toFixed(digits)).toBe(stated.toFixed(digits));
  });

  test('the tile alone cannot reach 3:1 on a dark toolbar, which is why the signal is the mark', () => {
    expect(contrastRatio(TILE, DARK_TOOLBAR)).toBeLessThan(NON_TEXT_AA);
  });

  test('the light theme’s `go` stays 3:1 on its page', () => {
    const page = colours.light.background;
    const light = colours.light.go;
    expect(page).toBeDefined();
    expect(light).toBeDefined();
    if (page !== undefined && light !== undefined) {
      expect(contrastRatio(light, page)).toBeGreaterThanOrEqual(NON_TEXT_AA);
    }
  });
});
