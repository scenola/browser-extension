/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The address reader, from the forms in words: a season and an episode, written compactly (`s`,
// a number, `e` or `ep`, a number), as words, or as parameters, anywhere in the address; exactly
// one pair per address; the wire's bounds (season 0 stands, episode 0 is none); and a letter or a
// digit on either side of a form means the letters belong to a longer word. Seeded properties
// cover the ranges.

import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { EPISODE_NUMBER_MAX, SEASON_NUMBER_MAX } from '../play';
import { addressNumbers } from './address';

const SEED = 20_261_023;

const at = (over: { pathname?: string; query?: Record<string, string>; hash?: string }) => ({
  hostname: 'series.example',
  pathname: '/',
  query: {},
  hash: '',
  ...over,
});

const FIVE_ONE = { season: 5, episode: 1 };

describe('the compact form', () => {
  // Between a letter and its number: nothing, `:`, `=`, `-` or `_`. Between the halves: nothing,
  // `-`, `_`, `.`, `/`, `:`. The episode's letter is `e` or `ep`.
  const LETTER_NUMBER = ['', ':', '=', '-', '_'];
  const BETWEEN = ['', '-', '_', '.', '/', ':'];
  const EPISODE_LETTERS = ['e', 'ep'];

  /** `s5e1` in every combination of separators and episode letters, in both letter cases. */
  const combinations = LETTER_NUMBER.flatMap((a) =>
    BETWEEN.flatMap((mid) =>
      LETTER_NUMBER.flatMap((b) =>
        EPISODE_LETTERS.flatMap((letters) => [
          `s${a}5${mid}${letters}${b}1`,
          `S${a}5${mid}${letters.toUpperCase()}${b}1`,
        ]),
      ),
    ),
  );

  test('every combination of separators reads the pair, in any letter case', () => {
    expect(combinations).toHaveLength(
      LETTER_NUMBER.length * BETWEEN.length * LETTER_NUMBER.length * EPISODE_LETTERS.length * 2,
    );
    for (const text of combinations) {
      expect(addressNumbers(at({ pathname: `/w/${text}/play` })), text).toEqual(FIVE_ONE);
      expect(addressNumbers(at({ hash: `#${text}` })), text).toEqual(FIVE_ONE);
    }
  });

  test.each(['s05e01', 's5e1', 's5-e1', 's:5-e:1', 'S01_E02', 's1.e2', 's1ep2', 's=1:e=2'])(
    'the documented example %s is read',
    (text) => {
      expect(addressNumbers(at({ pathname: `/${text}` }))).not.toBeNull();
    },
  );

  test('the numbers are read as numbers: leading zeros are nothing', () => {
    expect(addressNumbers(at({ pathname: '/s0005e000001' }))).toEqual(FIVE_ONE);
  });

  test('the form is found anywhere in the path, the query values or the hash', () => {
    expect(addressNumbers(at({ pathname: '/a/b/c/s5e1/d' }))).toEqual(FIVE_ONE);
    expect(addressNumbers(at({ query: { play: 's5e1' } }))).toEqual(FIVE_ONE);
    expect(addressNumbers(at({ hash: '#/watch/s5e1' }))).toEqual(FIVE_ONE);
  });

  test.each([
    ['a letter before', '/class5e1'],
    ['another letter before', '/mass1e2'],
    ['a letter after', '/s5e1x'],
    ['a digit before', '/1s5e1'],
    ['a letter in another script before', '/éS5e1'],
    ['a letter in another script after', '/s5e1é'],
    ['seven digits', '/s5e1234567'],
  ])('%s: the letters belong to a longer word, and it names nothing', (_n, pathname) => {
    expect(addressNumbers(at({ pathname }))).toBeNull();
  });

  test.each(['/', '-', '.', '_', ':', '?', '#'])('a %s on either side is an edge', (edge) => {
    expect(addressNumbers(at({ pathname: `/x${edge}s5e1${edge}y` }))).toEqual(FIVE_ONE);
  });

  test('the address’s own edges count as edges', () => {
    expect(addressNumbers(at({ pathname: 's5e1' }))).toEqual(FIVE_ONE);
    expect(addressNumbers(at({ pathname: '/', hash: '#s5e1' }))).toEqual(FIVE_ONE);
  });

  test('a digit run of the wrong shape is not a pair', () => {
    expect(addressNumbers(at({ pathname: '/s5' }))).toBeNull();
    expect(addressNumbers(at({ pathname: '/e1' }))).toBeNull();
    expect(addressNumbers(at({ pathname: '/s5e' }))).toBeNull();
    expect(addressNumbers(at({ pathname: '/se1' }))).toBeNull();
  });

  test('is read for any numbers in the wire’s bounds, in any separators', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: SEASON_NUMBER_MAX }),
        fc.integer({ min: 1, max: EPISODE_NUMBER_MAX }),
        fc.constantFrom('', ':', '=', '-', '_'),
        fc.constantFrom('', '-', '_', '.', '/', ':'),
        fc.constantFrom('e', 'ep'),
        (season, episode, sep, mid, letter) => {
          const text = `s${sep}${String(season)}${mid}${letter}${sep}${String(episode)}`;
          expect(addressNumbers(at({ pathname: `/${text}` }))).toEqual({ season, episode });
        },
      ),
      { seed: SEED },
    );
  });

  test('is read in no word: any letter or digit on a side hides it', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 1, max: 99 }),
        fc.constantFrom('a', 'Z', 'q', '7', '0', 'é', 'ж'),
        fc.boolean(),
        (season, episode, glue, before) => {
          const core = `s${String(season)}e${String(episode)}`;
          const pathname = before ? `/${glue}${core}` : `/${core}${glue}`;
          // A digit after the episode extends its number instead (`s1e12` is episode 12).
          if (!before && /\d/u.test(glue)) {
            expect(addressNumbers(at({ pathname }))).toEqual({
              season,
              episode: Number(`${String(episode)}${glue}`),
            });
            return;
          }
          expect(addressNumbers(at({ pathname }))).toBeNull();
        },
      ),
      { seed: SEED },
    );
  });
});

describe('words', () => {
  test.each([
    '/season-5/episode-1',
    '/season/5/episode/1',
    '/season-5-episode-1',
    '/show/Season-5/Episode-1',
    '/season-5/episode/1',
    // Nothing between a number and the next word is unambiguous: a digit ends the number.
    '/season-5episode-1',
    '/season5/episode1',
  ])('%s', (pathname) => {
    expect(addressNumbers(at({ pathname }))).toEqual(FIVE_ONE);
  });

  test.each(['/preseason-5/episode-1', '/season-5/episodes-1'])(
    '%s is not the form',
    (pathname) => {
      expect(addressNumbers(at({ pathname }))).toBeNull();
    },
  );

  test('words are read in the hash and the query too, as every form is', () => {
    expect(addressNumbers(at({ hash: '#season-5/episode-1' }))).toEqual(FIVE_ONE);
    expect(addressNumbers(at({ query: { p: 'season-5/episode-1' } }))).toEqual(FIVE_ONE);
  });
});

describe('parameters', () => {
  test.each([
    { query: { season: '5', episode: '1' } },
    { query: { episode: '1', season: '5' } },
    { query: { s: '5', e: '1' } },
    { query: { s: '5', ep: '1' } },
    { query: { Season: '5', EPISODE: '1' } },
    { query: { season: '05', episode: '001' } },
    { hash: '#season=5&episode=1' },
    { hash: '#s=5;e=1' },
    { hash: '#/watch?e=1&s=5' },
    { hash: '#a=b&season=5&episode=1&c=d' },
    { query: { season: '5' }, hash: '#episode=1' },
  ])('%j is season 5, episode 1', (over) => {
    expect(addressNumbers(at(over))).toEqual(FIVE_ONE);
  });

  test.each([
    { query: { season: '5' } },
    { query: { episode: '1' } },
    { query: { season: '5x', episode: '1' } },
    { query: { season: '', episode: '1' } },
    { query: { season: '-5', episode: '1' } },
    { query: { season: '5.0', episode: '1' } },
    { query: { subseason: '5', episode: '1' } },
    { query: { season: '5', episodes: '1' } },
    { hash: '#xs=5&e=1' },
  ])('%j names nothing', (over) => {
    expect(addressNumbers(at(over))).toBeNull();
  });

  test('a parameter’s value must be digits only', () => {
    expect(addressNumbers(at({ hash: '#season=5x&episode=1' }))).toBeNull();
    expect(addressNumbers(at({ hash: '#season=5&episode=1x' }))).toBeNull();
  });
});

describe('exactly one pair', () => {
  test('two different pairs in one address name nothing', () => {
    expect(addressNumbers(at({ pathname: '/s1e1', hash: '#s2e1' }))).toBeNull();
    expect(addressNumbers(at({ pathname: '/s5e1/s5e2' }))).toBeNull();
    expect(addressNumbers(at({ pathname: '/season-1/episode-1', hash: '#s:2-e:2' }))).toBeNull();
    expect(addressNumbers(at({ query: { season: '5', episode: '1' }, hash: '#s5e2' }))).toBeNull();
  });

  test('the same pair written twice, in any forms, is one', () => {
    expect(
      addressNumbers(
        at({ pathname: '/s5e1/season-5/episode-1', query: { s: '5', e: '1' }, hash: '#s:5-e:1' }),
      ),
    ).toEqual(FIVE_ONE);
  });

  test('two seasons or two episodes among the parameters are two pairs', () => {
    expect(addressNumbers(at({ hash: '#season=5&season=6&episode=1' }))).toBeNull();
    expect(addressNumbers(at({ hash: '#season=5&episode=1&episode=2' }))).toBeNull();
  });

  test('a number past the bounds beside another pair still makes two', () => {
    // Season 10001 is past the bound, and a pair all the same.
    expect(addressNumbers(at({ pathname: '/s5e1', hash: '#s10001e1' }))).toBeNull();
    expect(addressNumbers(at({ pathname: '/s5e1', hash: '#s1e100001' }))).toBeNull();
  });

  test('a pair past the bounds alone names nothing', () => {
    expect(addressNumbers(at({ pathname: '/s10001e1' }))).toBeNull();
    expect(addressNumbers(at({ pathname: '/s1e100001' }))).toBeNull();
  });

  test('any two different pairs name nothing, whatever forms write them', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 1, max: 99 }),
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 1, max: 99 }),
        (s1, e1, s2, e2) => {
          fc.pre(s1 !== s2 || e1 !== e2);
          const pathname = `/s${String(s1)}e${String(e1)}`;
          const hash = `#season=${String(s2)}&episode=${String(e2)}`;
          expect(addressNumbers(at({ pathname, hash }))).toBeNull();
        },
      ),
      { seed: SEED },
    );
  });
});

describe('the wire’s bounds', () => {
  test('season 0 (specials) stands; episode 0 is no episode', () => {
    expect(addressNumbers(at({ pathname: '/s0e3' }))).toEqual({ season: 0, episode: 3 });
    expect(addressNumbers(at({ pathname: '/s0e0' }))).toBeNull();
    expect(addressNumbers(at({ pathname: '/s1e0' }))).toBeNull();
    expect(addressNumbers(at({ query: { season: '0', episode: '0' } }))).toBeNull();
  });

  test('the largest season and episode the wire takes are read; one more is not', () => {
    expect(addressNumbers(at({ pathname: `/s${String(SEASON_NUMBER_MAX)}e1` }))).toEqual({
      season: SEASON_NUMBER_MAX,
      episode: 1,
    });
    expect(addressNumbers(at({ pathname: `/s1e${String(EPISODE_NUMBER_MAX)}` }))).toEqual({
      season: 1,
      episode: EPISODE_NUMBER_MAX,
    });
    expect(addressNumbers(at({ pathname: `/s${String(SEASON_NUMBER_MAX + 1)}e1` }))).toBeNull();
    expect(addressNumbers(at({ pathname: `/s1e${String(EPISODE_NUMBER_MAX + 1)}` }))).toBeNull();
  });

  test('names a pair exactly when both numbers are in the wire’s bounds (up to six digits)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 999_999 }),
        fc.integer({ min: 0, max: 999_999 }),
        (season, episode) => {
          const read = addressNumbers(at({ pathname: `/s${String(season)}e${String(episode)}` }));
          const inBounds =
            season <= SEASON_NUMBER_MAX && episode >= 1 && episode <= EPISODE_NUMBER_MAX;
          expect(read).toEqual(inBounds ? { season, episode } : null);
        },
      ),
      { seed: SEED },
    );
  });
});

describe('where the address is read', () => {
  test('the host is not read', () => {
    expect(
      addressNumbers({ hostname: 's5e1.example', pathname: '/', query: {}, hash: '' }),
    ).toBeNull();
  });

  test('a frame without an address names nothing', () => {
    expect(addressNumbers(undefined)).toBeNull();
    expect(addressNumbers({})).toBeNull();
  });

  test('is total: whatever the address holds, it answers and does not throw', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 300 }),
        fc.dictionary(fc.string({ maxLength: 10 }), fc.string({ maxLength: 30 }), { maxKeys: 30 }),
        fc.string({ maxLength: 300 }),
        (pathname, query, hash) => {
          const read = addressNumbers(at({ pathname, query, hash }));
          if (read !== null) {
            expect(read.season).toBeGreaterThanOrEqual(0);
            expect(read.season).toBeLessThanOrEqual(SEASON_NUMBER_MAX);
            expect(read.episode).toBeGreaterThanOrEqual(1);
            expect(read.episode).toBeLessThanOrEqual(EPISODE_NUMBER_MAX);
          }
        },
      ),
      { seed: SEED },
    );
  });

  test('a very long path is read in bounded time', () => {
    const started = Date.now();
    addressNumbers(
      at({ pathname: `/${'s1e'.repeat(100_000)}`, hash: `#${'season='.repeat(50_000)}` }),
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
