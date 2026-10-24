/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The collector gathers only what a reader reads. The Open Graph property list and
// the JSON-LD field list are each held to what the readers read, both ways: every name a reader
// reads is listed, and every listed name is read.

import { expect, test } from 'vitest';
import { entryVerdict } from '../entry-rule';
import { snapshot } from './fixtures';
import { JSON_LD_FIELDS, cutJsonLd, readJsonLd } from './json-ld';
import { OPEN_GRAPH_PROPERTIES, readOpenGraph } from './open-graph';

/** `value`, every object of it recording the names read from it into `read`. */
function recording(value: unknown, read: Set<string>): unknown {
  if (typeof value !== 'object' || value === null) return value;
  return new Proxy(value, {
    get(target, key, receiver) {
      if (typeof key === 'string' && !Array.isArray(target)) read.add(key);
      return recording(Reflect.get(target, key, receiver) as unknown, read);
    },
  });
}

const IMDB = 'https://www.imdb.com/title/tt0903747/';

test('the Open Graph list is every property the readers read, and nothing else', () => {
  const read = new Set<string>();
  for (const type of ['video.movie', 'video.episode', 'video.tv_series', 'video.other']) {
    const openGraph = recording(
      {
        'og:type': type,
        'og:title': 'Name (2020)',
        'video:series': 'Show',
        'video:release_date': '2020-01-01',
      },
      read,
    ) as Record<string, string>;
    readOpenGraph(snapshot({ openGraph }));
    entryVerdict(snapshot({ openGraph }));
  }
  expect([...read].sort()).toEqual([...OPEN_GRAPH_PROPERTIES].sort());
});

test('the JSON-LD list is every field the reader reads, and nothing else', () => {
  const read = new Set<string>();
  const nodes = [
    { '@type': 'Movie', name: 'Film', datePublished: '2020', dateCreated: '2019', sameAs: IMDB },
    { '@type': 'Movie', name: 'Film', dateCreated: '2019', url: IMDB },
    {
      '@type': 'TVEpisode',
      name: 'Pilot',
      episodeNumber: 1,
      partOfSeason: { seasonNumber: 1 },
      partOfSeries: { name: 'Show', startDate: '2008', sameAs: [IMDB], url: IMDB },
      sameAs: [IMDB],
    },
    { '@type': 'TVSeries', name: 'Show', startDate: '2008', url: IMDB },
  ];
  for (const node of nodes) {
    const jsonLd = [recording({ '@graph': [node] }, read)];
    readJsonLd(snapshot({ jsonLd }));
    entryVerdict(snapshot({ jsonLd }));
  }
  expect([...read].sort()).toEqual([...JSON_LD_FIELDS].sort());
});

test('a node is cut to the list at every depth; sameAs and url keep only IMDb links', () => {
  expect(
    cutJsonLd({
      '@type': 'TVEpisode',
      name: 'Pilot',
      image: 'https://img.example/pilot.jpg',
      description: 'The first one',
      url: 'https://series.example/watch/1',
      sameAs: ['https://social.example/show', IMDB],
      partOfSeries: { name: 'Show', url: 'https://series.example/show', thumbnailUrl: 'x' },
      '@graph': [{ '@type': 'Movie', potentialAction: { target: 'https://series.example' } }],
    }),
  ).toEqual({
    '@type': 'TVEpisode',
    name: 'Pilot',
    sameAs: [IMDB],
    partOfSeries: { name: 'Show' },
    '@graph': [{ '@type': 'Movie' }],
  });
});
