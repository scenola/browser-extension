/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from 'vitest';
import { entryVerdict, passesEntryRule } from './entry-rule';
import { snapshot } from './generic-readers/fixtures';

// A series page passes when its address names exactly one episode; the verdict tells the two
// failures apart.
test('a series page: passes with one pair in its address, else says it is a series', () => {
  const page = (hash: string, over: Parameters<typeof snapshot>[0]) =>
    snapshot({ url: { hostname: 'series.example', pathname: '/', query: {}, hash }, ...over });
  for (const over of [
    { openGraph: { 'og:type': 'video.tv_series' } },
    { openGraph: { 'og:type': 'video.tv_show' } },
    { jsonLd: [{ '@type': 'TVSeries', name: 'Show' }] },
  ]) {
    expect(entryVerdict(page('#s:5-e:1', over))).toBe('passes');
    expect(entryVerdict(page('', over))).toBe('series');
    expect(entryVerdict(page('#s1e1&s2e1', over))).toBe('series');
  }
  // On a page that does not say it is a series, address numbers alone open nothing.
  expect(entryVerdict(page('#s:5-e:1', {}))).toBe('silent');
  // A TVEpisode or a Movie beside the series is still the subject.
  expect(
    entryVerdict(page('', { jsonLd: [{ '@type': 'TVSeries' }, { '@type': 'Movie', name: 'X' }] })),
  ).toBe('passes');
});

test('JSON-LD Movie', () => {
  expect(passesEntryRule(snapshot({ jsonLd: [{ '@type': 'Movie', name: 'X' }] }))).toBe(true);
});

test('JSON-LD TVEpisode inside a graph', () => {
  expect(passesEntryRule(snapshot({ jsonLd: [{ '@graph': [{ '@type': 'TVEpisode' }] }] }))).toBe(
    true,
  );
});

test.each(['video.movie', 'video.episode'])('og:type %s', (type) => {
  expect(passesEntryRule(snapshot({ openGraph: { 'og:type': type } }))).toBe(true);
});

test('a label in the document title', () => {
  expect(passesEntryRule(snapshot({ documentTitle: 'Dark - Staffel 1, Folge 2' }))).toBe(true);
});

test.each([[{ title: 'S1E2' }], [{ artist: 'Show 2x05' }], [{ album: 'Season 1, Episode 3' }]])(
  'a label in a Media Session field %#',
  (mediaSession) => {
    expect(passesEntryRule(snapshot({ mediaSession }))).toBe(true);
  },
);

test('a label in any selector value', () => {
  expect(passesEntryRule(snapshot({ selectors: { a: ['nope'], b: ['x', 'S3 E4'] } }))).toBe(true);
});

test('a product title with a memory size is not a label', () => {
  expect(passesEntryRule(snapshot({ documentTitle: 'Corsair 4x16 GB DDR4' }))).toBe(false);
});

test('og:type video.other and a lecture title do not pass', () => {
  expect(
    passesEntryRule(
      snapshot({
        documentTitle: 'Lecture 3: Calculus',
        openGraph: { 'og:type': 'video.other', 'og:title': 'Lecture 3: Calculus' },
      }),
    ),
  ).toBe(false);
});

test('an Article, and a blank page, do not pass', () => {
  expect(passesEntryRule(snapshot({ jsonLd: [{ '@type': 'Article' }] }))).toBe(false);
  expect(passesEntryRule(snapshot())).toBe(false);
});

test('total: hostile snapshots never throw and do not pass', () => {
  const hostile = snapshot({
    documentTitle: 5 as unknown as string,
    jsonLd: [null, 3, { '@type': 4 }],
    mediaSession: { title: 5 } as unknown as never,
    openGraph: { 'og:type': 3 } as unknown as never,
    selectors: { a: [null, 5, {}], b: 'x' } as unknown as never,
  });
  expect(passesEntryRule(hostile)).toBe(false);
});
