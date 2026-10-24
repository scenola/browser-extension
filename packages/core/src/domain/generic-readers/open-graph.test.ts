/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from 'vitest';
import { snapshot } from './fixtures';
import { readOpenGraph } from './open-graph';

const f = <T>(value: T) => ({ value, confidence: 0.6, source: 'open-graph' as const });

test('video.movie', () => {
  expect(
    readOpenGraph(
      snapshot({
        openGraph: {
          'og:type': 'video.movie',
          'og:title': 'Dune: Part Two',
          'video:release_date': '2024-02-27T00:00:00Z',
        },
      }),
    ),
  ).toEqual({ kind: f('movie'), title: f('Dune: Part Two'), year: f(2024) });
});

test('video.episode with its series', () => {
  expect(
    readOpenGraph(
      snapshot({
        openGraph: { 'og:type': 'video.episode', 'og:title': 'Pilot', 'video:series': 'Lost' },
      }),
    ),
  ).toEqual({ kind: f('episode'), title: f('Pilot'), showTitle: f('Lost') });
});

test.each([
  'https://series.example/show/lost',
  'http://series.example/show/lost',
  '//series.example/show/lost',
  '/show/lost',
  '  https://series.example/show/lost',
])('a link in video:series (%s) is no show’s name', (link) => {
  expect(
    readOpenGraph(
      snapshot({
        openGraph: { 'og:type': 'video.episode', 'og:title': 'Pilot', 'video:series': link },
      }),
    ),
  ).toEqual({ kind: f('episode'), title: f('Pilot') });
});

test.each(['Re:Zero', 'Fate/Zero', 'Lost'])('a name in video:series (%s) is the show’s', (name) => {
  expect(
    readOpenGraph(snapshot({ openGraph: { 'og:type': 'video.episode', 'video:series': name } })),
  ).toEqual({ kind: f('episode'), showTitle: f(name) });
});

test("an episode's release date is its air date, not a year of the work", () => {
  const reading = readOpenGraph(
    snapshot({ openGraph: { 'og:type': 'video.episode', 'video:release_date': '2010-05-05' } }),
  );
  expect(reading?.year).toBeUndefined();
});

test('another type gives a title and no kind', () => {
  expect(
    readOpenGraph(snapshot({ openGraph: { 'og:type': 'video.other', 'og:title': 'Lecture 3' } })),
  ).toEqual({ title: f('Lecture 3') });
});

// A title is cut at the reader to the wire's 200 code points (500 characters is only the bound
// on how much of a string a reader looks at).
test('a title from the page is cut to the wire’s 200 code points', () => {
  const reading = readOpenGraph(
    snapshot({ openGraph: { 'og:title': 'a'.repeat(100_000), 'video:series': '𝐁'.repeat(201) } }),
  );
  expect(reading?.title?.value).toHaveLength(200);
  expect(Array.from(reading?.showTitle?.value ?? '')).toHaveLength(200);
});

test('nothing is null', () => {
  expect(readOpenGraph(snapshot())).toBeNull();
});

test('total: odd values never throw', () => {
  for (const openGraph of [
    { 'og:type': 5, 'og:title': null, 'video:release_date': {}, 'video:series': [] },
    { 'og:type': 'video.movie', 'video:release_date': 'soon' },
    { 'og:type': 'video.movie', 'og:title': '   ' },
    null,
    'x',
  ]) {
    expect(() =>
      readOpenGraph(snapshot({ openGraph: openGraph as unknown as never })),
    ).not.toThrow();
  }
});
