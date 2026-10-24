/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from 'vitest';
import { snapshot } from './fixtures';
import { readJsonLd } from './json-ld';

const f = <T>(value: T) => ({ value, confidence: 0.8, source: 'json-ld' as const });

test('a Movie yields kind, title, year and the IMDb id', () => {
  const reading = readJsonLd(
    snapshot({
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'Movie',
          name: 'Dune: Part Two',
          datePublished: '2024-02-27',
          sameAs: ['https://example.com/x', 'https://www.imdb.com/title/tt15239678/'],
        },
      ],
    }),
  );
  expect(reading).toEqual({
    kind: f('movie'),
    title: f('Dune: Part Two'),
    year: f(2024),
    ids: f({ imdb: 'tt15239678' }),
  });
});

test('dateCreated is the year when datePublished is absent', () => {
  const reading = readJsonLd(
    snapshot({ jsonLd: [{ '@type': 'Movie', name: 'X', dateCreated: '1999' }] }),
  );
  expect(reading?.year).toEqual(f(1999));
});

test('a TVEpisode inside an @graph carries the series, season and its IMDb id', () => {
  const reading = readJsonLd(
    snapshot({
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@graph': [
            { '@type': 'WebSite', name: 'Somewhere' },
            {
              '@type': 'TVEpisode',
              name: "Cat's in the Bag...",
              episodeNumber: '2',
              partOfSeason: { '@type': 'TVSeason', seasonNumber: 1 },
              partOfSeries: {
                '@type': 'TVSeries',
                name: 'Breaking Bad',
                startDate: '2008-01-20',
                sameAs: 'https://www.imdb.com/title/tt0903747/',
              },
            },
          ],
        },
      ],
    }),
  );
  expect(reading).toEqual({
    kind: f('episode'),
    episodeTitle: f("Cat's in the Bag..."),
    episode: f(2),
    season: f(1),
    showTitle: f('Breaking Bad'),
    showYear: f(2008),
    showIds: f({ imdb: 'tt0903747' }),
  });
});

test('the episode own url can state its IMDb id', () => {
  const reading = readJsonLd(
    snapshot({
      jsonLd: [{ '@type': 'TVEpisode', name: 'Pilot', url: 'http://imdb.com/title/tt0959621' }],
    }),
  );
  expect(reading?.ids).toEqual(f({ imdb: 'tt0959621' }));
});

test('@type may be an array', () => {
  const reading = readJsonLd(
    snapshot({ jsonLd: [{ '@type': ['CreativeWork', 'Movie'], name: 'Heat' }] }),
  );
  expect(reading?.kind).toEqual(f('movie'));
});

test('an IMDb url that is not a title page states nothing', () => {
  const reading = readJsonLd(
    snapshot({
      jsonLd: [
        {
          '@type': 'Movie',
          name: 'X',
          sameAs: [
            'https://www.imdb.com/name/nm0000093/',
            'https://evil.com/?https://imdb.com/title/tt1234567',
          ],
        },
      ],
    }),
  );
  expect(reading?.ids).toBeUndefined();
});

test('a stated duration is never read: only a module may state one', () => {
  const reading = readJsonLd(
    snapshot({ jsonLd: [{ '@type': 'Movie', name: 'Long', duration: 'PT2H35M' }] }),
  );
  expect(reading).not.toBeNull();
  expect(reading).not.toHaveProperty('contentDurationSeconds');
});

test('the first subject wins and objects beyond the twentieth are not looked at', () => {
  const filler = Array.from({ length: 20 }, () => ({ '@type': 'Thing' }));
  expect(
    readJsonLd(snapshot({ jsonLd: [...filler, { '@type': 'Movie', name: 'Late' }] })),
  ).toBeNull();
  expect(
    readJsonLd(snapshot({ jsonLd: [...filler.slice(1), { '@type': 'Movie', name: 'On time' }] }))
      ?.title,
  ).toEqual(f('On time'));
});

test('a year outside 1870..2200 is no year', () => {
  expect(
    readJsonLd(snapshot({ jsonLd: [{ '@type': 'Movie', name: 'X', datePublished: '1700-01-01' }] }))
      ?.year,
  ).toBeUndefined();
});

test('nothing recognisable is null', () => {
  expect(readJsonLd(snapshot())).toBeNull();
  expect(readJsonLd(snapshot({ jsonLd: [{ '@type': 'Article', name: 'News' }] }))).toBeNull();
});

test('total: odd shapes never throw', () => {
  const odd: unknown[] = [
    null,
    undefined,
    7,
    'Movie',
    [],
    [[[['Movie']]]],
    { '@type': 5 },
    { '@type': null, name: 'x' },
    { '@type': 'Movie', name: 12, datePublished: 2024, sameAs: 5, url: {} },
    { '@type': 'Movie', name: ['a'], sameAs: [null, 3, ['https://imdb.com/title/tt1234567']] },
    {
      '@type': 'TVEpisode',
      name: {},
      episodeNumber: [1],
      partOfSeason: 'S1',
      partOfSeries: [null, 4],
    },
    {
      '@type': 'TVEpisode',
      episodeNumber: -3,
      partOfSeason: { seasonNumber: 'x' },
      partOfSeries: { name: 9 },
    },
    { '@graph': 'nope' },
    { '@graph': [null, { '@graph': [{ '@type': 'Movie', name: 'Deep' }] }] },
  ];
  for (const item of odd) {
    expect(() => readJsonLd(snapshot({ jsonLd: [item] }))).not.toThrow();
  }
  expect(() => readJsonLd(snapshot({ jsonLd: odd }))).not.toThrow();
  // not an array at all, as a hostile page could make it
  expect(() => readJsonLd(snapshot({ jsonLd: 'x' as unknown as never }))).not.toThrow();
});

test('a huge @graph or a huge array of nulls is bounded, not spread or walked', () => {
  const graph = Array.from({ length: 200_000 }, () => ({ '@type': 'Thing' }));
  const nulls = Array.from({ length: 1_000_000 }, () => null);
  for (const jsonLd of [[{ '@graph': graph }], nulls, [nulls], [{ '@graph': nulls }]]) {
    const start = Date.now();
    expect(() => readJsonLd(snapshot({ jsonLd }))).not.toThrow();
    expect(Date.now() - start).toBeLessThan(50);
  }
});

test('a subject past the examination budget is not found', () => {
  const nulls = Array.from({ length: 300 }, () => null);
  expect(
    readJsonLd(snapshot({ jsonLd: [...nulls, { '@type': 'Movie', name: 'Late' }] })),
  ).toBeNull();
});

test('a cyclic structure terminates', () => {
  const a: Record<string, unknown> = { '@type': 'Thing' };
  a['@graph'] = [a];
  expect(readJsonLd(snapshot({ jsonLd: [a] }))).toBeNull();
});

// The reader keeps to the server's bounds — EPISODE_NUMBER_MAX = 100_000 and
// SEASON_NUMBER_MAX = 10_000 — and a number past them is no number, never one capped to the limit.
test.each([
  [100_000, 10_000, 100_000, 10_000],
  [100_001, 10_001, undefined, undefined],
])('episode %i of season %i reads as episode %s of season %s', (ep, se, episode, season) => {
  const reading = readJsonLd(
    snapshot({
      jsonLd: [{ '@type': 'TVEpisode', episodeNumber: ep, partOfSeason: { seasonNumber: se } }],
    }),
  );
  expect(reading?.episode?.value).toBe(episode);
  expect(reading?.season?.value).toBe(season);
});

test('a title past 200 code points is cut there, as the play would cut it', () => {
  const reading = readJsonLd(
    snapshot({
      jsonLd: [
        {
          '@type': 'TVEpisode',
          name: 'é'.repeat(300),
          partOfSeries: { name: '𝐒'.repeat(250) },
        },
      ],
    }),
  );
  expect(reading?.episodeTitle?.value).toBe('é'.repeat(200));
  expect(reading?.showTitle?.value).toBe('𝐒'.repeat(200));
});
