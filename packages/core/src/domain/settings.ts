/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MAX_DATE_MS } from './time';
import type { EpochMs } from './time';

/**
 * The person's preferences in this browser. The platform stores them; core decides from them.
 * When a viewing counts is not one of them: that line is the account's, read with the connection.
 */
export interface SettingsValue {
  /** Tracking is paused while this lies in the future; `null` is not paused. */
  readonly pausedUntil: EpochMs | null;
  readonly trackIncognito: boolean;
  /** Built-in service ids the person turned off. */
  readonly disabledServices: readonly string[];
  /** Hosts never tracked, even with all sites on. */
  readonly excludedHosts: readonly string[];
  /** Single sites the person allowed. */
  readonly allowedHosts: readonly string[];
  readonly allSites: boolean;
  readonly diagnostics: boolean;
  /** How long the local history keeps a play after it was sent, in days. */
  readonly historyDays: HistoryDays;
}

/**
 * The lengths the person can keep the history for. Thirty days is the most: a play's answer is
 * read back for thirty days (`RECEIPT_READ_WINDOW_MS`), and no longer.
 */
export const HISTORY_DAYS = [1, 7, 30] as const;
export type HistoryDays = (typeof HISTORY_DAYS)[number];

export function isHistoryDays(x: unknown): x is HistoryDays {
  return (HISTORY_DAYS as readonly unknown[]).includes(x);
}

/** Version 3 of the settings, as a fresh install has them: no counting threshold of its own. */
export const DEFAULT_SETTINGS: SettingsValue = {
  pausedUntil: null,
  trackIncognito: false,
  disabledServices: [],
  excludedHosts: [],
  allowedHosts: [],
  allSites: false,
  diagnostics: false,
  historyDays: 7,
};

/**
 * `pausedUntil` for "until I turn it back on". Finite, because settings are
 * stored as JSON, where `Infinity` becomes `null` — which would silently mean not paused.
 * It lies past the `Date` range (±8.64e15 ms): `new Date(PAUSE_INDEFINITELY)` is invalid,
 * so nothing may format it as a time or schedule an alarm at it — ask `isIndefinitePause`.
 */
export const PAUSE_INDEFINITELY: EpochMs = Number.MAX_SAFE_INTEGER;

/**
 * The pause has no end time to show or wake up at: any `pausedUntil` past the `Date` range,
 * not only `PAUSE_INDEFINITELY` — a stored value from another version, or one a bug wrote,
 * would be just as impossible to format or schedule.
 */
export function isIndefinitePause(pausedUntil: EpochMs | null): boolean {
  return pausedUntil !== null && pausedUntil > MAX_DATE_MS;
}

/** The one reading of `pausedUntil`: paused strictly before that moment. */
export function isPaused(pausedUntil: EpochMs | null, now: EpochMs): boolean {
  return pausedUntil !== null && pausedUntil > now;
}

/** A viewing with an incognito sitting is sent only while incognito tracking is on. */
export function reportAllowed(
  viewing: { readonly incognito: boolean },
  settings: SettingsValue,
): boolean {
  return !viewing.incognito || settings.trackIncognito;
}
