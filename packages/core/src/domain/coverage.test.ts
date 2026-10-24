/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  MAX_SAMPLE_GAP_S,
  PlayedRanges,
  SEEK_ALLOWANCE_S,
  SEEK_SLACK,
  advance,
  type Interval,
  type PlaybackSample,
} from './coverage';

const s = (at: number, position: number, extra: Partial<PlaybackSample> = {}): PlaybackSample => ({
  at: at * 1000,
  position,
  duration: 3000,
  paused: false,
  ended: false,
  rate: 1,
  adPlaying: false,
  muted: false,
  visibleArea: 1,
  ...extra,
});

function expectSortedDisjoint(iv: readonly Interval[]): void {
  iv.forEach((cur, i) => {
    const prev = iv[i - 1];
    if (prev !== undefined) expect(cur[0]).toBeGreaterThan(prev[1]);
  });
}

describe('advance', () => {
  test('pinned numbers', () => {
    expect(MAX_SAMPLE_GAP_S).toBe(75);
    expect(SEEK_SLACK).toBe(1.5);
    expect(SEEK_ALLOWANCE_S).toBe(1);
  });

  test('continuous playback accumulates', () => {
    let r = PlayedRanges.empty();
    r = advance(r, s(0, 0), s(15, 15));
    r = advance(r, s(15, 15), s(30, 30));
    expect(r.toJSON()).toEqual([[0, 30]]);
  });

  test('2x playback counts', () => {
    expect(
      advance(PlayedRanges.empty(), s(0, 100, { rate: 2 }), s(15, 130, { rate: 2 })).total(),
    ).toBe(30);
  });

  test('a forward seek adds nothing', () => {
    expect(advance(PlayedRanges.empty(), s(0, 100), s(15, 900)).total()).toBe(0);
  });

  test('a backward seek adds nothing and rewatching does not double count', () => {
    let r = PlayedRanges.fromJSON([[0, 600]]);
    r = advance(r, s(0, 600), s(1, 300));
    r = advance(r, s(1, 300), s(16, 315));
    expect(r.total()).toBe(600);
  });

  test('a jump after a gap longer than MAX_SAMPLE_GAP_S adds nothing (sleep, frozen tab)', () => {
    expect(advance(PlayedRanges.empty(), s(0, 100), s(4000, 3000)).total()).toBe(0);
  });

  test('a short gap with matching advance still counts, at the gap limit', () => {
    expect(advance(PlayedRanges.empty(), s(0, 0), s(75, 75)).total()).toBe(75);
  });

  test('paused previous sample adds nothing', () => {
    expect(advance(PlayedRanges.empty(), s(0, 100, { paused: true }), s(15, 115)).total()).toBe(0);
  });

  // The media played up to the pause, so a paused next sample closes the stretch; nothing ever
  // counts from a paused one.
  test('a paused next sample closes the stretch played up to it', () => {
    expect(advance(PlayedRanges.empty(), s(0, 100), s(15, 115, { paused: true })).total()).toBe(15);
  });

  test('a paused next sample after a seek adds nothing (the seek rule still holds)', () => {
    expect(advance(PlayedRanges.empty(), s(0, 100), s(15, 181, { paused: true })).total()).toBe(0);
  });

  test("the element's end closes the stretch played up to it", () => {
    const ended = s(15, 115, { paused: true, ended: true });
    expect(advance(PlayedRanges.empty(), s(0, 100), ended).total()).toBe(15);
  });

  test('nothing counts from an ended sample', () => {
    expect(advance(PlayedRanges.empty(), s(0, 100, { ended: true }), s(15, 115)).total()).toBe(0);
  });

  test('ad time adds nothing', () => {
    expect(advance(PlayedRanges.empty(), s(0, 100, { adPlaying: true }), s(15, 115)).total()).toBe(
      0,
    );
    expect(advance(PlayedRanges.empty(), s(0, 100), s(15, 115, { adPlaying: true })).total()).toBe(
      0,
    );
  });

  test('no previous sample adds nothing', () => {
    expect(advance(PlayedRanges.empty(), null, s(15, 15)).total()).toBe(0);
  });

  test('zero or negative elapsed adds nothing', () => {
    expect(advance(PlayedRanges.empty(), s(10, 10), s(10, 11)).total()).toBe(0);
    expect(advance(PlayedRanges.empty(), s(10, 10), s(5, 11)).total()).toBe(0);
  });

  test('a stationary playhead adds nothing', () => {
    expect(advance(PlayedRanges.empty(), s(0, 100), s(15, 100)).total()).toBe(0);
  });

  test('the seek bound is rate x elapsed x 1.5 + 1', () => {
    // 15 s elapsed at 1x: bound is 23.5
    expect(advance(PlayedRanges.empty(), s(0, 0), s(15, 23.5)).total()).toBe(23.5);
    expect(advance(PlayedRanges.empty(), s(0, 0), s(15, 23.6)).total()).toBe(0);
  });

  test('returns a new instance and leaves the input untouched', () => {
    const r = PlayedRanges.empty();
    const out = advance(r, s(0, 0), s(15, 15));
    expect(r.toJSON()).toEqual([]);
    expect(out).not.toBe(r);
  });
});

describe('PlayedRanges', () => {
  test('add merges overlapping and touching intervals', () => {
    const r = PlayedRanges.empty().add(0, 10).add(20, 30).add(10, 20);
    expect(r.toJSON()).toEqual([[0, 30]]);
  });

  test('add keeps disjoint intervals sorted', () => {
    const r = PlayedRanges.empty().add(50, 60).add(0, 10);
    expect(r.toJSON()).toEqual([
      [0, 10],
      [50, 60],
    ]);
  });

  test('add ignores empty, inverted and non-finite intervals', () => {
    const r = PlayedRanges.empty().add(5, 5).add(9, 3).add(0, Number.NaN).add(0, Infinity);
    expect(r.toJSON()).toEqual([]);
  });

  test('is immutable', () => {
    const r = PlayedRanges.fromJSON([[0, 10]]);
    r.add(10, 20);
    expect(r.toJSON()).toEqual([[0, 10]]);
    r.toJSON().push([100, 200]);
    expect(r.toJSON()).toEqual([[0, 10]]);
  });

  test('total and furthest', () => {
    const r = PlayedRanges.fromJSON([
      [0, 10],
      [40, 50],
    ]);
    expect(r.total()).toBe(20);
    expect(r.furthest()).toBe(50);
    expect(PlayedRanges.empty().furthest()).toBe(0);
    expect(PlayedRanges.empty().total()).toBe(0);
  });

  test('fromJSON normalises stored data', () => {
    const dirty = [
      [50, 60],
      [0, 10],
      [5, 20],
      [20, 25],
      [7, 7],
      [9, 2],
      [Number.NaN, 4],
      [1, Infinity],
      [-Infinity, 3],
    ] as Interval[];
    expect(PlayedRanges.fromJSON(dirty).toJSON()).toEqual([
      [0, 25],
      [50, 60],
    ]);
  });

  test('property: total never exceeds furthest, intervals stay sorted and disjoint', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.nat(5000), fc.nat(600))), (pairs) => {
        const r = pairs.reduce(
          (acc, [a, len]) => (len > 0 ? acc.add(a, a + len) : acc),
          PlayedRanges.empty(),
        );
        expectSortedDisjoint(r.toJSON());
        expect(r.total()).toBeLessThanOrEqual(r.furthest());
      }),
    );
  });

  test('property: fromJSON of arbitrary intervals always satisfies the invariant', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.double(), fc.double())), (pairs) => {
        const iv = PlayedRanges.fromJSON(pairs).toJSON();
        for (const [a, b] of iv) {
          expect(Number.isFinite(a) && Number.isFinite(b)).toBe(true);
          expect(b).toBeGreaterThan(a);
        }
        expectSortedDisjoint(iv);
      }),
    );
  });
});
