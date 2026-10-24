/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PlaybackSample } from './coverage';
import type { EntryVerdict } from './entry-rule';
import { mergeReadings } from './reading';
import type { MergedReading, ServiceReading } from './reading';

export interface FrameReport {
  readonly frameId: number;
  readonly isTop: boolean;
  readonly sample: PlaybackSample | null;
  readonly reading: ServiceReading | null;
  readonly generic: readonly ServiceReading[];
  /**
   * The entry rule's verdict on the frame's page, on a site without a module: a page that
   * failed it gave no readings, and this says why. Absent on a module's site.
   */
  readonly entry?: EntryVerdict | undefined;
}

/** The frame an observation is about, and the reading of what it plays. */
export interface ElectedFrame {
  readonly player: FrameReport;
  readonly reading: MergedReading;
}

const isPlaying = (s: PlaybackSample | null): s is PlaybackSample =>
  s !== null && !s.paused && !s.ended;

/** Top frame first, then the lowest frame id. */
const byPrecedence = (a: FrameReport, b: FrameReport): number =>
  Number(b.isTop) - Number(a.isTop) || a.frameId - b.frameId;

/** `primary`'s fields over `fallback`'s, field by field. */
function overlay(
  primary: ServiceReading | null,
  fallback: ServiceReading | null,
): ServiceReading | null {
  if (primary === null || fallback === null) return primary ?? fallback;
  const merged: Record<string, unknown> = {};
  for (const source of [fallback, primary]) {
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

/**
 * The frame that is playing the title, and one reading for it. The player is the
 * playing frame covering the most of the viewport, an unmuted one before any muted
 * one (a muted autoplay preview is never the viewing); ties: top frame, then lowest
 * id. A muted player is elected only when no unmuted one plays, and a muted element
 * starts nothing of its own (`IngestObservation`).
 * **The election sticks to the open sitting**: the frame carrying
 * the tab's open sitting (`sittingFrameId`) wins over every muted frame, **playing or
 * paused** — a person who mutes the viewing keeps its coverage, the next episode
 * autoplaying on that player is the one elected, and a muted preview playing while the
 * viewing is paused is never the player: the paused sitting frame is, and a pause
 * changes nothing. So without `includeStopped` the result is a playing frame, or the
 * sitting's frame paused. An unmuted playing frame still comes first; among those the
 * larger wins, the sitting's frame included.
 * Its module reading is laid over the top frame's, since an embedded player often
 * knows the position and the page around it knows the title. When either frame's
 * module answered, that reading decides the identity and the frames' generic readings
 * fill none of it (`mergeReadings`).
 * `includeStopped` elects among paused and ended players too, by the same order: the
 * caller uses it to see a bound player end, never to start a viewing.
 */
export function electFrame(
  frames: readonly FrameReport[],
  options: { readonly includeStopped?: boolean; readonly sittingFrameId?: number | null } = {},
): ElectedFrame | null {
  const eligible =
    options.includeStopped === true
      ? (s: PlaybackSample | null): s is PlaybackSample => s !== null
      : isPlaying;
  const sitting = options.sittingFrameId ?? null;
  const isSitting = (f: FrameReport): boolean => f.frameId === sitting && f.sample !== null;
  const muted = (f: FrameReport): boolean => f.sample?.muted ?? true;
  // 0: an unmuted eligible frame; 1: the open sitting's frame, muted or paused; 2: the rest.
  const rank = (f: FrameReport): number =>
    eligible(f.sample) && !muted(f) ? 0 : isSitting(f) ? 1 : 2;
  const playing = frames
    .filter((f) => eligible(f.sample) || isSitting(f))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (b.sample?.visibleArea ?? 0) - (a.sample?.visibleArea ?? 0) ||
        byPrecedence(a, b),
    );
  const player = playing[0];
  if (player === undefined) return null;

  const top = frames.find((f) => f.isTop);
  const module = overlay(player.reading, top?.reading ?? null);
  const generic = [player, ...[...frames].sort(byPrecedence).filter((f) => f !== player)].flatMap(
    (f) => f.generic,
  );
  return { player, reading: mergeReadings(module, generic) };
}
