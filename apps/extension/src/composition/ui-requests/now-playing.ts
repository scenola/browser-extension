/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The popup's *Now playing* line, from what the worker knows of a tab (`UiRequests.#tabNow`):
// the tab's viewing, or why what plays there goes nowhere.

import { playRefusal } from '@mt/core';
import type { IgnoredReason, PlaybackSample, Viewing } from '@mt/core';

import type { NowPlaying } from '../../messaging/protocol';
import { siteForHostname } from '../../sites';
import { readingLabel } from '../support';

/** A bound viewing's line in the popup; an expired one is no longer shown. */
const NOW_PLAYING_STATE = {
  open: 'tracking',
  reported: 'added',
  skipped: 'skipped',
} as const satisfies Readonly<Record<Exclude<Viewing['state'], 'expired'>, NowPlaying['state']>>;

/** A tab as *Now playing* reads it (`UiRequests.#tabNow`). */
export interface TabNow {
  readonly hostname: string | null;
  readonly viewing: Viewing | null;
  readonly sample: PlaybackSample | null;
  /** The reason the tab kept, while recent; else `null`. */
  readonly ignored: IgnoredReason | null;
  readonly unreachable: boolean;
}

/** *Now playing* with nothing bound: the tab and its service's name, `not_tracked`. */
export function blankLine(tabId: number, hostname: string | null): NowPlaying {
  const site = hostname === null ? null : siteForHostname(hostname);
  return {
    tabId,
    serviceName: site?.name ?? hostname ?? '',
    label: '',
    episodeTitle: null,
    progress: null,
    state: 'not_tracked',
    viewingId: null,
    origin: null,
    reason: null,
    problem: null,
  };
}

/** *Now playing* for the tab's viewing: what it is, how far, and whether it will be added. */
export function viewingLine(
  shown: NowPlaying,
  viewing: Viewing,
  state: Exclude<Viewing['state'], 'expired'>,
  sample: PlaybackSample | null,
): NowPlaying {
  const duration = viewing.durationSeconds ?? sample?.duration ?? null;
  const { reading } = viewing;
  return {
    ...shown,
    label: readingLabel(reading),
    episodeTitle: reading.kind === 'episode' ? (reading.episodeTitle ?? null) : null,
    progress:
      sample === null || duration === null
        ? null
        : { position: Math.min(sample.position, duration), duration },
    state: NOW_PLAYING_STATE[state],
    viewingId: viewing.id,
    // The play builder would refuse its reading: it will not be added.
    problem: state === 'open' ? playRefusal(viewing) : null,
  };
}

/**
 * Why what plays on a tracked site goes nowhere: the first gate it failed, in the worker's order —
 * a pause, an incognito tab without the setting, the service turned off — then the reason the tab
 * kept, then a player no frame samples. `null` when nothing plays, or nothing stops it.
 */
export function notTrackingReason(gates: {
  readonly playing: boolean;
  readonly paused: boolean;
  readonly incognitoRefused: boolean;
  readonly turnedOff: boolean;
  readonly ignored: IgnoredReason | null;
  readonly unreachable: boolean;
}): IgnoredReason | null {
  if (!gates.playing) return null;
  if (gates.paused) return 'tracking_paused';
  if (gates.incognitoRefused) return 'incognito';
  if (gates.turnedOff) return 'service_off';
  if (gates.ignored !== null) return gates.ignored;
  return gates.unreachable ? 'player_unreachable' : null;
}
