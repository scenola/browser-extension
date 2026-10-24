/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MAX_SECONDS, buildStart } from './play';
import type { StartBody } from './play';
import type { EpochMs } from './time';
import { playedSeconds, shareLine, storySeconds } from './viewing';
import type { Viewing } from './viewing';

/**
 * What the person's account decides about reports, as the connection check last read it. The
 * account sets these lines, not the extension: they are set in the app and apply to every
 * connected service. One object read from one route, so a line the account adds is one field.
 * Both lines are shares of a film's or an episode's story, measured by the story seconds played.
 */
export interface AccountRule {
  /** A film begun is saved in progress past this share of its story; `null`: starts are off. */
  readonly startThresholdPercent: number | null;
  /** No start counts before this many seconds played, whatever the share. */
  readonly startFloorSeconds: number;
  /** A viewing counts once this share of its story was played. */
  readonly finishThresholdPercent: number;
}

/** The server's finish line for an account that never chose one. */
export const DEFAULT_FINISH_THRESHOLD_PERCENT = 70;

/**
 * The rule while none was read, or what was read cannot be trusted: nothing is started, and a
 * viewing counts at the server's own default line.
 */
export const DEFAULT_RULE: AccountRule = {
  startThresholdPercent: null,
  startFloorSeconds: 0,
  finishThresholdPercent: DEFAULT_FINISH_THRESHOLD_PERCENT,
};

/** The wire's names of the rule's fields, for the diagnostics log. */
export type AccountRuleField =
  'start_threshold_percent' | 'start_floor_seconds' | 'finish_threshold_percent';

/** The rule as read, and the fields that were missing or out of bounds. */
export interface ReadRule {
  readonly rule: AccountRule;
  readonly invalid: readonly AccountRuleField[];
}

const isShare = (x: unknown): x is number =>
  typeof x === 'number' && Number.isFinite(x) && x >= 1 && x <= 100;

const isFloor = (x: unknown): x is number =>
  typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= MAX_SECONDS;

/**
 * The rule from the three values the server states, as they arrived. A start threshold of
 * `null` is the account's word that starts are off. Anything else that is not a share from 1 to
 * 100, or a floor that is not a whole number of seconds the wire allows, turns starts off: a
 * line misread would save films nobody began. A finish line that cannot be read is the server's
 * default, never none: a viewing always has a line.
 */
export function readAccountRule(threshold: unknown, floor: unknown, finish: unknown): ReadRule {
  const invalid: AccountRuleField[] = [];
  if (threshold !== null && !isShare(threshold)) invalid.push('start_threshold_percent');
  if (!isFloor(floor)) invalid.push('start_floor_seconds');
  if (!isShare(finish)) invalid.push('finish_threshold_percent');
  const finishThresholdPercent = isShare(finish) ? finish : DEFAULT_FINISH_THRESHOLD_PERCENT;
  const startsOn =
    !invalid.includes('start_threshold_percent') && !invalid.includes('start_floor_seconds');
  return {
    rule:
      startsOn && isShare(threshold) && isFloor(floor)
        ? { startThresholdPercent: threshold, startFloorSeconds: floor, finishThresholdPercent }
        : { ...DEFAULT_RULE, finishThresholdPercent },
    invalid,
  };
}

/**
 * Where a film whose story is `storySeconds` long counts as begun: the larger of the share and
 * the floor, in story seconds played. `null` while starts are off.
 */
export function startLine(rule: AccountRule, storySeconds: number): number | null {
  const percent = rule.startThresholdPercent;
  if (percent === null) return null;
  return Math.max(shareLine(percent, storySeconds), rule.startFloorSeconds);
}

/** When the viewing's start was queued; `null` for none yet, and for a viewing stored before. */
export function startSentAtOf(v: Viewing): EpochMs | null {
  const at: unknown = v.startSentAt;
  return typeof at === 'number' && Number.isFinite(at) ? at : null;
}

/** The id reserved for the viewing's start; `null` for none yet. */
export function startPlayIdOf(v: Viewing): string | null {
  const id: unknown = v.startPlayId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * The start the viewing is due to send now, or `null`: an open film whose story is known, whose
 * own play is neither reserved nor sent, whose start was not queued yet, and of whose story the
 * seconds played have reached the account's line. Skipped time is not played, so a skip ahead
 * starts nothing. One start per viewing, and never for one skipped.
 */
export function dueStart(v: Viewing, rule: AccountRule): StartBody | null {
  if (v.state !== 'open' || v.reportedPlayId !== null || startSentAtOf(v) !== null) return null;
  if (v.reading.kind !== 'movie') return null;
  const story = storySeconds(v);
  const line = story === null ? null : startLine(rule, story);
  if (line === null || playedSeconds(v) < line) return null;
  return buildStart(v);
}
