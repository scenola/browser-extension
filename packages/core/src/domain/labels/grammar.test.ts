/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { LABEL_LOCALES, findEpisodeLabel, parseEpisodeLabel, parseEpisodeOnlyLabel } from './index';

test.each([
  ['S1:E2', 1, 2],
  ['S01E02', 1, 2],
  ['S1 E2', 1, 2],
  ['1x02', 1, 2],
  ['Season 1, Ep. 2', 1, 2],
  ['Season 1 Episode 2', 1, 2],
  ['T1:E2', 1, 2],
  ['Temporada 1, episodio 2', 1, 2],
  ['Temporada 1, Episódio 2', 1, 2],
  ['Staffel 1, Folge 2', 1, 2],
  ['St. 1 F. 2', 1, 2],
  ['Saison 1, épisode 2', 1, 2],
  ['Stagione 1, episodio 2', 1, 2],
  ['Seizoen 1, aflevering 2', 1, 2],
  ['Sezon 1, odcinek 2', 1, 2],
  ['Сезон 1, Серія 2', 1, 2],
  ['Řada 1, díl 2', 1, 2],
  ['Säsong 1, avsnitt 2', 1, 2],
  ['Sezon 1, Bölüm 2', 1, 2],
  ['第1季 第2集', 1, 2],
  ['シーズン1 第2話', 1, 2],
  ['시즌 1 2화', 1, 2],
  ['Season 0, Episode 3', 0, 3],
  ['Staffel 12, Folge 104', 12, 104],
  ['Season 1 – Episode 2', 1, 2],
  ['Season 1 — Episode 2', 1, 2],
  ['Season 1 | Episode 2', 1, 2],
  ["Breaking Bad 1x02 Cat's in the Bag", 1, 2],
])('parseEpisodeLabel(%s)', (text, season, episode) => {
  expect(parseEpisodeLabel(text)).toEqual({ season, episode });
});

test('a very long whitespace run is read in linear time', () => {
  for (const text of ['S1' + ' '.repeat(10_000) + 'x', 'Season 1' + ' '.repeat(10_000) + 'Ep']) {
    const start = Date.now();
    expect(parseEpisodeLabel(text)).toBeNull();
    expect(Date.now() - start).toBeLessThan(50);
  }
});

test.each([
  'Episode 2',
  '2021',
  '1080p',
  'S1',
  '',
  'Season one, episode two',
  'S1:E0',
  '시즌 12화',
  'シーズン12話',
  '24x36 cm',
  'Poster 24x36',
  '2x10 pack',
  '24x36x2',
  'Part 2',
  'Top 10',
  '16+',
  'Catch-22',
  '2001: A Space Odyssey',
  'Corsair 4x16 GB DDR4',
  'SSD 2x10 TB',
  'Camera 4x12 MP',
  'CPU 2x40 GHz',
])('parseEpisodeLabel(%s) is null', (text) => {
  expect(parseEpisodeLabel(text)).toBeNull();
});

test('findEpisodeLabel says where the chosen label starts', () => {
  expect(findEpisodeLabel('Show S01E02 - S03E04')).toEqual({
    season: 1,
    episode: 2,
    index: 5,
    length: 6,
  });
  expect(findEpisodeLabel('  Show   1x02')).toMatchObject({ season: 1, episode: 2, index: 6 });
  expect(findEpisodeLabel('nothing')).toBeNull();
});

// A single-season show's label names the episode alone ("Еп. 3" on Netflix in Ukrainian). The
// episode-only form reads each locale's own episode words, plus a pattern where the words cannot
// say it (CJK), as a whole label.
describe('an episode-only label', () => {
  test.each([
    ['Еп. 3', 3], // uk
    ['еп 12', 12],
    ['Серія 4', 4],
    ['Ep. 3', 3], // en
    ['Episode 7', 7],
    ['E3', 3],
    ['Folge 3', 3], // de
    ['F. 9', 9],
    ['第3集', 3], // zh
    ['第 12 话', 12],
    ['第3話', 3], // ja
    ['エピソード 5', 5],
    ['3화', 3], // ko
    ['  Ep.   3  ', 3],
  ])('parseEpisodeOnlyLabel(%s)', (text, episode) => {
    expect(parseEpisodeOnlyLabel(text)).toBe(episode);
  });

  test.each([
    'Сезон 3', // a season word is no episode word
    'Season 3',
    'S3',
    'Ep. 0', // episode 0 is not an episode
    'Ep. 12345',
    'Ep.',
    '3',
    'Part 2',
    'Top 10',
    'E3 2021',
    'Breaking Bad Episode 2', // a label inside other text is not this label
    'Ep. 3 Де моя трава?',
    'S1:E2',
    'Де моя трава?',
    '第3季',
    '',
  ])('parseEpisodeOnlyLabel(%s) is null', (text) => {
    expect(parseEpisodeOnlyLabel(text)).toBeNull();
  });

  test('the season-and-episode grammar is unchanged: an episode alone is no season label', () => {
    expect(parseEpisodeLabel('Еп. 3')).toBeNull();
    expect(parseEpisodeLabel('Episode 2')).toBeNull();
  });

  // Locale tables are data with a test per entry: every episode word of every table.
  const wordLocales = LABEL_LOCALES.filter((l) => l.episode.length > 0);
  test.each(wordLocales.map((l) => [l.id, l] as const))('every episode word of %s', (_id, l) => {
    fc.assert(
      fc.property(
        fc.mixedCase(fc.constantFrom(...l.episode)),
        fc.constantFrom(' ', '.', '. '),
        fc.integer({ min: 1, max: 9999 }),
        (word, separator, episode) => {
          expect(parseEpisodeOnlyLabel(`${word}${separator}${String(episode)}`)).toBe(episode);
        },
      ),
      { seed: 20_261_022, numRuns: 200 },
    );
  });

  // Hostile input never throws, the answer fits the wire, and the work is bounded (the text is cut at 300 characters before any pattern runs).
  test('total, within the wire, and bounded', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (text) => {
        const episode = parseEpisodeOnlyLabel(text);
        if (episode === null) return;
        expect(Number.isInteger(episode)).toBe(true);
        expect(episode).toBeGreaterThanOrEqual(1);
        expect(episode).toBeLessThanOrEqual(100_000);
      }),
      { seed: 20_261_022, numRuns: 400 },
    );
    const near = 'Ep. Ep. Еп. 第第 화 Folge '.repeat(50_000);
    for (const text of [near, ' '.repeat(1_000_000), `Ep. ${'9'.repeat(1_000_000)}`]) {
      const start = Date.now();
      expect(parseEpisodeOnlyLabel(text)).toBeNull();
      expect(Date.now() - start).toBeLessThan(200);
    }
  });
});

test('every locale has a test line above', () => {
  expect(LABEL_LOCALES.map((l) => l.id).sort()).toEqual([
    'cs',
    'de',
    'en',
    'es',
    'fr',
    'it',
    'ja',
    'ko',
    'nl',
    'pl',
    'pt',
    'sv',
    'tr',
    'uk',
    'zh',
  ]);
});
