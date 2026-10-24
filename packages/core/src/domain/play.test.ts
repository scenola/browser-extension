/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';

import {
  bodyBytes,
  buildPlay,
  clampTitle,
  isImdbId,
  isProviderKey,
  isProviderNamespace,
  isProviderValue,
  isYear,
  playLabel,
} from './play';
import type { MergedReading } from './reading';
import type { Viewing } from './viewing';

function viewing(reading: Partial<MergedReading>, o: Partial<Viewing> = {}): Viewing {
  return {
    id: 'v1',
    key: 'k',
    serviceId: 'netflix',
    reading: { sources: ['service'], ...reading } as MergedReading,
    ranges: [[0, 2700.9]],
    durationSeconds: 2820.7,
    statedDurationSeconds: null,
    elementDurationSeconds: 2820.7,
    lastElementDuration: 2820.7,
    contentEnded: true,
    firstSeenAt: 0,
    lastSampleAt: 1,
    incognito: false,
    engaged: true,
    state: 'open',
    reportedPlayId: null,
    ...o,
  };
}

const without = (
  r: Partial<MergedReading>,
  ...keys: (keyof MergedReading)[]
): Partial<MergedReading> =>
  Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k as keyof MergedReading)));

const AT = Date.parse('2026-10-20T19:40:00Z');

const episode: Partial<MergedReading> = {
  kind: 'episode',
  episodeTitle: "Cat's in the Bag...",
  showTitle: 'Breaking Bad',
  showYear: 2008,
  season: 1,
  episode: 2,
  providerIds: [{ level: 'title', key: 'videoId', value: '81234567' }],
};

describe('buildPlay', () => {
  test('a Netflix episode', () => {
    const body = buildPlay(viewing(episode), AT, 120);
    expect(body).toEqual({
      kind: 'episode',
      title: "Cat's in the Bag...",
      ids: { provider: [{ namespace: 'provider.netflix', key: 'videoId', value: '81234567' }] },
      show: { title: 'Breaking Bad', year: 2008 },
      season_number: 1,
      episode_number: 2,
      watched_at: '2026-10-20T21:40:00+02:00',
      duration_seconds: 2820,
      furthest_position_seconds: 2700,
      // The story, 2820.7 − 12 % (the credits estimate), and its seconds played.
      story_seconds: 2482,
      played_seconds: 2482,
      ended: true,
    });
    expect(body?.ids?.tmdb).toBeUndefined();
  });

  test('a top-level year is a film’s only; a stated show year wins over an episode’s `year`', () => {
    const body = buildPlay(viewing({ ...episode, year: 2020 }), AT, 0);
    expect(body).not.toHaveProperty('year');
    expect(body?.show?.year).toBe(2008);
    const film = buildPlay(viewing({ kind: 'movie', title: 'Arrival', year: 2016 }), AT, 0);
    expect(film?.year).toBe(2016);
  });

  test('an episode’s `year` with no show year is the show’s: the server needs it to find the show', () => {
    // A Media Session title with no label (`Show (2020)`) on a page whose kind and numbers come
    // from another reader: its year is the work's, the show's.
    const reading = {
      kind: 'episode' as const,
      showTitle: 'Show',
      title: 'Show',
      year: 2020,
      season: 5,
      episode: 1,
    };
    const body = buildPlay(viewing(reading), AT, 0);
    expect(body).not.toHaveProperty('year');
    expect(body?.show?.year).toBe(2020);
    expect(buildPlay(viewing({ ...reading, year: 1500 }), AT, 0)?.show).not.toHaveProperty('year');
  });

  test('show-level provider ids sit on the show', () => {
    const body = buildPlay(
      viewing({
        ...episode,
        providerIds: [
          { level: 'title', key: 'videoId', value: '1' },
          { level: 'show', key: 'showId', value: '2' },
        ],
      }),
      AT,
      0,
    );
    expect(body?.show?.ids?.provider).toEqual([
      { namespace: 'provider.netflix', key: 'showId', value: '2' },
    ]);
    expect(body?.ids?.provider).toEqual([
      { namespace: 'provider.netflix', key: 'videoId', value: '1' },
    ]);
  });

  test('a film with a page-stated IMDb id', () => {
    const body = buildPlay(
      viewing({ kind: 'movie', title: 'Arrival', year: 2016, ids: { imdb: 'tt2543164' } }),
      AT,
      0,
    );
    expect(body?.kind).toBe('movie');
    expect(body?.ids?.imdb).toBe('tt2543164');
    expect(body?.show).toBeUndefined();
    expect(body?.watched_at).toBe('2026-10-20T19:40:00+00:00');
  });

  test('stated show ids go on the show; an invalid imdb is dropped', () => {
    const body = buildPlay(viewing({ ...episode, showIds: { tmdb: 1396, imdb: 'nope' } }), AT, 0);
    expect(body?.show?.ids).toEqual({ tmdb: 1396 });
  });

  test('a provider value containing a quote is dropped', () => {
    const body = buildPlay(
      viewing({
        kind: 'movie',
        title: 'Film',
        providerIds: [
          { level: 'title', key: 'a', value: 'x"y' },
          { level: 'title', key: 'b', value: 'ok' },
        ],
      }),
      AT,
      0,
    );
    expect(body?.ids?.provider).toEqual([{ namespace: 'provider.netflix', key: 'b', value: 'ok' }]);
  });

  test('a 300-character title is clamped to 200', () => {
    const body = buildPlay(viewing({ kind: 'movie', title: 'a'.repeat(300) }), AT, 0);
    expect(body?.title).toBe('a'.repeat(200));
  });

  test('nine provider entries become eight', () => {
    const providerIds = Array.from({ length: 9 }, (_, i) => ({
      level: 'title' as const,
      key: `k${String(i)}`,
      value: `v${String(i)}`,
    }));
    const body = buildPlay(viewing({ kind: 'movie', title: 'F', providerIds }), AT, 0);
    expect(body?.ids?.provider).toHaveLength(8);
  });

  test('a viewing with no service sends no provider entries', () => {
    const body = buildPlay(viewing(episode, { serviceId: null }), AT, 0);
    expect(body?.ids).toBeUndefined();
  });

  test('a viewing whose only identifier is invalid is null', () => {
    const body = buildPlay(
      viewing({
        kind: 'movie',
        providerIds: [{ level: 'title', key: 'a', value: 'bad"' }],
        ids: { imdb: 'tt1' },
      }),
      AT,
      0,
    );
    expect(body).toBeNull();
  });

  test('no kind is null', () => {
    expect(buildPlay(viewing({ title: 'x' }), AT, 0)).toBeNull();
  });

  describe('an episode must be sendable', () => {
    test('without a show title it is null even with ids', () => {
      expect(buildPlay(viewing(without(episode, 'showTitle')), AT, 0)).toBeNull();
    });
    test('a show title that clamps to empty is null', () => {
      expect(buildPlay(viewing({ ...episode, showTitle: '   ' }), AT, 0)).toBeNull();
    });
    test('without either number it is null', () => {
      expect(buildPlay(viewing(without(episode, 'season', 'episode')), AT, 0)).toBeNull();
    });
    test('with one number it is sent', () => {
      const body = buildPlay(viewing(without(episode, 'season')), AT, 0);
      expect(body?.episode_number).toBe(2);
      expect(body?.season_number).toBeUndefined();
    });
    test('a non-positive-integer number is dropped', () => {
      expect(buildPlay(viewing({ ...episode, season: 1.5, episode: -1 }), AT, 0)).toBeNull();
    });
  });

  // A viewing whose length is unknown has no story and is never sent.
  test('playback numbers are floored; a viewing of unknown length is no play', () => {
    const film = { kind: 'movie', title: 'F' } as const;
    const body = buildPlay(viewing(film, { contentEnded: false }), AT, 0);
    expect([body?.duration_seconds, body?.furthest_position_seconds, body?.ended]).toEqual([
      2820,
      2700,
      false,
    ]);
    expect(buildPlay(viewing(film, { durationSeconds: null }), AT, 0)).toBeNull();
  });

  test('a special (season 0, episode 0) is sent', () => {
    const body = buildPlay(viewing({ ...episode, season: 0, episode: 3 }), AT, 0);
    expect(body?.season_number).toBe(0);
    expect(body?.episode_number).toBe(3);
    expect(buildPlay(viewing({ ...episode, season: 0, episode: 0 }), AT, 0)?.episode_number).toBe(
      0,
    );
  });

  test("numbers over the server's bounds are dropped", () => {
    const body = buildPlay(viewing({ ...episode, season: 10_001, episode: 2 }), AT, 0);
    expect(body?.season_number).toBeUndefined();
    expect(body?.episode_number).toBe(2);
    const edge = buildPlay(viewing({ ...episode, season: 10_000, episode: 100_000 }), AT, 0);
    expect(edge?.season_number).toBe(10_000);
    expect(edge?.episode_number).toBe(100_000);
    expect(
      buildPlay(viewing({ ...episode, season: 1, episode: 20_261_020 }), AT, 0)?.episode_number,
    ).toBeUndefined();
    expect(buildPlay(viewing({ ...episode, season: 10_001, episode: 100_001 }), AT, 0)).toBeNull();
  });

  // A length the wire cannot take (under 1 s, over a week) is no length: no play.
  test('a length below 1 s or above a week is no play; furthest and the story are clamped', () => {
    const film = { kind: 'movie', title: 'F' } as const;
    expect(buildPlay(viewing(film, { durationSeconds: 0.4 }), AT, 0)).toBeNull();
    expect(buildPlay(viewing(film, { durationSeconds: 604_801 }), AT, 0)).toBeNull();
    expect(buildPlay(viewing(film, { durationSeconds: 604_800 }), AT, 0)?.duration_seconds).toBe(
      604_800,
    );
    // never above the sent duration, nor the story above it
    const past = buildPlay(viewing(film, { durationSeconds: 100, ranges: [[0, 150]] }), AT, 0);
    expect(past?.furthest_position_seconds).toBe(100);
    expect(past?.story_seconds).toBeLessThanOrEqual(100);
    expect(past?.played_seconds).toBe(past?.story_seconds);
  });

  test('non-finite time input throws', () => {
    const v = viewing({ kind: 'movie', title: 'F' });
    expect(() => buildPlay(v, NaN, 0)).toThrow(RangeError);
    expect(() => buildPlay(v, AT, Infinity)).toThrow(RangeError);
  });

  test('half-hour and quarter-hour offsets', () => {
    const v = viewing({ kind: 'movie', title: 'F' });
    expect(buildPlay(v, AT, 330)?.watched_at).toBe('2026-10-21T01:10:00+05:30');
    expect(buildPlay(v, AT, 345)?.watched_at).toBe('2026-10-21T01:25:00+05:45');
  });

  test('an episode never takes the show name as its own title', () => {
    const body = buildPlay(
      viewing(without({ ...episode, title: 'Breaking Bad' }, 'episodeTitle')),
      AT,
      0,
    );
    expect(body).not.toBeNull();
    expect(body?.title).toBeUndefined();
  });

  test('duplicate provider entries are removed before the cap', () => {
    const dup = { level: 'title' as const, key: 'a', value: '1' };
    const body = buildPlay(
      viewing({
        kind: 'movie',
        title: 'F',
        providerIds: [
          dup,
          dup,
          ...Array.from({ length: 7 }, (_, i) => ({
            level: 'title' as const,
            key: 'k',
            value: String(i),
          })),
        ],
      }),
      AT,
      0,
    );
    expect(body?.ids?.provider).toHaveLength(8);
  });

  test('a negative offset formats with a minus sign', () => {
    const body = buildPlay(viewing({ kind: 'movie', title: 'F' }), AT, -270);
    expect(body?.watched_at).toBe('2026-10-20T15:10:00-04:30');
  });

  test('an invalid year is dropped', () => {
    const body = buildPlay(viewing({ kind: 'movie', title: 'F', year: 1500 }), AT, 0);
    expect(body?.year).toBeUndefined();
  });

  test('the body never exceeds 16 KiB', () => {
    const providerIds = Array.from({ length: 8 }, (_, i) => ({
      level: 'title' as const,
      key: `k${String(i)}`,
      value: 'v'.repeat(200),
    }));
    const body = buildPlay(viewing({ kind: 'movie', title: '😀'.repeat(300), providerIds }), AT, 0);
    if (body === null) throw new Error('expected a body');
    expect(bodyBytes(body)).toBeLessThanOrEqual(16 * 1024);
    const ascii = bodyBytes({ kind: 'movie', title: 'a', watched_at: 'x' });
    expect(bodyBytes({ kind: 'movie', title: '😀', watched_at: 'x' })).toBe(ascii + 3);
    expect(bodyBytes({ kind: 'movie', title: 'é', watched_at: 'x' })).toBe(ascii + 1);
  });
});

describe('playLabel', () => {
  const at = '2026-10-20T21:40:00+02:00';

  test('an episode is its show and numbers, as the toolbar says it', () => {
    expect(
      playLabel({
        kind: 'episode',
        title: "Cat's in the Bag...",
        show: { title: 'Breaking Bad' },
        season_number: 1,
        episode_number: 2,
        watched_at: at,
      }),
    ).toBe('Breaking Bad · S1 E2');
  });

  test('an episode missing one number keeps the other', () => {
    expect(
      playLabel({ kind: 'episode', show: { title: 'Show' }, episode_number: 7, watched_at: at }),
    ).toBe('Show · E7');
    expect(
      playLabel({ kind: 'episode', show: { title: 'Show' }, season_number: 0, watched_at: at }),
    ).toBe('Show · S0');
  });

  test('a film is its title', () => {
    expect(playLabel({ kind: 'movie', title: 'Dune: Part Two', year: 2024, watched_at: at })).toBe(
      'Dune: Part Two',
    );
  });

  test('a play that names nothing in words has no label', () => {
    expect(playLabel({ kind: 'movie', ids: { imdb: 'tt1234567' }, watched_at: at })).toBeNull();
  });
});

describe('validators', () => {
  test('namespace', () => {
    expect(isProviderNamespace('provider.netflix')).toBe(true);
    expect(isProviderNamespace('Provider')).toBe(false);
    expect(isProviderNamespace('a'.repeat(65))).toBe(false);
  });
  test('key', () => {
    expect(isProviderKey('contentId')).toBe(true);
    expect(isProviderKey('1a')).toBe(false);
    expect(isProviderKey('a'.repeat(65))).toBe(false);
  });
  test('value', () => {
    expect(isProviderValue('abc 123')).toBe(true);
    expect(isProviderValue('a\\b')).toBe(false);
    expect(isProviderValue('é')).toBe(false);
    expect(isProviderValue('')).toBe(false);
    expect(isProviderValue('a'.repeat(201))).toBe(false);
  });
  test('clampTitle', () => {
    expect(clampTitle('  hi  ')).toBe('hi');
    expect(clampTitle('   ')).toBeUndefined();
    expect(clampTitle(undefined)).toBeUndefined();
    expect(Array.from(clampTitle('😀'.repeat(250)) ?? '')).toHaveLength(200);
  });
  test('year and imdb', () => {
    expect(isYear(1870)).toBe(true);
    expect(isYear(2201)).toBe(false);
    expect(isYear(2000.5)).toBe(false);
    expect(isImdbId('tt1234567')).toBe(true);
    expect(isImdbId('tt1234')).toBe(false);
  });
});
