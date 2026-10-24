/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment happy-dom

// One sample of the elected video: `duration` is null unless it is finite and above 0 (NaN and
// Infinity become null), `visibleArea` is a 0–1 share of the viewport, and `muted` is filled.

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { addVideo, setViewport } from '../testing/video';
import { sampleOf } from './sampler';

const NOW = Date.UTC(2026, 9, 20, 19, 40);

/** A 1280×720 player, playing. */
const PLAYER = { width: 1280, height: 720, paused: false } as const;

beforeEach(() => {
  setViewport(window, 1920, 1080);
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('sampleOf', () => {
  // NaN, Infinity and 0 are never a duration
  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -5])(
    'a duration of %s is null',
    (duration) => {
      const video = addVideo(document, { ...PLAYER, duration, currentTime: 10 });
      expect(sampleOf(video, NOW, false).duration).toBeNull();
    },
  );

  test('a finite positive duration is kept', () => {
    const video = addVideo(document, { ...PLAYER, duration: 2_880, currentTime: 10 });
    expect(sampleOf(video, NOW, false).duration).toBe(2_880);
  });

  // What the element says, at `now`.
  test('the sample is the element’s state at that moment', () => {
    const video = addVideo(document, {
      width: 1280,
      height: 720,
      duration: 2_880,
      currentTime: 1_500,
      paused: false,
      ended: false,
      playbackRate: 2,
    });
    expect(sampleOf(video, NOW, true)).toEqual({
      at: NOW,
      position: 1_500,
      duration: 2_880,
      paused: false,
      ended: false,
      rate: 2,
      adPlaying: true,
      muted: false,
      visibleArea: expect.any(Number) as number,
    });
  });

  // A muted element never starts a viewing, so the sample must say whether it is muted.
  test.each([
    [true, true],
    [false, false],
  ])('muted %s gives muted %s', (muted, expected) => {
    const video = addVideo(document, { ...PLAYER, duration: 100, muted });
    expect(sampleOf(video, NOW, false).muted).toBe(expected);
  });

  test('visibleArea is the element’s share of the viewport', () => {
    const half = addVideo(document, { width: 960, height: 1080, duration: 100 });
    expect(sampleOf(half, NOW, false).visibleArea).toBeCloseTo(0.5, 5);
    const whole = addVideo(document, { width: 1920, height: 1080, duration: 100 });
    expect(sampleOf(whole, NOW, false).visibleArea).toBeCloseTo(1, 5);
  });

  // What lies outside the viewport is not visible
  test('an element larger than the viewport or partly off it stays within 0–1', () => {
    const huge = addVideo(document, {
      width: 4000,
      height: 3000,
      left: -100,
      top: -100,
      duration: 100,
    });
    const area = sampleOf(huge, NOW, false).visibleArea;
    expect(area).toBeGreaterThanOrEqual(0);
    expect(area).toBeLessThanOrEqual(1);
    const off = addVideo(document, {
      width: 400,
      height: 300,
      left: 3000,
      top: 2000,
      duration: 100,
    });
    expect(sampleOf(off, NOW, false).visibleArea).toBe(0);
  });

  // Hostile inputs give "no value", never a non-finite number on the wire
  test('a non-finite position or rate never reaches the sample', () => {
    const video = addVideo(document, {
      width: 1280,
      height: 720,
      duration: 100,
      currentTime: Number.NaN,
      playbackRate: Number.POSITIVE_INFINITY,
    });
    const sample = sampleOf(video, NOW, false);
    expect(Number.isFinite(sample.position)).toBe(true);
    expect(Number.isFinite(sample.rate)).toBe(true);
  });
});
