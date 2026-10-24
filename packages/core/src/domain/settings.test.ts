/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from 'vitest';

import {
  DEFAULT_SETTINGS,
  HISTORY_DAYS,
  PAUSE_INDEFINITELY,
  isHistoryDays,
  isIndefinitePause,
  isPaused,
} from './settings';

test('the defaults: nothing paused, incognito off, history 7 days, no counting setting', () => {
  expect(DEFAULT_SETTINGS).toEqual({
    // Settings version 3 has no counting threshold: the line is the account's.
    pausedUntil: null,
    trackIncognito: false,
    disabledServices: [],
    excludedHosts: [],
    allowedHosts: [],
    allSites: false,
    diagnostics: false,
    historyDays: 7,
  });
});

test('the history is kept 1, 7 or 30 days, and for no other length', () => {
  expect(HISTORY_DAYS).toEqual([1, 7, 30]);
  for (const days of HISTORY_DAYS) expect(isHistoryDays(days)).toBe(true);
  for (const other of [0, 2, 31, 365, '7', null, undefined, Number.NaN]) {
    expect(isHistoryDays(other)).toBe(false);
  }
});

test('paused strictly until the moment it ends', () => {
  expect(isPaused(null, 100)).toBe(false);
  expect(isPaused(101, 100)).toBe(true);
  expect(isPaused(100, 100)).toBe(false);
});

test('"until I turn it back on" is a finite time that survives JSON and never ends', () => {
  expect(Number.isFinite(PAUSE_INDEFINITELY)).toBe(true);
  expect(JSON.parse(JSON.stringify({ pausedUntil: PAUSE_INDEFINITELY }))).toEqual({
    pausedUntil: PAUSE_INDEFINITELY,
  });
  expect(isPaused(PAUSE_INDEFINITELY, Date.parse('2200-01-01T00:00:00Z'))).toBe(true);
});

test('the indefinite pause is past the Date range, so it is asked about, never formatted', () => {
  expect(Number.isNaN(new Date(PAUSE_INDEFINITELY).getTime())).toBe(true);
  expect(isIndefinitePause(PAUSE_INDEFINITELY)).toBe(true);
  expect(isIndefinitePause(Date.parse('2200-01-01T00:00:00Z'))).toBe(false);
  expect(isIndefinitePause(null)).toBe(false);
});

test('any time past the Date range is indefinite, and every time inside it is not', () => {
  const last = 8.64e15;
  expect(Number.isNaN(new Date(last).getTime())).toBe(false);
  expect(isIndefinitePause(last)).toBe(false);
  // One past the range: as impossible to format or schedule as PAUSE_INDEFINITELY.
  expect(Number.isNaN(new Date(last + 1).getTime())).toBe(true);
  expect(isIndefinitePause(last + 1)).toBe(true);
  expect(isIndefinitePause(PAUSE_INDEFINITELY - 1)).toBe(true);
  expect(isIndefinitePause(Number.POSITIVE_INFINITY)).toBe(true);
});
