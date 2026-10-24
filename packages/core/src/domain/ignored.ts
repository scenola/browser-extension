/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EpochMs } from './time';

/**
 * Why a video that plays is not tracked, one closed list, in the pipeline's order:
 * the first gate an observation fails is its reason.
 *
 * - `tracking_paused`, `incognito`, `service_off`: the worker's gates before the core. They stop
 *   the collector, or the observation, so the worker tells them from the tab and the settings.
 * - `not_player_page`: a module's site whose top frame is off a player route, told by the
 *   worker, kept by the core (`IngestObservation.ignore`).
 * - `ad` to `settling`: the core's own (`IngestObservation`).
 * - `player_unreachable`: the tab is audible and none of its frames sent a sample in the last
 *   30 s — the worker's, from the tab.
 *
 * `series_no_episode` and `no_title` are also why a bound viewing could not become a play
 * (`playRefusal`).
 */
export const IGNORED_REASONS = [
  'tracking_paused',
  'incognito',
  'service_off',
  'not_player_page',
  'ad',
  'short',
  'muted',
  'page_silent',
  'series_no_episode',
  'no_title',
  'settling',
  'player_unreachable',
] as const;

export type IgnoredReason = (typeof IGNORED_REASONS)[number];

/** Why a tab's playing media last went nowhere, and when. */
export interface Ignored {
  readonly reason: IgnoredReason;
  readonly at: EpochMs;
}

/** A stored `Ignored`, or `null` when absent or not one (storage is hostile). */
export function ignoredOf(x: unknown): Ignored | null {
  const i = x as Partial<Ignored> | null | undefined;
  return typeof i?.at === 'number' && (IGNORED_REASONS as readonly unknown[]).includes(i.reason)
    ? (x as Ignored)
    : null;
}
