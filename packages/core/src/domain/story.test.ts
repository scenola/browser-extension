/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The story in the domain: where a viewing's story starts and ends, how much of it was played,
// and the bounds that keep hostile statements and stored values harmless.

import { describe, expect, test } from 'vitest';

import type { Interval, PlaybackSample } from './coverage';
import { buildPlay } from './play';
import { mergeReadings } from './reading';
import type { MergedReading, ServiceReading } from './reading';
import {
  applySample,
  newViewing,
  playedSeconds,
  reportVerdict,
  storyCoverage,
  storyOf,
  storySeconds,
} from './viewing';
import type { Viewing } from './viewing';

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

const READING: MergedReading = { kind: 'movie', title: 'Film', year: 2000, sources: ['module'] };

function viewing(o: Partial<Viewing> = {}): Viewing {
  const base = must(
    newViewing({ id: 'v1', serviceId: null, reading: READING, at: 0, incognito: false }),
  );
  return {
    ...base,
    durationSeconds: 1000,
    elementDurationSeconds: 1000,
    lastElementDuration: 1000,
    engaged: true,
    ...o,
  };
}

const sample = (at: number, position: number, o: Partial<PlaybackSample> = {}): PlaybackSample => ({
  at,
  position,
  duration: 1000,
  paused: false,
  ended: false,
  rate: 1,
  adPlaying: false,
  muted: false,
  visibleArea: 1,
  ...o,
});

describe('the story’s end', () => {
  test('the credits are estimated at duration − min(12 %, 20 min)', () => {
    expect(storyOf(viewing())).toEqual({ start: 0, end: 880 });
    expect(storyOf(viewing({ durationSeconds: 3 * 3600 }))?.end).toBe(3 * 3600 - 1200);
  });

  test.each([
    [700, 700],
    [1000, 1000],
    [499, 880],
    [1001, 880],
    [Number.NaN, 880],
    [-5, 880],
  ])('a stated credits start of %s ends the story at %s', (stated, end) => {
    expect(storyOf(viewing({ creditsStartSeconds: stated }))?.end).toBe(end);
  });

  test('no usable duration, no story', () => {
    expect(storyOf(viewing({ durationSeconds: null }))).toBeNull();
    expect(storyCoverage(viewing({ durationSeconds: null, ranges: [[0, 500]] }))).toBe(0);
  });

  // The 70 % line of an 880 s story is 616 s played.
  test('the story’s end decides nothing: the line does, wherever the position is', () => {
    expect(reportVerdict(viewing({ ranges: [[0, 616]] }), 70).kind).toBe('report');
    expect(reportVerdict(viewing({ ranges: [[0, 615]] }), 70).kind).toBe('wait');
    expect(reportVerdict(viewing({ ranges: [[265, 880]] }), 70).kind).toBe('wait');
    expect(reportVerdict(viewing({ ranges: [[265, 1000]], contentEnded: true }), 70).kind).toBe(
      'wait',
    );
  });
});

describe('the story’s start', () => {
  test('a stated intro end starts the story, inside the first half and before the credits', () => {
    expect(storyOf(viewing({ introEndSeconds: 90 }))).toEqual({ start: 90, end: 880 });
    expect(storyOf(viewing({ introEndSeconds: 600 }))?.start).toBe(0);
    expect(storyOf(viewing({ introEndSeconds: -1 }))?.start).toBe(0);
  });

  test('a skipped intro detected once starts the story; a stated one wins over it', () => {
    const skipped: Interval = [20, 140];
    expect(storyOf(viewing({ skippedIntro: skipped }))?.start).toBe(140);
    expect(storyOf(viewing({ skippedIntro: skipped, introEndSeconds: 60 }))?.start).toBe(60);
  });

  test.each([
    ['a seek starting after the first 15 %', [151, 200]],
    ['a seek longer than 15 % of the duration', [10, 161]],
    ['a reversed span', [140, 20]],
    ['a non-finite span', [Number.NaN, 140]],
  ] as const)('%s stored as the skipped intro is none', (_, span) => {
    expect(storyOf(viewing({ skippedIntro: span as unknown as Interval }))?.start).toBe(0);
  });
});

describe('detecting a skipped intro', () => {
  const empty = viewing({
    durationSeconds: null,
    elementDurationSeconds: null,
    lastElementDuration: null,
  });

  const play = (v0: Viewing, steps: readonly (readonly [number, number])[]): Viewing => {
    let v = v0;
    let previous: PlaybackSample | null = null;
    for (const [at, position] of steps) {
      const next = sample(at, position);
      v = applySample(v, previous, next, READING);
      previous = next;
    }
    return v;
  };

  test('one forward seek in the first 15 %, no longer than 15 %: recorded once', () => {
    const v = play(empty, [
      [0, 0],
      [15_000, 15],
      [30_000, 30],
      [45_000, 160],
      [60_000, 175],
      [75_000, 300],
    ]);
    expect(v.skippedIntro).toEqual([30, 160]);
  });

  test('a seek while paused, or across an ad, is no intro', () => {
    let v = play(empty, [
      [0, 0],
      [15_000, 15],
    ]);
    v = applySample(v, sample(15_000, 15), sample(30_000, 120, { adPlaying: true }), READING);
    expect(v.skippedIntro ?? null).toBeNull();
    v = applySample(v, sample(30_000, 20, { paused: true }), sample(45_000, 140), READING);
    expect(v.skippedIntro ?? null).toBeNull();
  });
});

describe('coverage over the story is bounded', () => {
  test('never above 1, never below 0, whatever the ranges', () => {
    expect(storyCoverage(viewing({ ranges: [[0, 1000]] }))).toBe(1);
    expect(storyCoverage(viewing({ ranges: [] }))).toBe(0);
    expect(storyCoverage(viewing({ ranges: [[-500, 5000]] }))).toBe(1);
    expect(
      storyCoverage(viewing({ ranges: [[Number.NaN, 10] as unknown as Interval, [100, 540]] })),
    ).toBe(0.5);
  });

  test('only the story counts: the intro and the credits are outside it', () => {
    const v = viewing({
      introEndSeconds: 100,
      ranges: [
        [0, 100],
        [880, 1000],
      ],
    });
    expect(storyCoverage(v)).toBe(0);
  });
});

// The line is the account's, a whole share of the story in whole seconds played.
describe('the finish line', () => {
  test('a viewing reports at or over the account’s line, at its last sample, and waits under it', () => {
    const v = viewing({
      ranges: [
        [0, 440],
        [800, 880],
      ],
      lastSampleAt: 5000,
    });
    expect(storyCoverage(v)).toBeCloseTo(520 / 880, 9);
    expect([storySeconds(v), playedSeconds(v)]).toEqual([880, 520]);
    expect(reportVerdict(v, 50)).toEqual({ kind: 'report', watchedAt: 5000 });
    expect(reportVerdict(v, 70)).toEqual({ kind: 'wait' });
  });

  test('the line is rounded up to a whole second: 90 % of 880 s is 792 s', () => {
    const at = (end: number) => viewing({ ranges: [[0, end]], creditsStartSeconds: 880 });
    expect(reportVerdict({ ...at(880), ranges: [[88, 880]] }, 90).kind).toBe('report');
    expect(reportVerdict({ ...at(880), ranges: [[89, 880]] }, 90).kind).toBe('wait');
  });

  test('the body carries all four numbers, and `ended` only from the end itself', () => {
    const v = viewing({ ranges: [[0, 900]] });
    expect(buildPlay(v, 1, 0)).toMatchObject({
      duration_seconds: 1000,
      furthest_position_seconds: 900,
      story_seconds: 880,
      played_seconds: 880,
      ended: false,
    });
    expect(buildPlay({ ...v, contentEnded: true }, 1, 0)?.ended).toBe(true);
    // A stated credits start ends the story without saying the title played out.
    expect(buildPlay({ ...v, creditsStartSeconds: 700 }, 1, 0)?.ended).toBe(false);
  });

  test('a viewing whose length is unknown is no play', () => {
    expect(buildPlay(viewing({ durationSeconds: null, ranges: [[0, 900]] }), 1, 0)).toBeNull();
  });
});

describe('statements in the reading', () => {
  test('the module’s credits start and intro end are merged; the generic readers state none', () => {
    const module: ServiceReading = { creditsStartSeconds: 2700, introEndSeconds: 95 };
    const generic: ServiceReading[] = [{ creditsStartSeconds: 10, introEndSeconds: 1 }];
    expect(mergeReadings(module, generic)).toMatchObject({
      creditsStartSeconds: 2700,
      introEndSeconds: 95,
    });
    expect(mergeReadings(null, generic)).toMatchObject({
      creditsStartSeconds: 10,
      introEndSeconds: 1,
    });
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 8 * 24 * 3600])(
    'a marker of %s is dropped at the merge',
    (bad) => {
      const merged = mergeReadings({ creditsStartSeconds: bad, introEndSeconds: bad }, []);
      expect(merged.creditsStartSeconds).toBeUndefined();
      expect(merged.introEndSeconds).toBeUndefined();
    },
  );

  test('a viewing keeps the latest valid statement; an invalid one keeps the last', () => {
    let v = viewing();
    v = applySample(v, null, sample(0, 0), { ...READING, creditsStartSeconds: 900 });
    expect(v.creditsStartSeconds).toBe(900);
    v = applySample(v, null, sample(15_000, 15), READING);
    expect(v.creditsStartSeconds).toBe(900);
    v = applySample(v, null, sample(30_000, 30), { ...READING, creditsStartSeconds: 950 });
    expect(v.creditsStartSeconds).toBe(950);
  });
});

describe('the play records the end', () => {
  // `ended` says the title played out, never the extension's estimate.
  test('a play queued mid-story says `ended: false`, and so does one past the credits estimate', () => {
    const mid = viewing({ ranges: [[0, 616]], lastSampleAt: 5000 });
    expect(reportVerdict(mid, 70)).toEqual({ kind: 'report', watchedAt: 5000 });
    expect(buildPlay(mid, 5000, 0)?.ended).toBe(false);
    expect(buildPlay(viewing({ ranges: [[0, 900]] }), 5000, 0)?.ended).toBe(false);
  });
});
