/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from 'vitest';
import { snapshot } from './fixtures';
import { readGeneric } from './index';
import { workTitle } from './shared';
import { mergeReadings } from '../reading';

test('the readers run in order of trust: 0.8, 0.7, 0.6, 0.4', () => {
  const readings = readGeneric(
    snapshot({
      documentTitle: 'Lost S1E1',
      jsonLd: [{ '@type': 'TVEpisode', name: 'Pilot', episodeNumber: 1 }],
      mediaSession: { title: 'Lost S1E1' },
      openGraph: { 'og:type': 'video.episode' },
    }),
  );
  expect(readings.map((r) => r.kind?.confidence)).toEqual([0.8, 0.7, 0.6, 0.4]);
  expect(readings.map((r) => r.kind?.source)).toEqual([
    'json-ld',
    'media-session',
    'open-graph',
    'document-title',
  ]);
});

test('readers with nothing to say are left out', () => {
  expect(readGeneric(snapshot())).toEqual([]);
  expect(readGeneric(snapshot({ documentTitle: 'Lost S1E1' }))).toHaveLength(1);
});

test('a JSON-LD Movie with a duration still yields no stated duration', () => {
  const merged = mergeReadings(
    null,
    readGeneric(snapshot({ jsonLd: [{ '@type': 'Movie', name: 'Long', duration: 'PT2H35M' }] })),
  );
  expect(merged.title).toBe('Long');
  expect(merged.contentDurationSeconds).toBeUndefined();
});

test('the graph episode, the series id and the label agree through the merge', () => {
  const merged = mergeReadings(
    null,
    readGeneric(
      snapshot({
        documentTitle: 'Breaking Bad S1E2 - Netflix',
        jsonLd: [
          {
            '@graph': [
              {
                '@type': 'TVEpisode',
                name: "Cat's in the Bag...",
                episodeNumber: 2,
                partOfSeason: { seasonNumber: 1 },
                partOfSeries: {
                  name: 'Breaking Bad',
                  sameAs: 'https://www.imdb.com/title/tt0903747/',
                },
              },
            ],
          },
        ],
      }),
    ),
  );
  expect(merged).toMatchObject({
    kind: 'episode',
    showTitle: 'Breaking Bad',
    season: 1,
    episode: 2,
    showIds: { imdb: 'tt0903747' },
  });
});

// A page captured from a real site, read again.
test('a series page whose address names the episode is an episode of the show', () => {
  const merged = mergeReadings(
    null,
    readGeneric(
      snapshot({
        url: { hostname: 'series.example', pathname: '/w/221', query: {}, hash: '#t:221-s:5-e:1' },
        openGraph: {
          'og:type': 'video.tv_series',
          'og:title': 'Киллер с ножницами / Киллер Севен (2020)',
        },
      }),
    ),
  );
  expect(merged).toEqual({
    kind: 'episode',
    showTitle: 'Киллер с ножницами',
    showYear: 2020,
    season: 5,
    episode: 1,
    sources: ['open-graph', 'address'],
  });
});

test.each([
  ['Name (2020)', { name: 'Name', year: 2020 }],
  ['Local name / Original name', { name: 'Local name' }],
  ['A / B / C', { name: 'A / B / C' }],
  ['Fate/Zero', { name: 'Fate/Zero' }],
  ['Face/Off (1997)', { name: 'Face/Off', year: 1997 }],
  ['Metropolis (1026)', { name: 'Metropolis (1026)' }],
  ['(2020)', { name: '(2020)' }],
])('a work title: workTitle(%s)', (raw, expected) => {
  expect(workTitle(raw)).toEqual(expected);
});

test('total: hostile snapshots never throw', () => {
  const hostile = {
    documentTitle: 5,
    jsonLd: [{ '@type': 'Movie', name: { x: 1 } }, null, 3],
    mediaSession: { title: [] },
    openGraph: { 'og:type': 9 },
    selectors: 'x',
  } as unknown as Parameters<typeof snapshot>[0];
  expect(() => readGeneric(snapshot(hostile))).not.toThrow();
});
