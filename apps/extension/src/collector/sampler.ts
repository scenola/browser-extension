/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// One sample of the elected video: what the element says at one moment, within the protocol's
// bounds (messaging/limits.ts), so a report is never refused for a value the page put there.
// Readings of the element that are not numbers, or not finite, are no value.

import type { EpochMs, PlaybackSample } from '@mt/core';

import { MAX_MEDIA_SECONDS, MAX_PLAYBACK_RATE } from '../messaging/limits';
import { visibleShare } from './election';

/** A finite number from the element, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * A sample of `video` at `now`. `duration` is `null` unless finite and `> 0` (a live stream, MSE
 * before its metadata); `muted` is the element's own word or a volume of zero; `visibleArea` is
 * the share of the frame's viewport it covers — all of it while it plays in Picture-in-Picture,
 * where the person watches it outside the page.
 */
export function sampleOf(
  video: HTMLVideoElement,
  now: EpochMs,
  adPlaying: boolean,
): PlaybackSample {
  const duration = finite(video.duration, 0);
  const pictureInPicture = video.ownerDocument.pictureInPictureElement === video;
  return {
    at: now,
    position: Math.min(Math.max(finite(video.currentTime, 0), 0), MAX_MEDIA_SECONDS),
    duration: duration > 0 && duration <= MAX_MEDIA_SECONDS ? duration : null,
    paused: video.paused,
    ended: video.ended,
    rate: Math.min(Math.max(finite(video.playbackRate, 1), 0), MAX_PLAYBACK_RATE),
    adPlaying,
    muted: video.muted || finite(video.volume, 1) <= 0,
    visibleArea: pictureInPicture ? 1 : visibleShare(video),
  };
}
