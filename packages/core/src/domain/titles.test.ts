/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from 'vitest';
import { normalizeTitle } from './titles';

test.each([
  ['Dune: Part Two', 'dune part two'],
  ['Amélie', 'amelie'],
  ['Law & Order', 'law and order'],
  ['Shōgun (2024)', 'shogun'],
  ['Shōgun [2024]', 'shogun'],
  ["Cat's in the Bag…", 'cats in the bag'],
  ['  The   Office  ', 'the office'],
])('normalizeTitle(%s) = %s', (input, expected) => {
  expect(normalizeTitle(input)).toBe(expected);
});

test.each([
  ['Ёлки', 'елки'],
  ['ガンダム', 'ガンダム'],
  ['カンタム', 'カンタム'],
  ['हिन्दी', 'हिन्दी'],
  ['進撃の巨人', '進撃の巨人'],
  ['기생충', '기생충'],
])('marks are kept outside Latin, Greek and Cyrillic: %s', (input, expected) => {
  expect(normalizeTitle(input)).toBe(expected);
});

test('ガンダム and カンタム stay distinct', () => {
  expect(normalizeTitle('ガンダム')).not.toBe(normalizeTitle('カンタム'));
});

// Found by the property tests (fast-check seed 20261022): a symbol whose removal exposes a mark
// after a Latin letter — U+1D15E decomposes to the note head U+1D157 (a symbol)
// and the combining stem U+1D165 — comes out as a second pass would leave it.
test.each([
  ['\u{1D400}\u{1D15E}', 'a'],
  ['e★́', 'e'],
  ['Caf★́ Society', 'caf society'],
])('a mark that a removed symbol exposed is stripped too: %s', (input, expected) => {
  const once = normalizeTitle(input);
  expect(once).toBe(expected);
  expect(normalizeTitle(once)).toBe(once);
});

test('a title asked for again, before and after many others, has the same form', () => {
  expect(normalizeTitle('Shōgun (2024)')).toBe('shogun');
  for (let i = 0; i < 200; i += 1) {
    expect(normalizeTitle(`Title ${String(i)} & Co.`)).toBe(`title ${String(i)} and co`);
  }
  expect(normalizeTitle('Shōgun (2024)')).toBe('shogun');
});

test('a year that is the title itself is kept', () => {
  expect(normalizeTitle('1917')).toBe('1917');
  expect(normalizeTitle('2012 (2009)')).toBe('2012');
});
