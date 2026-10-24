/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from 'vitest';
import { snapshot } from './fixtures';
import { readMediaSession } from './media-session';

const f = <T>(value: T) => ({ value, confidence: 0.7, source: 'media-session' as const });

test('no media session is null', () => {
  expect(readMediaSession(snapshot())).toBeNull();
  expect(readMediaSession(snapshot({ mediaSession: {} }))).toBeNull();
});

test('a title alone is a title, with no kind', () => {
  expect(
    readMediaSession(snapshot({ mediaSession: { title: 'Heat', artist: 'Netflix' } })),
  ).toEqual({ title: f('Heat') });
});

test('numbers in the title make an episode; the album names the show', () => {
  expect(
    readMediaSession(
      snapshot({
        mediaSession: { title: "S1:E2 Cat's in the Bag", artist: 'AMC', album: 'Breaking Bad' },
      }),
    ),
  ).toEqual({
    title: f("S1:E2 Cat's in the Bag"),
    kind: f('episode'),
    season: f(1),
    episode: f(2),
    showTitle: f('Breaking Bad'),
  });
});

test('numbers in the artist make an episode; the artist before the label is the show', () => {
  expect(
    readMediaSession(
      snapshot({ mediaSession: { title: 'Pilot', artist: 'Lost - Season 1, Episode 1' } }),
    ),
  ).toEqual({
    title: f('Pilot'),
    kind: f('episode'),
    season: f(1),
    episode: f(1),
    showTitle: f('Lost'),
  });
});

test('an artist that is not a label names the show when the album is absent', () => {
  const reading = readMediaSession(
    snapshot({ mediaSession: { title: '1x02 Pilot', artist: 'Severance' } }),
  );
  expect(reading?.showTitle).toEqual(f('Severance'));
});

test('total: non-string fields never throw', () => {
  for (const mediaSession of [
    { title: 5, artist: null, album: [] },
    { title: {}, artist: 'S1E1' },
    { title: '', artist: '', album: '' },
    'x',
    7,
  ]) {
    expect(() =>
      readMediaSession(snapshot({ mediaSession: mediaSession as unknown as never })),
    ).not.toThrow();
  }
});
