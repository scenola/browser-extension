/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EpochMs } from './time';

/** A played span in content seconds; `start < end`. */
export type Interval = readonly [start: number, end: number];

/** Longest wall-clock gap between two samples that can still be one stretch of playback. */
export const MAX_SAMPLE_GAP_S = 75;
/** A position may advance this many times faster than the clock before it is a seek. */
export const SEEK_SLACK = 1.5;
/** Flat allowance, in seconds, on top of the slackened advance. */
export const SEEK_ALLOWANCE_S = 1;

/** Sort, drop unusable intervals, then merge overlapping and touching ones. */
function normalise(input: readonly Interval[]): Interval[] {
  const usable = input
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .map(([a, b]): Interval => [a, b])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: Interval[] = [];
  for (const [a, b] of usable) {
    const last = merged[merged.length - 1];
    if (last !== undefined && a <= last[1]) {
      if (b > last[1]) merged[merged.length - 1] = [last[0], b];
    } else {
      merged.push([a, b]);
    }
  }
  return merged;
}

/** The set of content seconds actually played. Immutable: every operation returns a new set. */
export class PlayedRanges {
  readonly #intervals: readonly Interval[];

  private constructor(intervals: readonly Interval[]) {
    this.#intervals = intervals;
  }

  static empty(): PlayedRanges {
    return new PlayedRanges([]);
  }

  /** Rebuilds a set from stored data, repairing anything that would break the invariant. */
  static fromJSON(intervals: readonly Interval[]): PlayedRanges {
    return new PlayedRanges(normalise(intervals));
  }

  add(start: number, end: number): PlayedRanges {
    return new PlayedRanges(normalise([...this.#intervals, [start, end]]));
  }

  /** Seconds covered. */
  total(): number {
    return this.#intervals.reduce((sum, [a, b]) => sum + (b - a), 0);
  }

  /**
   * Seconds covered inside `[start, end]` (how much of the story was played): never negative,
   * never more than `end − start`. An empty or unusable window covers nothing.
   */
  within(start: number, end: number): number {
    if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) return 0;
    let sum = 0;
    for (const [a, b] of this.#intervals) {
      const from = Math.max(a, start);
      const to = Math.min(b, end);
      if (to > from) sum += to - from;
    }
    return Math.min(sum, end - start);
  }

  /** End of the last interval; `0` when empty. */
  furthest(): number {
    const last = this.#intervals[this.#intervals.length - 1];
    return last === undefined ? 0 : last[1];
  }

  toJSON(): Interval[] {
    return this.#intervals.map(([a, b]): Interval => [a, b]);
  }
}

export interface PlaybackSample {
  readonly at: EpochMs;
  /** Content seconds. */
  readonly position: number;
  /** `null` unless finite and `> 0`. */
  readonly duration: number | null;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly rate: number;
  readonly adPlaying: boolean;
  readonly muted: boolean;
  /** Share of the viewport the player covers, 0..1. */
  readonly visibleArea: number;
}

/**
 * Adds the span between two samples to `ranges` only when it was playback: the earlier sample
 * playing, neither of them an ad, a plausible wall-clock gap, and a position advance no larger
 * than the clock explains. The later sample may be a pause or the element's end — the media
 * played up to it — but nothing ever counts **from** a paused or ended sample, so
 * the time a player stood still, and a seek made while it did, is never playback. Anything
 * else is a seek, a sleep or an ad and adds nothing.
 */
export function advance(
  ranges: PlayedRanges,
  previous: PlaybackSample | null,
  next: PlaybackSample,
): PlayedRanges {
  if (previous === null) return ranges;
  if (previous.paused || previous.ended || previous.adPlaying || next.adPlaying) return ranges;
  const elapsed = (next.at - previous.at) / 1000;
  if (!(elapsed > 0 && elapsed <= MAX_SAMPLE_GAP_S)) return ranges;
  const delta = next.position - previous.position;
  if (!(delta > 0 && delta <= next.rate * elapsed * SEEK_SLACK + SEEK_ALLOWANCE_S)) return ranges;
  return ranges.add(previous.position, next.position);
}
