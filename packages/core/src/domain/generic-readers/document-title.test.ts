/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from 'vitest';
import { snapshot } from './fixtures';
import { readDocumentTitle, splitLabel } from './document-title';

const f = <T>(value: T) => ({ value, confidence: 0.4, source: 'document-title' as const });

test.each([
  ['Breaking Bad - Season 1, Episode 2 | Netflix', 'Breaking Bad', 1, 2],
  ['Severance S2:E4', 'Severance', 2, 4],
  ['The Wire 11x02', 'The Wire', 11, 2],
  ['Dark: Staffel 3, Folge 5', 'Dark', 3, 5],
])('%s', (documentTitle, show, season, episode) => {
  expect(readDocumentTitle(snapshot({ documentTitle }))).toEqual({
    kind: f('episode'),
    showTitle: f(show),
    season: f(season),
    episode: f(episode),
  });
});

test('a label at the very start leaves the show unnamed', () => {
  expect(readDocumentTitle(snapshot({ documentTitle: 'S1E2 - Pilot' }))).toEqual({
    kind: f('episode'),
    season: f(1),
    episode: f(2),
  });
});

test('no label is null', () => {
  expect(readDocumentTitle(snapshot({ documentTitle: 'Lecture 3: Calculus' }))).toBeNull();
  expect(readDocumentTitle(snapshot())).toBeNull();
});

test('splitLabel', () => {
  expect(splitLabel('Foo Bar S3E9 online')).toEqual({ season: 3, episode: 9, before: 'Foo Bar' });
  expect(splitLabel('nothing here')).toBeNull();
});

test('the label the grammar chose is the one split at, not the rightmost', () => {
  expect(splitLabel('Show S01E02 - S03E04')).toEqual({ season: 1, episode: 2, before: 'Show' });
});

test('a 200 KB title is read in linear time', () => {
  const long = 'x'.repeat(200_000);
  for (const documentTitle of [long, 'Show S1E2 ' + long, long + ' S1E2', ' '.repeat(200_000)]) {
    const start = Date.now();
    readDocumentTitle(snapshot({ documentTitle }));
    expect(Date.now() - start).toBeLessThan(50);
  }
});

test('total: odd text never throws', () => {
  for (const documentTitle of [5, null, undefined, {}, [], 'S', 'x'.repeat(5000)]) {
    expect(() =>
      readDocumentTitle(snapshot({ documentTitle: documentTitle as never })),
    ).not.toThrow();
  }
});
