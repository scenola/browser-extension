/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The tab's state across observations, as `IngestObservation` keeps it: the reading holding still,
// the open sitting (its frame, its media length, its timeline), the player heard with sound and
// the reason a playing sample went nowhere. Storage is hostile: every stored field is read back
// as a value or as none.

import { MAX_SAMPLE_GAP_S } from '../../domain/coverage';
import type { PlaybackSample } from '../../domain/coverage';
import type { FrameReport } from '../../domain/frames';
import { ignoredOf } from '../../domain/ignored';
import type { IgnoredReason } from '../../domain/ignored';
import { viewingKey } from '../../domain/reading';
import type { MergedReading, ViewingKey } from '../../domain/reading';
import type { EpochMs } from '../../domain/time';
import { mediaLength, sameLength, showYearsSplit } from '../../domain/viewing';
import type { SoundedPlayer, TabState } from '../ports';

export const emptyTab = (tabId: number, now: EpochMs): TabState => ({
  tabId,
  viewingId: null,
  lastSample: null,
  sittingFrameId: null,
  sittingLength: null,
  sound: null,
  pendingReading: null,
  stableCount: 0,
  observedAt: now,
  addedAt: null,
  addedLabel: null,
});

/** The tab state's `ignored` after `why`: kept (`undefined`), cleared (`null`), or set now. */
export const ignoring = (
  tab: TabState,
  why: IgnoredReason | null | undefined,
  now: EpochMs,
): Pick<TabState, 'ignored'> =>
  why === undefined
    ? { ignored: ignoredOf(tab.ignored) }
    : { ignored: why === null ? null : { reason: why, at: now } };

/** The stored open sitting's frame; `null` when absent or not a frame id (storage is hostile). */
export function sittingFrameOf(tab: TabState): number | null {
  const f = tab.sittingFrameId;
  return typeof f === 'number' && Number.isInteger(f) ? f : null;
}

/** The stored sitting's media length; `null` when absent or not a length (storage is hostile). */
export function sittingLengthOf(tab: TabState): number | null {
  const d = tab.sittingLength;
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : null;
}

/**
 * The sample's element plays other media than the tab's sitting: inside the
 * sitting — moments after its last taken sample (`continuesSitting`) — the sitting's length
 * and this element's (while no ad shows, at least `MIN_CONTENT_SECONDS`) are both known and
 * not one media's (`sameLength`: more than max(60 s, 2 %) apart). A preview playing while the
 * viewing's player is paused is the case. Element is compared with element, never with a
 * stated length: a stitched stream's element runs longer than the content it states.
 *
 * Inside the sitting, or for as long as the observation still shows the sitting's frame
 * holding the sitting's media (`sittingHeld`: paused beside a preview playing elsewhere,
 * however long). Otherwise, after a longer gap, a sample of another length is a new sitting
 * (a reload onto a stream stitched with other ads, a later sitting of the same title), and
 * its length becomes the sitting's. A length that never lapsed would refuse such a stream
 * for good while the tab stays bound.
 */
export function fromOtherMedia(
  tab: TabState,
  sample: PlaybackSample,
  reading: MergedReading,
  sittingHeld: boolean,
): boolean {
  const sitting = sittingLengthOf(tab);
  const seen = mediaLength(sample, reading).element;
  return (
    sitting !== null &&
    seen !== null &&
    (sittingHeld || continuesSitting(tab.lastSample, sample)) &&
    !sameLength(sitting, seen)
  );
}

/**
 * Another frame than the sitting's was elected, and the sitting's frame still reports media
 * of the sitting's length — the viewing's player is there, paused or muted, beside it.
 */
export function sittingHeldElsewhere(
  tab: TabState,
  frames: readonly FrameReport[],
  electedFrameId: number,
): boolean {
  const frameId = sittingFrameOf(tab);
  const length = sittingLengthOf(tab);
  if (frameId === null || length === null || frameId === electedFrameId) return false;
  const held = frames.find((f) => f.frameId === frameId)?.sample;
  if (held === undefined || held === null || held.adPlaying) return false;
  return (
    held.duration !== null && Number.isFinite(held.duration) && sameLength(length, held.duration)
  );
}

/**
 * The sitting's length after a taken sample: the sample's element length when it shows one;
 * else, inside the same sitting, the length it had (an ad's sample says nothing of the
 * media), and none for a sitting that starts here.
 */
export function lengthAfter(
  tab: TabState,
  sample: PlaybackSample,
  reading: MergedReading,
  binds: boolean,
): number | null {
  const seen = mediaLength(sample, reading).element;
  if (seen !== null) return seen;
  return binds || !continuesSitting(tab.lastSample, sample) ? null : sittingLengthOf(tab);
}

/** The stored mark of a player heard with sound; `null` when absent or not such a mark. */
export function soundOf(tab: TabState): SoundedPlayer | null {
  const s = tab.sound;
  if (s === undefined || s === null) return null;
  return Number.isInteger(s.frameId) && Number.isFinite(s.at) ? s : null;
}

/**
 * The player heard with sound still plays the stretch it was heard in: `s` is that frame's,
 * at most `MAX_SAMPLE_GAP_S` after the frame last played — the gap that still makes one
 * stretch of playback (an autoplay countdown is a few seconds).
 */
export function stillHeard(
  mark: SoundedPlayer | null,
  frameId: number,
  s: PlaybackSample,
): boolean {
  return mark?.frameId === frameId && oneStretch(mark.at, s.at);
}

/**
 * The mark after a playing sample of `frameId`: sound sets it on that frame; the same frame's
 * muted playback carries it on while the stretch lasts, and clears it after a longer gap.
 * Another frame's muted playback leaves it as it is — it lapses by time.
 */
export function soundAfter(
  mark: SoundedPlayer | null,
  frameId: number,
  s: PlaybackSample,
): SoundedPlayer | null {
  if (!s.muted || stillHeard(mark, frameId, s)) return { frameId, at: s.at };
  return mark !== null && mark.frameId === frameId ? null : mark;
}

/**
 * Counts observations in a row naming one identity: one key, and no show years that split it.
 * A reading that names nothing counts nothing and breaks nothing.
 */
export function settle(
  tab: TabState,
  serviceId: string | null,
  key: ViewingKey | null,
  reading: MergedReading,
): TabState {
  if (key === null) return tab;
  const pending = tab.pendingReading;
  const same =
    pending !== null &&
    viewingKey(serviceId, pending) === key &&
    !showYearsSplit(serviceId, pending, reading);
  return { ...tab, pendingReading: reading, stableCount: same ? tab.stableCount + 1 : 1 };
}

/** `to` is at most `MAX_SAMPLE_GAP_S` after `from`: still one stretch of playback. */
function oneStretch(from: EpochMs, to: EpochMs): boolean {
  const gap = to - from;
  return gap >= 0 && gap <= MAX_SAMPLE_GAP_S * 1000;
}

/** The viewing's last sample was moments ago: the same stretch of playback. */
export function continuesSitting(last: PlaybackSample | null, s: PlaybackSample): boolean {
  return last !== null && oneStretch(last.at, s.at);
}
