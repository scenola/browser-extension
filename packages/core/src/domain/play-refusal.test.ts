/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Why a bound viewing cannot become a play: an episode with neither number (the server could not
// place it), an episode without its show’s title, a film with no title and no id. Where the
// builder refuses, the refusal names the reason, and `buildPlay` and `buildStart` answer nothing.

import { describe, expect, test } from 'vitest';

import { EPISODE_NUMBER_MAX, SEASON_NUMBER_MAX, buildPlay, buildStart, playRefusal } from './play';
import type { MergedReading } from './reading';
import { newViewing } from './viewing';
import type { Viewing } from './viewing';

function viewing(reading: Partial<MergedReading>, serviceId: string | null = null): Viewing {
  const merged: MergedReading = { sources: [], ...reading };
  const v = newViewing({ id: 'v', serviceId, reading: merged, at: 0, incognito: false });
  // A reading the key refuses still has a viewing for the purposes of this test.
  return {
    ...(v ?? {
      id: 'v',
      key: 'k',
      serviceId,
      reading: merged,
      ranges: [],
      durationSeconds: null,
      statedDurationSeconds: null,
      elementDurationSeconds: null,
      lastElementDuration: null,
      contentEnded: false,
      firstSeenAt: 0,
      lastSampleAt: 0,
      incognito: false,
      engaged: true,
      state: 'open' as const,
      reportedPlayId: null,
    }),
    durationSeconds: 1000,
    ranges: [[0, 900]],
  };
}

describe('an episode', () => {
  const show = { kind: 'episode' as const, showTitle: 'Show' };

  test('with neither number is series_no_episode', () => {
    expect(playRefusal(viewing(show))).toBe('series_no_episode');
  });

  test('with neither number is series_no_episode before it is no_title', () => {
    expect(playRefusal(viewing({ kind: 'episode' }))).toBe('series_no_episode');
  });

  test.each([
    ['a season and an episode', { season: 1, episode: 2 }],
    ['a season alone', { season: 1 }],
    ['an episode alone', { episode: 2 }],
    ['season 0 (specials)', { season: 0 }],
    [
      'the largest numbers the wire takes',
      { season: SEASON_NUMBER_MAX, episode: EPISODE_NUMBER_MAX },
    ],
  ])('with %s and a show title can be a play', (_n, numbers) => {
    expect(playRefusal(viewing({ ...show, ...numbers }))).toBeNull();
  });

  test('with numbers past the wire’s bounds has none', () => {
    expect(
      playRefusal(
        viewing({ ...show, season: SEASON_NUMBER_MAX + 1, episode: EPISODE_NUMBER_MAX + 1 }),
      ),
    ).toBe('series_no_episode');
  });

  test('with numbers and no show title is no_title', () => {
    expect(playRefusal(viewing({ kind: 'episode', season: 1, episode: 2 }))).toBe('no_title');
    expect(playRefusal(viewing({ kind: 'episode', showTitle: '   ', season: 1, episode: 2 }))).toBe(
      'no_title',
    );
  });
});

describe('a film', () => {
  test('with no title and no id is no_title', () => {
    expect(playRefusal(viewing({ kind: 'movie' }))).toBe('no_title');
    expect(playRefusal(viewing({ kind: 'movie', title: '  ' }))).toBe('no_title');
  });

  test.each([
    ['a title', { title: 'Arrival' }],
    ['a TMDB id', { ids: { tmdb: 329_865 } }],
    ['an IMDb id', { ids: { imdb: 'tt2543164' } }],
  ])('with %s can be a play', (_n, fields) => {
    expect(playRefusal(viewing({ kind: 'movie', ...fields }))).toBeNull();
  });

  test.each([
    ['an IMDb id of the wrong shape', { ids: { imdb: 'tt12' } }],
    ['a TMDB id of 0', { ids: { tmdb: 0 } }],
    ['a TMDB id with a fraction', { ids: { tmdb: 1.5 } }],
  ])('with %s and no title is no_title', (_n, fields) => {
    expect(playRefusal(viewing({ kind: 'movie', ...fields }))).toBe('no_title');
  });

  test('with only the service’s own id is a play when the wire can carry it', () => {
    const named = {
      kind: 'movie' as const,
      providerIds: [{ level: 'title' as const, key: 'videoId', value: '70196253' }],
    };
    expect(playRefusal(viewing(named, 'netflix'))).toBeNull();
    const bad = {
      kind: 'movie' as const,
      providerIds: [{ level: 'title' as const, key: '9 bad', value: '1' }],
    };
    expect(playRefusal(viewing(bad, 'netflix'))).toBe('no_title');
  });
});

describe('where the builder refuses, nothing is built', () => {
  test.each([
    ['an episode with no numbers', { kind: 'episode' as const, showTitle: 'Show' }],
    ['an episode with no show title', { kind: 'episode' as const, season: 1, episode: 1 }],
    ['a film with nothing to name it', { kind: 'movie' as const }],
  ])('%s', (_n, reading) => {
    const v = viewing(reading);
    expect(playRefusal(v)).not.toBeNull();
    expect(buildPlay(v, 0, 0)).toBeNull();
    expect(buildStart(v)).toBeNull();
  });

  test('a reading with no kind has no refusal to name, and no play', () => {
    const v = viewing({ title: 'x' });
    expect(buildPlay(v, 0, 0)).toBeNull();
  });
});
