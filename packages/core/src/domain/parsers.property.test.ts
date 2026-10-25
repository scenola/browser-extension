/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Property-based tests (fast-check, fixed seed) for every core parser that reads hostile input —
// the label grammar, title normalisation, the generic readers and the capture sanitiser. The
// properties come from what each parser promises, never from the code:
//
// - total: arbitrary input never throws (inputs you do not control are hostile);
// - bounded: what comes out is within the wire's bounds (the server's own limits), and the work
//   is bounded (a generous time cap, ≥ 200 ms);
// - the label grammar gives back the numbers of every form it and the locale tables document;
// - `normalizeTitle` is a comparison form, so normalising twice changes nothing;
// - the sanitiser's output holds no e-mail, JWT, Scenola token or URL query, and no value
//   under a key naming the person.
//
// The seed is fixed so CI runs the same cases.

import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { readJsonLd } from './generic-readers/json-ld';
import { readMediaSession } from './generic-readers/media-session';
import { readOpenGraph } from './generic-readers/open-graph';
import { readDocumentTitle } from './generic-readers/document-title';
import { readGeneric } from './generic-readers';
import { LABEL_LOCALES, findEpisodeLabel, parseEpisodeLabel } from './labels';
import { buildPlay } from './play';
import { mergeReadings } from './reading';
import type { ServiceReading } from './reading';
import { sanitizeSnapshot } from './sanitize';
import type { Snapshot } from './snapshot';
import { normalizeTitle } from './titles';
import { newViewing } from './viewing';

const SEED = 20_261_022;
const RUNS = { seed: SEED, numRuns: 400 } as const;

// The wire's bounds, as the server states them — written here, not imported, so a drifted
// constant in core is caught.
const WIRE = {
  titleCodePoints: 200,
  seasonMax: 10_000,
  episodeMax: 100_000,
  yearMin: 1870,
  yearMax: 2200,
  imdb: /^tt[0-9]{5,10}$/u,
  bodyBytes: 16 * 1024,
} as const;

/** A time cap per call: generous, never tighter than 200 ms, so a slow CI runner does not flake. */
const TIME_CAP_MS = 1000;

const codePoints = (s: string): number => Array.from(s).length;

/** UTF-8 length by the encoding's definition (1–4 bytes by code point; RFC 3629). */
function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

function timed<T>(run: () => T): { readonly value: T; readonly ms: number } {
  const start = Date.now();
  const value = run();
  return { value, ms: Date.now() - start };
}

// ---------------------------------------------------------------------------------------------
// The label grammar

/** Text made of what labels are made of, so the regexes meet near-misses, not just noise. */
const labelish = fc
  .array(
    fc.oneof(
      fc.constantFrom('S', 's', 'E', 'e', 'x', 'X', ':', ',', '.', ' ', '-', '|', '第', '季', '集'),
      fc.constantFrom('season', 'Season ', 'episode', 'Ep.', 'Staffel', 'Folge', 'シーズン'),
      fc.constant('시즌'),
      fc.constantFrom('話', '화', 'cm', 'poster ', 'Сезон', 'Серія', 'T'),
      fc.integer({ min: 0, max: 99_999 }).map(String),
      fc.string({ maxLength: 3 }),
    ),
    { maxLength: 60 },
  )
  .map((parts) => parts.join(''));

const anyText = fc.oneof(
  fc.string({ maxLength: 400 }),
  fc.string({ unit: 'binary', maxLength: 400 }),
  fc.string({ unit: 'grapheme', maxLength: 200 }),
  labelish,
);

describe('the label grammar is total and its numbers fit the wire', () => {
  test('parseEpisodeLabel never throws, and answers null or whole numbers in the wire range', () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const label = parseEpisodeLabel(text);
        if (label === null) return;
        expect(Number.isInteger(label.season)).toBe(true);
        expect(Number.isInteger(label.episode)).toBe(true);
        expect(label.season).toBeGreaterThanOrEqual(0);
        expect(label.season).toBeLessThanOrEqual(WIRE.seasonMax);
        expect(label.episode).toBeGreaterThanOrEqual(0);
        expect(label.episode).toBeLessThanOrEqual(WIRE.episodeMax);
      }),
      RUNS,
    );
  });

  test('findEpisodeLabel never throws, and answers the same numbers as parseEpisodeLabel', () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const found = findEpisodeLabel(text);
        const parsed = parseEpisodeLabel(text);
        expect(found === null).toBe(parsed === null);
        if (found !== null && parsed !== null) {
          expect([found.season, found.episode]).toEqual([parsed.season, parsed.episode]);
          expect(found.index).toBeGreaterThanOrEqual(0);
          expect(found.length).toBeGreaterThan(0);
        }
      }),
      RUNS,
    );
  });

  test('the work is bounded: a megabyte of near-misses is answered inside the time cap', () => {
    const near = 'Season 1, Season 1 Ep. Ep. 1x1x1x S1:S1: 第1季 시즌 1 '.repeat(20_000);
    for (const text of [near, ' '.repeat(1_000_000), `${'9'.repeat(1_000_000)}x10`]) {
      const { ms } = timed(() => [parseEpisodeLabel(text), findEpisodeLabel(text)]);
      expect(ms).toBeLessThan(TIME_CAP_MS);
    }
  });
});

describe('the label grammar gives back the numbers of every form it documents', () => {
  const season = fc.integer({ min: 1, max: 99 });
  const episode = fc.integer({ min: 1, max: 999 });
  const twoDigit = fc.integer({ min: 1, max: 99 });

  // The forms the grammar reads, each with any numbers in place of 1 and 2.
  const FORMS: readonly (readonly [string, (s: number, e: number) => string])[] = [
    ['S1:E2', (s, e) => `S${String(s)}:E${String(e)}`],
    ['S1 E2', (s, e) => `S${String(s)} E${String(e)}`],
    ['Season 1, Ep. 2', (s, e) => `Season ${String(s)}, Ep. ${String(e)}`],
    ['T1:E2 (Temporada)', (s, e) => `T${String(s)}:E${String(e)}`],
    ['Staffel 1, Folge 2', (s, e) => `Staffel ${String(s)}, Folge ${String(e)}`],
    ['Saison 1, épisode 2', (s, e) => `Saison ${String(s)}, épisode ${String(e)}`],
    ['Сезон 1, Серія 2', (s, e) => `Сезон ${String(s)}, Серія ${String(e)}`],
    ['第1季 第2集', (s, e) => `第${String(s)}季 第${String(e)}集`],
    ['シーズン1 第2話', (s, e) => `シーズン${String(s)} 第${String(e)}話`],
    ['시즌 1 2화', (s, e) => `시즌 ${String(s)} ${String(e)}화`],
  ];

  test.each(FORMS)('%s', (_form, format) => {
    fc.assert(
      fc.property(season, episode, (s, e) => {
        expect(parseEpisodeLabel(format(s, e))).toEqual({ season: s, episode: e });
      }),
      RUNS,
    );
  });

  test('1x02 (a two-digit episode)', () => {
    fc.assert(
      fc.property(season, twoDigit, (s, e) => {
        const text = `${String(s)}x${String(e).padStart(2, '0')}`;
        expect(parseEpisodeLabel(text)).toEqual({ season: s, episode: e });
      }),
      RUNS,
    );
  });

  // Locale tables are data with a test per entry: every season word with every episode word of
  // its table, in any letter case, written as the forms above are.
  const wordLocales = LABEL_LOCALES.filter((l) => l.season.length > 0 && l.episode.length > 0);
  test.each(wordLocales.map((l) => [l.id, l] as const))('the %s table', (_id, locale) => {
    fc.assert(
      fc.property(
        fc.mixedCase(fc.constantFrom(...locale.season)),
        fc.mixedCase(fc.constantFrom(...locale.episode)),
        fc.constantFrom(', ', ' ', ':'),
        season,
        episode,
        (seasonWord, episodeWord, separator, s, e) => {
          const text = `${seasonWord} ${String(s)}${separator}${episodeWord} ${String(e)}`;
          expect(parseEpisodeLabel(text)).toEqual({ season: s, episode: e });
        },
      ),
      RUNS,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Title normalisation

describe('normalizeTitle is a comparison form', () => {
  test('it never throws, and normalising twice changes nothing', () => {
    fc.assert(
      fc.property(anyText, (text) => {
        const once = normalizeTitle(text);
        expect(normalizeTitle(once)).toBe(once);
      }),
      { ...RUNS, numRuns: 2000 },
    );
  });

  test('its work is bounded: a megabyte of marks and symbols is answered inside the time cap', () => {
    const text = 'É&(1999) ́́́ ﷺ '.repeat(80_000);
    expect(timed(() => normalizeTitle(text)).ms).toBeLessThan(TIME_CAP_MS);
  });
});

// ---------------------------------------------------------------------------------------------
// The generic readers

const anyValue = fc.oneof(
  fc.string({ maxLength: 600 }),
  fc.string({ unit: 'binary', maxLength: 600 }),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.string({ maxLength: 20 }), { maxLength: 4 }),
  fc.object({ maxDepth: 2 }),
);

const isoDate = fc.date({ noInvalidDate: true }).map((d) => d.toISOString());

/** A schema.org node: the keys the readers look for, holding anything. */
const ldNode = fc.record(
  {
    '@type': fc.oneof(
      fc.constantFrom('Movie', 'TVEpisode', 'Episode', 'TVSeries', 'VideoObject'),
      fc.array(fc.constantFrom('Movie', 'TVEpisode', 'Thing'), { maxLength: 3 }),
      anyValue,
    ),
    name: anyValue,
    datePublished: fc.oneof(isoDate, anyValue),
    episodeNumber: fc.oneof(fc.integer(), fc.integer().map(String), anyValue),
    partOfSeason: fc.oneof(
      fc.record({ seasonNumber: fc.oneof(fc.integer(), fc.integer().map(String), anyValue) }),
      anyValue,
    ),
    partOfSeries: fc.oneof(fc.record({ name: anyValue, startDate: anyValue }), anyValue),
    sameAs: fc.oneof(
      fc.stringMatching(/^https:\/\/www\.imdb\.com\/title\/tt\d{1,14}\/?$/u),
      fc.array(anyValue, { maxLength: 3 }),
      anyValue,
    ),
    '@graph': fc.array(anyValue, { maxLength: 3 }),
  },
  { requiredKeys: [] },
);

const snapshot: fc.Arbitrary<Snapshot> = fc.record({
  url: fc.record({
    hostname: fc.constant('www.example.com'),
    pathname: fc.string({ maxLength: 40 }),
    query: fc.dictionary(fc.string({ maxLength: 8 }), fc.string({ maxLength: 20 }), {
      maxKeys: 3,
    }),
    hash: fc.string({ maxLength: 20 }),
  }),
  lang: fc.option(fc.constantFrom('en', 'de', 'ja'), { nil: null }),
  documentTitle: anyText,
  selectors: fc.dictionary(fc.string({ maxLength: 8 }), fc.array(fc.string({ maxLength: 40 })), {
    maxKeys: 3,
  }),
  jsonLd: fc.array(fc.oneof(ldNode, fc.array(ldNode, { maxLength: 3 }), anyValue), {
    maxLength: 6,
  }),
  mediaSession: fc.option(
    fc.record({ title: anyText, artist: anyText, album: anyText }, { requiredKeys: [] }),
    { nil: null },
  ),
  openGraph: fc.oneof(
    fc.dictionary(
      fc.constantFrom('og:type', 'og:title', 'video:series', 'video:release_date', 'og:x'),
      fc.oneof(fc.constantFrom('video.movie', 'video.episode', 'video.other'), anyText),
    ),
    fc.dictionary(fc.string({ maxLength: 12 }), fc.string({ maxLength: 40 })),
  ),
  pageState: fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue({ maxDepth: 3 }), {
    maxKeys: 3,
  }),
  signals: fc.record({ endOfContent: fc.boolean(), adPlaying: fc.boolean() }),
});

/** An empty page with the given parts. */
function withPage(parts: Partial<Snapshot>): Snapshot {
  return {
    url: { hostname: 'www.example.com', pathname: '/', query: {}, hash: '' },
    lang: 'en',
    documentTitle: '',
    selectors: {},
    jsonLd: [],
    mediaSession: null,
    openGraph: {},
    pageState: {},
    signals: { endOfContent: false, adPlaying: false },
    ...parts,
  };
}

/** Every bound a reading's value must keep to reach the wire as it is. */
function expectWithinWireBounds(r: ServiceReading): void {
  for (const f of [r.title, r.showTitle, r.episodeTitle]) {
    if (f === undefined) continue;
    expect(typeof f.value).toBe('string');
    expect(codePoints(f.value)).toBeLessThanOrEqual(WIRE.titleCodePoints);
  }
  for (const f of [r.year, r.showYear]) {
    if (f === undefined) continue;
    expect(Number.isInteger(f.value)).toBe(true);
    expect(f.value).toBeGreaterThanOrEqual(WIRE.yearMin);
    expect(f.value).toBeLessThanOrEqual(WIRE.yearMax);
  }
  if (r.season !== undefined) {
    expect(Number.isInteger(r.season.value)).toBe(true);
    expect(r.season.value).toBeGreaterThanOrEqual(0);
    expect(r.season.value).toBeLessThanOrEqual(WIRE.seasonMax);
  }
  if (r.episode !== undefined) {
    expect(Number.isInteger(r.episode.value)).toBe(true);
    expect(r.episode.value).toBeGreaterThanOrEqual(0);
    expect(r.episode.value).toBeLessThanOrEqual(WIRE.episodeMax);
  }
  for (const ids of [r.ids?.value, r.showIds?.value]) {
    if (ids?.imdb !== undefined) expect(ids.imdb).toMatch(WIRE.imdb);
  }
  for (const f of [r.kind, r.title, r.showTitle, r.season, r.episode, r.year, r.ids]) {
    if (f === undefined) continue;
    expect(f.confidence).toBeGreaterThanOrEqual(0);
    expect(f.confidence).toBeLessThanOrEqual(1);
  }
}

describe("the generic readers are total and keep to the wire's bounds", () => {
  const READERS = [
    ['JSON-LD', readJsonLd],
    ['Media Session', readMediaSession],
    ['Open Graph', readOpenGraph],
    ['the document title', readDocumentTitle],
  ] as const;

  test.each(READERS)('%s never throws on any snapshot', (_name, read) => {
    fc.assert(
      fc.property(snapshot, (s) => {
        read(s);
      }),
      RUNS,
    );
  });

  const junk = fc.record({
    url: anyValue,
    documentTitle: anyValue,
    jsonLd: anyValue,
    mediaSession: anyValue,
    openGraph: anyValue,
    selectors: anyValue,
    pageState: anyValue,
    signals: anyValue,
    lang: anyValue,
  });

  test.each(READERS)('%s never throws on fields of the wrong type', (_name, read) => {
    fc.assert(
      fc.property(junk, (j) => {
        read(j as unknown as Snapshot);
      }),
      RUNS,
    );
  });

  test.each(READERS)("%s's reading stays within the wire's bounds", (_name, read) => {
    fc.assert(
      fc.property(snapshot, (s) => {
        const r = read(s);
        if (r !== null) expectWithinWireBounds(r);
      }),
      RUNS,
    );
  });

  // One case per reader, so a numbers failure above cannot hide a titles one.
  const long = 'a'.repeat(300);
  test.each([
    ['JSON-LD', () => readJsonLd(withPage({ jsonLd: [{ '@type': 'Movie', name: long }] }))],
    [
      'Media Session',
      () => readMediaSession(withPage({ mediaSession: { title: `${long} S1:E2`, artist: long } })),
    ],
    [
      'Open Graph',
      () => readOpenGraph(withPage({ openGraph: { 'og:type': 'video.movie', 'og:title': long } })),
    ],
    ['the document title', () => readDocumentTitle(withPage({ documentTitle: `${long} - S1:E2` }))],
  ] as const)('%s keeps a 300-character title within 200 code points', (_name, read) => {
    const r = read();
    for (const f of [r?.title, r?.showTitle, r?.episodeTitle]) {
      if (f !== undefined) expect(codePoints(f.value)).toBeLessThanOrEqual(WIRE.titleCodePoints);
    }
  });

  test('whatever the readers say, the play built from it is within the wire bounds', () => {
    fc.assert(
      fc.property(snapshot, (s) => {
        const reading = mergeReadings(null, readGeneric(s));
        const viewing = newViewing({ id: 'v', serviceId: null, reading, at: 0, incognito: false });
        if (viewing === null) return;
        const body = buildPlay(viewing, 1_000_000_000_000, 60);
        if (body === null) return;
        for (const title of [body.title, body.show?.title]) {
          if (title !== undefined) expect(codePoints(title)).toBeLessThanOrEqual(200);
        }
        if (body.year !== undefined) expect(body.year).toBeGreaterThanOrEqual(WIRE.yearMin);
        if (body.year !== undefined) expect(body.year).toBeLessThanOrEqual(WIRE.yearMax);
        if (body.season_number !== undefined) {
          expect(body.season_number).toBeLessThanOrEqual(WIRE.seasonMax);
        }
        if (body.episode_number !== undefined) {
          expect(body.episode_number).toBeLessThanOrEqual(WIRE.episodeMax);
        }
        if (body.ids?.imdb !== undefined) expect(body.ids.imdb).toMatch(WIRE.imdb);
        expect(utf8Bytes(JSON.stringify(body))).toBeLessThanOrEqual(WIRE.bodyBytes);
      }),
      RUNS,
    );
  });

  test('the work is bounded: a page of a million JSON-LD nulls and a megabyte title are answered inside the time cap', () => {
    const base = fc.sample(snapshot, { seed: SEED, numRuns: 1 })[0];
    if (base === undefined) throw new RangeError('no sample');
    const huge: Snapshot = {
      ...base,
      jsonLd: new Array<unknown>(1_000_000).fill(null).concat([{ '@type': 'Movie', name: 'Late' }]),
      documentTitle: 'S1:E2 '.repeat(200_000),
      mediaSession: { title: 'x'.repeat(1_000_000) },
    };
    expect(timed(() => readGeneric(huge)).ms).toBeLessThan(TIME_CAP_MS);
  });
});

// ---------------------------------------------------------------------------------------------
// The capture sanitiser

const b64url = (min: number, max: number) =>
  fc.stringMatching(new RegExp(`^[A-Za-z0-9_-]{${String(min)},${String(max)}}$`, 'u'));

const email = fc
  .tuple(
    fc.stringMatching(/^[a-z0-9._%+-]{1,12}$/u),
    fc.stringMatching(/^[a-z0-9]{1,10}$/u),
    fc.constantFrom('com', 'org', 'co.uk', 'de'),
  )
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`);
const jwt = fc
  .tuple(b64url(4, 30), b64url(1, 40), b64url(0, 40))
  .map(([h, p, sig]) => `eyJ${h}.eyJ${p}.${sig}`);
const patToken = b64url(8, 40).map((t) => `mts_pat_${t}`);
const refreshToken = b64url(8, 40).map((t) => `mt_rt_${t}`);
const urlWithQuery = fc
  .tuple(fc.stringMatching(/^[a-z0-9]{1,10}$/u), fc.stringMatching(/^[a-z0-9]{1,8}$/u))
  .map(([path, value]) => `https://www.example.com/${path}?id=${value}`);

const secret = fc.oneof(email, jwt, patToken, refreshToken, urlWithQuery);
/** Text that holds no secret: no `@`, `.`, `_`, `:` or `?`. */
const plain = fc.stringMatching(/^[a-z0-9 ]{0,16}$/u);
const valueText = fc.oneof(
  { weight: 3, arbitrary: plain },
  { weight: 2, arbitrary: secret },
  {
    weight: 2,
    arbitrary: fc.tuple(plain, secret, plain).map(([a, s, b]) => `${a} ${s} ${b}`),
  },
);

const FORBIDDEN_KEY = /profile|account|email|user|token|session/iu;
const key = fc.oneof(
  { weight: 3, arbitrary: fc.stringMatching(/^[a-z]{1,10}$/u) },
  {
    weight: 2,
    arbitrary: fc
      .tuple(
        fc.stringMatching(/^[a-z]{0,4}$/u),
        fc.mixedCase(fc.constantFrom('profile', 'account', 'email', 'user', 'token', 'session')),
        fc.stringMatching(/^[A-Za-z]{0,4}$/u),
      )
      .map(([a, b, c]) => `${a}${b}${c}`),
  },
);

const tree: fc.Arbitrary<unknown> = fc.letrec<{ node: unknown }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    valueText,
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie('node'), { maxLength: 4 }),
    fc.dictionary(key, tie('node'), { maxKeys: 4 }),
  ),
})).node;

const name8 = fc.stringMatching(/^[a-z]{1,8}$/u);

const plantedSnapshot: fc.Arbitrary<Snapshot> = fc.record({
  url: fc.record({
    hostname: fc.constant('www.example.com'),
    pathname: fc.constant('/watch/1'),
    query: fc.dictionary(fc.stringMatching(/^[a-z]{1,6}$/u), valueText, { maxKeys: 3 }),
    hash: valueText,
  }),
  lang: fc.constant('en'),
  documentTitle: valueText,
  selectors: fc.dictionary(name8, fc.array(valueText, { maxLength: 5 }), { maxKeys: 3 }),
  jsonLd: fc.array(tree, { maxLength: 4 }),
  mediaSession: fc.option(
    fc.record({ title: valueText, artist: valueText, album: valueText }, { requiredKeys: [] }),
    { nil: null },
  ),
  openGraph: fc.dictionary(fc.stringMatching(/^og:[a-z]{1,6}$/u), valueText, { maxKeys: 3 }),
  // Top-level page-state names are a module's entry names; the nested keys are the page's.
  pageState: fc.dictionary(fc.stringMatching(/^[a-z]{1,8}$/u), tree, { maxKeys: 3 }),
  signals: fc.record({ endOfContent: fc.boolean(), adPlaying: fc.boolean() }),
});

// The oracles: my own spelling of each "looks like the person", not the sanitiser's.
const EMAIL_IN = /[A-Za-z0-9._%+-]@[A-Za-z0-9-]+\.[A-Za-z0-9-]+/u;
const JWT_IN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./u;
const URL_QUERY_IN = /[a-z][a-z0-9+.-]*:\/\/[^\s"#?]*\?/iu;

function personalIn(text: string): string | null {
  if (EMAIL_IN.test(text)) return 'an e-mail';
  if (JWT_IN.test(text)) return 'a JWT';
  if (text.includes('mts_')) return 'an mts_ token';
  if (text.includes('mt_rt_')) return 'an mt_rt_ token';
  if (URL_QUERY_IN.test(text)) return 'a URL with a query';
  return null;
}

/** Every key at any depth of `value` that names the person. */
function forbiddenKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value as readonly unknown[]) forbiddenKeys(item, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(k)) out.push(k);
      forbiddenKeys(v, out);
    }
  }
  return out;
}

describe('the capture sanitiser leaves nothing that looks like the person', () => {
  test('its output holds no e-mail, JWT, mts_/mt_rt_ token or URL query, and no key naming the person in the page state or the JSON-LD', () => {
    fc.assert(
      fc.property(plantedSnapshot, (s) => {
        const out = sanitizeSnapshot(s);
        const { query, ...rest } = out.url;
        expect(personalIn(JSON.stringify({ ...out, url: rest }))).toBeNull();
        expect(Object.values(query).every((v) => v === '<redacted>')).toBe(true);
        expect(Object.keys(query).sort()).toEqual(Object.keys(s.url.query).sort());
        const nested = Object.values(out.pageState);
        expect(forbiddenKeys([nested, out.jsonLd])).toEqual([]);
      }),
      { ...RUNS, numRuns: 1000 },
    );
  });

  test('it never throws on a snapshot of the wrong shape inside its fields', () => {
    fc.assert(
      fc.property(snapshot, (s) => {
        sanitizeSnapshot(s);
      }),
      RUNS,
    );
  });

  test('its work is bounded: a page state nested a hundred thousand deep is answered inside the time cap', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    const base = must(fc.sample(plantedSnapshot, { seed: SEED, numRuns: 1 })[0]);
    const s: Snapshot = { ...base, pageState: { deep }, jsonLd: [deep] };
    expect(timed(() => sanitizeSnapshot(s)).ms).toBeLessThan(TIME_CAP_MS);
  });

  test('a page-state entry whose own name names the person is dropped with its value', () => {
    // A key that names the person is dropped with its value at any depth of the page state, and
    // the top level is a depth.
    const base = must(fc.sample(plantedSnapshot, { seed: SEED, numRuns: 1 })[0]);
    const out = sanitizeSnapshot({
      ...base,
      pageState: { userProfile: 'Jane', sessionToken: 'abc123', video: { id: 1 } },
    });
    expect(Object.keys(out.pageState)).toEqual(['video']);
  });

  test("an e-mail address in the URL's path is not left in the sample", () => {
    // The capture drops any value that looks like an account, profile, e-mail, token or URL
    // query.
    const base = must(fc.sample(plantedSnapshot, { seed: SEED, numRuns: 1 })[0]);
    const out = sanitizeSnapshot({
      ...base,
      url: { ...base.url, pathname: '/profiles/jane.doe@example.com/watch/1' },
    });
    expect(personalIn(out.url.pathname)).toBeNull();
  });
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new RangeError('expected a value');
  return value;
}
