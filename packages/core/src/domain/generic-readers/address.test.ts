/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The page's address, a generic reader. Every entry of `ADDRESS_FORMS` has its tests: addresses
// written the way its language writes them, and every word of it in every shape the reader reads
// words in — before its number with any separator, after it (whole words only), as a parameter's
// name, in any case, and percent-escaped.

import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { ADDRESS_FORMS, ADDRESS_QUERY_PARAMS, addressNumbers, readAddress } from './address';
import type { AddressForm } from './address';
import { snapshot } from './fixtures';

const SEED = 20_261_023;
const ONE_TWO = { season: 1, episode: 2 };

const url = (over: { pathname?: string; query?: Record<string, string>; hash?: string }) => ({
  hostname: 'series.example',
  pathname: '/',
  query: {},
  hash: '',
  ...over,
});

type Words = Exclude<AddressForm, { pattern: RegExp }>;
const WORDS: readonly Words[] = ADDRESS_FORMS.flatMap((f) => ('pattern' in f ? [] : [f]));
const seasonsOf = (w: Words) => [...w.season, ...(w.seasonShort ?? [])];
const episodesOf = (w: Words) => [...w.episode, ...(w.episodeShort ?? [])];

/**
 * Each entry's own addresses, as its language writes season 1, episode 2: the path as the
 * browser gives it, so a word with an accent is percent-escaped (`encodeURI`).
 */
const EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  en: [
    '/show/season-1/episode-2',
    '/show/season/1/episode/2',
    '/show/s01e02',
    '/Show.Name.S01E02.1080p.WEB.x264',
    '/s01-e02',
    '/se1-ep2',
    '/ss1/ep2',
    '/season1-ep2',
    '/s1.e2',
    '/s/1/e/2',
    '/s1/e2',
    '/watch/1-season/2-episode',
    '/80823-temnyy-demon-2025-latest/56-dublyazh/1-season/2-episode.html',
    '/1_season/2_episode',
    '/season-1-epi-2',
  ],
  es: [
    '/serie/la-casa/temporada-1/capitulo-2',
    '/temporada-1-episodio-2',
    encodeURI('/temporada-1/capítulo-2'),
    '/1-temporada/2-capitulo',
    '/temp-1-cap-2',
  ],
  pt: [
    encodeURI('/temporada-1/episódio-2'),
    '/temporada-1/episodio-2',
    encodeURI('/1-temporada-2-episódio'),
    '/temp1-cap2',
  ],
  fr: ['/saison-1/episode-2', encodeURI('/saison-1/épisode-2'), '/1-saison/2-episode'],
  de: ['/staffel-1/folge-2', '/staffel-1-episode-2', '/1-staffel/2-folge'],
  it: ['/stagione-1/episodio-2', '/stagione-1/puntata-2', '/1-stagione/2-puntata'],
  pl: ['/sezon-1/odcinek-2', '/1-sezon/2-odcinek'],
  nl: ['/seizoen-1/aflevering-2', '/1-seizoen-2-aflevering'],
  tr: ['/dizi/1-sezon-2-bolum-izle', encodeURI('/sezon-1/bölüm-2')],
  uk: [
    '/sezon-1/seriya-2',
    '/1-sezon/2-seriia',
    '/1-sezon-2-seria',
    '/sezon-1-epizod-2',
    encodeURI('/серіал/сезон-1/серія-2'),
    encodeURI('/1-сезон/2-епізод'),
  ],
  nxmm: ['/show/1x02', '/Show.Name.1x02.HDTV', '/show/01X02-pilot'],
};

test('every entry has its examples', () => {
  expect(Object.keys(EXAMPLES).sort()).toEqual(ADDRESS_FORMS.map((f) => f.id).sort());
});

test.each(Object.entries(EXAMPLES))('the %s entry’s addresses', (_id, paths) => {
  for (const pathname of paths) {
    expect(addressNumbers(url({ pathname })), pathname).toEqual(ONE_TWO);
  }
});

describe.each(WORDS.map((w) => [w.id, w] as const))('every word of the %s entry', (_id, w) => {
  const LETTER_NUMBER = ['', '-', '_', '.', ':', '=', '/'];
  const HALVES = ['', '-', '_', '.', '/', ':'];
  const number = (max: number, min = 1) => fc.integer({ min, max });

  test('before its number, with any season word and any episode word, any separators, any case', () => {
    fc.assert(
      fc.property(
        fc.mixedCase(fc.constantFrom(...seasonsOf(w))),
        fc.mixedCase(fc.constantFrom(...episodesOf(w))),
        fc.constantFrom(...LETTER_NUMBER),
        fc.constantFrom(...HALVES),
        number(9999, 0),
        number(99_999),
        (s, e, at, between, season, episode) => {
          const text = `${s}${at}${String(season)}${between}${e}${at}${String(episode)}`;
          for (const over of [
            { pathname: encodeURI(`/w/${text}/play`) },
            { pathname: `/w/${text}` },
            { hash: encodeURI(`#/${text}`) },
          ]) {
            expect(addressNumbers(url(over)), text).toEqual({ season, episode });
          }
        },
      ),
      { seed: SEED, numRuns: 200 },
    );
  });

  test('after its number, a whole word', () => {
    fc.assert(
      fc.property(
        fc.mixedCase(fc.constantFrom(...w.season)),
        fc.mixedCase(fc.constantFrom(...w.episode)),
        fc.constantFrom('', '-', '_', '.'),
        fc.constantFrom(...HALVES),
        number(9999, 0),
        number(99_999),
        (s, e, at, between, season, episode) => {
          const text = `${String(season)}${at}${s}${between}${String(episode)}${at}${e}`;
          expect(addressNumbers(url({ pathname: encodeURI(`/w/${text}.html`) })), text).toEqual({
            season,
            episode,
          });
        },
      ),
      { seed: SEED, numRuns: 100 },
    );
  });

  test('a short word is never read after its number', () => {
    for (const s of w.seasonShort ?? []) {
      for (const e of w.episodeShort ?? []) {
        for (const text of [`1-${s}-2-${e}`, `1${s}2${e}`, `1-${s}/2-${w.episode[0] ?? e}`]) {
          expect(addressNumbers(url({ pathname: `/${text}` })), text).toBeNull();
        }
      }
    }
  });

  test('as a parameter’s name, in the query or the hash, in any case', () => {
    fc.assert(
      fc.property(
        fc.mixedCase(fc.constantFrom(...seasonsOf(w))),
        fc.mixedCase(fc.constantFrom(...episodesOf(w))),
        number(9999, 0),
        number(99_999),
        (s, e, season, episode) => {
          const [sv, ev] = [String(season), String(episode)];
          for (const over of [
            { query: { [s]: sv, [e]: ev } },
            { hash: encodeURI(`#${e}=${ev}&${s}=${sv}`) },
            { query: { [s]: sv }, hash: encodeURI(`#/watch?${e}=${ev}`) },
          ]) {
            expect(addressNumbers(url(over)), `${s} ${e}`).toEqual({ season, episode });
          }
        },
      ),
      { seed: SEED, numRuns: 100 },
    );
  });

  test('a word inside a longer word is not that word', () => {
    for (const s of w.season) {
      for (const e of w.episode) {
        for (const text of [
          `x${s}-1-${e}-2`,
          `${s}-1-${e}s-2`,
          `1-${s}x-2-${e}`,
          `1-${s}-2-${e}x`,
        ]) {
          expect(addressNumbers(url({ pathname: encodeURI(`/${text}`) })), text).toBeNull();
        }
      }
    }
  });
});

test('any language’s season word pairs with any language’s episode word', () => {
  expect(addressNumbers(url({ pathname: '/staffel-1/epizod-2' }))).toEqual(ONE_TWO);
  expect(addressNumbers(url({ pathname: '/sezon-1-episode-2' }))).toEqual(ONE_TWO);
});

describe('the nxmm entry', () => {
  test.each(['/show/1x02', '/show/12x10', '#1x02', '/s/9X99'])('%s is read', (path) => {
    const over = path.startsWith('#') ? { hash: path } : { pathname: path };
    expect(addressNumbers(url(over))).not.toBeNull();
  });

  test.each([
    '/1x2',
    '/123x45',
    '/1x234',
    '/a1x02',
    '/1x02b',
    '/24x36x2',
    '/1920x1080',
    '/1280x720',
    '/640x480',
    '/3840x2160',
    '/x264',
    '/x265',
  ])('%s is not', (pathname) => {
    expect(addressNumbers(url({ pathname }))).toBeNull();
  });
});

test('the parameters read are every word of every entry, once each, in lowercase', () => {
  const every = new Set(WORDS.flatMap((w) => [...seasonsOf(w), ...episodesOf(w)]));
  expect(new Set(ADDRESS_QUERY_PARAMS)).toEqual(every);
  expect(ADDRESS_QUERY_PARAMS).toHaveLength(every.size);
  for (const name of ADDRESS_QUERY_PARAMS) expect(name).toBe(name.toLowerCase());
});

test('every word is written in lowercase, composed, and in no other entry’s other half', () => {
  const seasons = new Set(WORDS.flatMap(seasonsOf));
  for (const w of WORDS) {
    for (const word of [...seasonsOf(w), ...episodesOf(w)]) {
      expect(word).toBe(word.toLowerCase().normalize('NFC'));
    }
    for (const word of episodesOf(w)) expect(seasons.has(word), word).toBe(false);
  }
});

// Words an address uses for something else: a start time (`?t=120`, `#t:221`), the show or the
// title itself (`/series/123`), a page, a version, a codec's letter. None may become a word here.
test.each(['t', 'p', 'v', 'x', 'h', 'id', 'series', 'serie', 'show', 'title', 'part', 'page'])(
  '%s is no word of any entry',
  (word) => {
    for (const w of WORDS) expect([...seasonsOf(w), ...episodesOf(w)]).not.toContain(word);
  },
);

test('a word that names the show itself is no season word', () => {
  for (const pathname of ['/series/123/episode/4', '/serie/123/episodio/4', '/show/123/ep/4']) {
    expect(addressNumbers(url({ pathname })), pathname).toBeNull();
  }
});

test('the field capture: an episode by its numbers, at the least trust', () => {
  const f = <T>(value: T) => ({ value, confidence: 0.3, source: 'address' as const });
  expect(readAddress(snapshot({ url: url({ hash: '#t:221-s:5-e:1' }) }))).toEqual({
    kind: f('episode'),
    season: f(5),
    episode: f(1),
  });
  expect(readAddress(snapshot())).toBeNull();
});

test('total: a hostile address never throws', () => {
  for (const hostile of [
    null,
    5,
    { pathname: 3, query: [1], hash: {} },
    { query: { s: 5 } },
    { pathname: '/%E0%A4%A/%FF%FE/s1e2', query: {}, hash: '#%' },
  ]) {
    expect(() => addressNumbers(hostile)).not.toThrow();
  }
});

test('is read in bounded time, whatever the address holds', () => {
  const fillers = [
    'season-1-',
    'sezon-',
    '%C3%A9',
    '%D1%81',
    '1-season-',
    's1e',
    '1x0',
    '99999999',
  ];
  const started = Date.now();
  for (const filler of fillers) {
    const query = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`s${String(i)}`, filler.repeat(1000)]),
    );
    const long = filler.repeat(10_000);
    addressNumbers(url({ pathname: `/${long}`, hash: `#${long}`, query }));
  }
  expect(Date.now() - started).toBeLessThan(1000);
});

test('a broken escape is kept as written, and the rest of the address is still read', () => {
  expect(addressNumbers(url({ pathname: '/%E0%A4%A/s1e2' }))).toEqual(ONE_TWO);
  expect(addressNumbers(url({ pathname: '/%FF/season-1/episode-2' }))).toEqual(ONE_TWO);
});

test('an accent written decomposed reads as the composed word', () => {
  const decomposed = '/saison-1/épisode-2';
  expect(addressNumbers(url({ pathname: decomposed }))).toEqual(ONE_TWO);
  expect(addressNumbers(url({ pathname: encodeURI(decomposed) }))).toEqual(ONE_TWO);
});
