/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expiringSoon } from './connection';
import type { ConnectionState } from './connection';
import type { MessageKey } from './messages';
import { isIndefinitePause, isPaused } from './settings';
import type { EpochMs } from './time';

/** Why a tab that reported is not tracked: the page's site, a service, incognito. */
export type NotTracked =
  | { readonly why: 'site' | 'incognito' }
  | { readonly why: 'service_off'; readonly service: string };

export interface StatusInputs {
  readonly connection: ConnectionState;
  readonly pausedUntil: EpochMs | null;
  readonly now: EpochMs;
  /** The tab's own state; `null` is the default every tab without one shows (not tracking). */
  readonly tab: {
    readonly tracking: { label: string } | null;
    readonly addedAt: EpochMs | null;
    readonly addedLabel: string | null;
    readonly notTracked: NotTracked | null;
  } | null;
  readonly waitingCount: number;
  readonly problem: 'plus_lapsed' | 'braked' | null;
}

export interface Status {
  /** `recording` is the green mark, `dimmed` is "not tracking here". */
  readonly icon: 'outline' | 'recording' | 'filled-check' | 'dimmed';
  readonly badge: { readonly text: string; readonly tone: 'lamp' | 'danger' } | null;
  readonly tooltip: {
    readonly key: MessageKey;
    readonly params: Readonly<Record<string, string | number>>;
  };
}

/** How long the check mark stays after a play is added. */
const ADDED_SHOWN_MS = 10_000;
const LAMP_MAX = 9;

type Tooltip = Status['tooltip'];
const say = (key: MessageKey, params: Tooltip['params'] = {}): Tooltip => ({ key, params });

function problemTooltip(i: StatusInputs): Tooltip | null {
  if (i.connection.kind === 'none') return say('status.disconnected');
  if (i.connection.kind === 'broken') return say('status.connection_broken');
  if (i.problem !== null) return say(`status.problem.${i.problem}`);
  if (expiringSoon(i.connection, i.now)) return say('status.connection_expiring');
  return null;
}

type Tab = NonNullable<StatusInputs['tab']>;

/** The check mark's moment: a play was added in this tab within `ADDED_SHOWN_MS`. */
function justAdded(tab: Tab | null, now: EpochMs): boolean {
  const at = tab?.addedAt ?? null;
  return at !== null && now - at >= 0 && now - at <= ADDED_SHOWN_MS;
}

/** The toolbar's state: the icon from the tab, the badge from what needs the person, words for both. */
export function computeStatus(i: StatusInputs): Status {
  const problem = problemTooltip(i);
  const paused = isPaused(i.pausedUntil, i.now);
  return {
    icon: iconOf(i.tab, paused, i.now),
    badge: badgeOf(problem !== null, i.waitingCount),
    tooltip: problem ?? tooltipOf(i, paused),
  };
}

function iconOf(tab: Tab | null, paused: boolean, now: EpochMs): Status['icon'] {
  if (paused || tab === null) return 'dimmed';
  if (tab.notTracked !== null) return 'dimmed';
  if (justAdded(tab, now)) return 'filled-check';
  return tab.tracking !== null ? 'recording' : 'outline';
}

function badgeOf(problem: boolean, waitingCount: number): Status['badge'] {
  if (problem) return { text: '!', tone: 'danger' };
  if (waitingCount <= 0) return null;
  return {
    text: waitingCount > LAMP_MAX ? `${String(LAMP_MAX)}+` : String(waitingCount),
    tone: 'lamp',
  };
}

/** The words when nothing is wrong: a pause, a play just added, plays waiting, then the tab. */
function tooltipOf(i: StatusInputs, paused: boolean): Tooltip {
  if (i.pausedUntil !== null && paused) {
    return isIndefinitePause(i.pausedUntil)
      ? say('status.paused_indefinitely')
      : say('status.paused', { until: i.pausedUntil });
  }
  if (i.tab !== null && justAdded(i.tab, i.now)) {
    return i.tab.addedLabel === null
      ? say('status.added_plain')
      : say('status.added', { label: i.tab.addedLabel });
  }
  if (i.waitingCount > 0) return say('status.waiting', { count: i.waitingCount });
  return tabTooltip(i.tab);
}

function tabTooltip(tab: Tab | null): Tooltip {
  const notTracked = tab?.notTracked ?? null;
  if (notTracked !== null) {
    if (notTracked.why === 'service_off') {
      return say('status.service_off', { service: notTracked.service });
    }
    return say(notTracked.why === 'incognito' ? 'status.incognito_off' : 'status.blocked');
  }
  if (tab === null) return say('status.not_tracking');
  return tab.tracking !== null
    ? say('status.tracking', { label: tab.tracking.label })
    : say('status.idle');
}
