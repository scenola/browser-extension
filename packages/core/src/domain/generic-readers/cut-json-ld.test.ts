/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What is cut from a page’s structured data before anything holds it: every object keeps only the
// fields the reader reads, at any depth, and `sameAs` and `url` keep only the IMDb title ids their
// values hold, each as its bare title link. Cutting must never change what the readers make of the
// page.

import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { entryVerdict } from '../entry-rule';
import { snapshot } from './fixtures';
import { JSON_LD_FIELDS, cutJsonLd, readJsonLd } from './json-ld';

const SEED = 20_261_023;
const TITLE = 'https://www.imdb.com/title/tt0903747/';

const cut = (x: unknown): unknown => cutJsonLd(x);

describe('sameAs and url keep only IMDb title links', () => {
  test.each([
    [TITLE, TITLE],
    ['http://imdb.com/title/tt0903747', TITLE],
    ['https://IMDB.com/title/TT0903747/', TITLE],
    ['https://www.imdb.com/title/tt09037/', 'https://www.imdb.com/title/tt09037/'],
    ['https://www.imdb.com/title/tt0903747123/', 'https://www.imdb.com/title/tt0903747123/'],
    [`  ${TITLE}  `, TITLE],
  ])('%j is kept as %j', (link, kept) => {
    expect(cut({ sameAs: link })).toEqual({ sameAs: kept });
    expect(cut({ url: link })).toEqual({ url: kept });
  });

  test.each([
    'https://www.imdb.com/title/tt0903747/?ref_=x',
    'https://www.imdb.com/title/tt0903747?ref_=nv_sr_srsg_0&visit=abc',
    'https://www.imdb.com/title/tt0903747/#cast',
    'https://www.imdb.com/title/tt0903747/episodes/?season=1',
  ])('%j keeps its id and nothing past it', (link) => {
    expect(cut({ sameAs: link })).toEqual({ sameAs: TITLE });
    expect(cut({ url: [link] })).toEqual({ url: [TITLE] });
    expect(readJsonLd(snapshot({ jsonLd: [cut({ '@type': 'Movie', sameAs: link })] }))).toEqual(
      readJsonLd(snapshot({ jsonLd: [{ '@type': 'Movie', sameAs: link }] })),
    );
  });

  test.each([
    'https://www.imdb.com/name/nm0000151/',
    'https://www.imdb.com/find?q=breaking+bad',
    'https://www.imdb.com/title/tt0903/',
    'https://www.imdb.com/title/tt09037471234/',
    'https://www.imdb.com/title/',
    'https://evil.example/title/tt0903747/',
    'https://imdb.com.evil.example/title/tt0903747/',
    'https://notimdb.com/title/tt0903747/',
    'https://evil.example/r?to=https://www.imdb.com/title/tt0903747/',
    'see https://www.imdb.com/title/tt0903747/',
    'https://series.example/watch/221',
    'https://social.example/show',
    'javascript:alert(1)//imdb.com/title/tt0903747',
    '',
    'tt0903747',
  ])('%j is dropped, and with it the key', (link) => {
    expect(cut({ name: 'X', sameAs: link, url: link })).toEqual({ name: 'X' });
  });

  test('in an array only the IMDb links stay; an array with none loses the key', () => {
    expect(cut({ sameAs: ['https://social.example/a', TITLE, 'https://x.example/?q=1'] })).toEqual({
      sameAs: [TITLE],
    });
    expect(cut({ sameAs: ['https://social.example/a', 'https://x.example/b'] })).toEqual({});
    expect(cut({ sameAs: [] })).toEqual({});
  });

  test.each([5, true, null, {}, { '@id': TITLE }, [5, null, {}]])(
    'a %j in place of a link is dropped',
    (junk) => {
      expect(cut({ sameAs: junk, url: junk })).toEqual({});
    },
  );
});

describe('every other field is cut, at any depth', () => {
  test('what is not on the list is removed from every object', () => {
    const out = cut({
      '@context': 'https://schema.org',
      '@id': 'https://series.example/x',
      '@type': 'TVEpisode',
      name: 'Pilot',
      image: 'https://img.example/pilot.jpg',
      thumbnailUrl: 'https://img.example/t.jpg',
      description: 'The first one',
      contentUrl: 'https://cdn.example/v.mp4',
      embedUrl: 'https://series.example/embed/1',
      duration: 'PT45M',
      author: { name: 'A', email: 'a@b.co' },
      potentialAction: { target: 'https://series.example/watch?x=1' },
      partOfSeason: { seasonNumber: 1, image: 'x', '@type': 'TVSeason' },
      partOfSeries: { name: 'Show', url: 'https://series.example/show', image: 'y' },
      '@graph': [{ '@type': 'Movie', name: 'Film', description: 'z', datePublished: '2020' }],
    });
    expect(out).toEqual({
      '@type': 'TVEpisode',
      name: 'Pilot',
      partOfSeason: { seasonNumber: 1, '@type': 'TVSeason' },
      partOfSeries: { name: 'Show' },
      '@graph': [{ '@type': 'Movie', name: 'Film', datePublished: '2020' }],
    });
  });

  test('every field on the list stays when it is there', () => {
    const node = Object.fromEntries(
      JSON_LD_FIELDS.map((key) => [key, key === 'sameAs' || key === 'url' ? TITLE : 'v']),
    );
    expect(cut(node)).toEqual(node);
  });

  test('arrays are cut member by member, in order', () => {
    expect(cut([{ name: 'a', image: 'i' }, 'text', 5, null, [{ name: 'b', x: 1 }]])).toEqual([
      { name: 'a' },
      'text',
      5,
      null,
      [{ name: 'b' }],
    ]);
  });

  test('a value that is not an object is returned as it is', () => {
    for (const x of ['text', 5, true, null, undefined]) expect(cut(x)).toBe(x);
  });

  test('a field is kept when it is the object’s own, not inherited', () => {
    const inherited = Object.create({ name: 'from the prototype' }) as Record<string, unknown>;
    expect(cut(inherited)).toEqual({});
  });

  test('is idempotent: cutting what was cut changes nothing', () => {
    const once = cut({
      '@type': 'Movie',
      name: 'X',
      image: 'i',
      sameAs: ['https://social.example/a', TITLE],
      partOfSeries: { name: 'S', x: 1 },
    });
    expect(cut(once)).toEqual(once);
  });

  test('holds no key off the list, at any depth, whatever it is given', () => {
    const keysOf = (x: unknown, out: Set<string>): Set<string> => {
      if (Array.isArray(x)) for (const m of x as unknown[]) keysOf(m, out);
      else if (typeof x === 'object' && x !== null) {
        for (const [k, v] of Object.entries(x)) {
          out.add(k);
          keysOf(v, out);
        }
      }
      return out;
    };
    const arbitrary = fc.letrec((tie) => ({
      value: fc.oneof(
        { depthSize: 'small' },
        fc.string(),
        fc.integer(),
        fc.constant(null),
        fc.array(tie('value'), { maxLength: 3 }),
        fc.dictionary(
          fc.oneof(
            fc.constantFrom(...JSON_LD_FIELDS, 'image', 'description'),
            fc.string({ maxLength: 4 }),
          ),
          tie('value'),
          { maxKeys: 5 },
        ),
      ),
    })).value;
    fc.assert(
      fc.property(arbitrary, (value) => {
        for (const key of keysOf(cut(value), new Set())) {
          expect(JSON_LD_FIELDS as readonly string[]).toContain(key);
        }
      }),
      { seed: SEED },
    );
  });
});

describe('cutting changes nothing the readers make of a page', () => {
  const NOISE = {
    '@context': 'https://schema.org',
    image: 'https://img.example/a.jpg',
    description: 'A description',
    thumbnailUrl: 'https://img.example/t.jpg',
    potentialAction: { target: 'https://series.example/watch?x=1' },
  };

  const nodes = [
    {
      '@type': 'Movie',
      name: 'Arrival (2016)',
      datePublished: '2016-11-11',
      sameAs: [TITLE, 'https://x.example'],
      ...NOISE,
    },
    { '@type': 'Movie', name: 'Heat', url: 'https://series.example/heat', ...NOISE },
    {
      '@type': 'TVEpisode',
      name: 'Pilot',
      episodeNumber: 1,
      partOfSeason: { '@type': 'TVSeason', seasonNumber: 1, ...NOISE },
      partOfSeries: {
        '@type': 'TVSeries',
        name: 'Show (2008)',
        startDate: '2008',
        sameAs: TITLE,
        ...NOISE,
      },
      ...NOISE,
    },
    { '@type': 'TVSeries', name: 'Show', ...NOISE },
    {
      '@graph': [
        { '@type': 'TVSeries', name: 'Show' },
        { '@type': 'TVEpisode', name: 'E', ...NOISE },
      ],
    },
    { '@type': 'Article', name: 'News', ...NOISE },
  ];

  test.each(nodes.map((n, i) => [i, n] as const))(
    'node %i reads the same cut or whole',
    (_i, node) => {
      const whole = snapshot({ jsonLd: [node] });
      const trimmed = snapshot({ jsonLd: [cut(node)] });
      expect(readJsonLd(trimmed)).toEqual(readJsonLd(whole));
      expect(entryVerdict(trimmed)).toBe(entryVerdict(whole));
    },
  );

  test('for any mix of those nodes', () => {
    fc.assert(
      fc.property(fc.subarray(nodes, { minLength: 1 }), (chosen) => {
        const whole = snapshot({ jsonLd: chosen });
        const trimmed = snapshot({ jsonLd: cut(chosen) as unknown[] });
        expect(readJsonLd(trimmed)).toEqual(readJsonLd(whole));
        expect(entryVerdict(trimmed)).toBe(entryVerdict(whole));
      }),
      { seed: SEED },
    );
  });
});
