/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';

import { DEFAULT_RULE, readAccountRule, startLine } from './account-rule';

const at = (startThresholdPercent: number, startFloorSeconds = 300) => ({
  startThresholdPercent,
  startFloorSeconds,
  finishThresholdPercent: 70,
});

describe('the start line', () => {
  test.each([
    // 10 % of a 9960 s story is 996 s, past the floor.
    [10, 9960, 996],
    // 5 % of 5400 s is 270 s: the floor binds.
    [5, 5400, 300],
    // 20 % of 1001 s is 200.2 s: rounded up to 201, then the floor binds.
    [20, 1001, 300],
    // 10 % of 10 001 s is 1000.1 s: rounded up to a whole second.
    [10, 10_001, 1001],
  ])('%i %% of a %i s story is reached at %i s played', (percent, story, line) => {
    expect(startLine(at(percent), story)).toBe(line);
  });

  test('a floor of 0 leaves the share alone', () => {
    expect(startLine(at(5, 0), 1001)).toBe(51);
  });

  test('starts off draw no line', () => {
    expect(startLine(DEFAULT_RULE, 9960)).toBeNull();
  });
});

describe('the rule as the connection states it', () => {
  test('three fields in bounds are the rule', () => {
    expect(readAccountRule(10, 300, 70)).toEqual({
      rule: { startThresholdPercent: 10, startFloorSeconds: 300, finishThresholdPercent: 70 },
      invalid: [],
    });
  });

  test('a null start threshold is starts off, and nothing is wrong', () => {
    expect(readAccountRule(null, 300, 70)).toEqual({ rule: DEFAULT_RULE, invalid: [] });
  });

  test('the never-read rule: starts off, the finish at the server’s 70 %', () => {
    expect(DEFAULT_RULE).toEqual({
      startThresholdPercent: null,
      startFloorSeconds: 0,
      finishThresholdPercent: 70,
    });
  });

  test.each<[string, unknown, unknown, readonly string[]]>([
    [
      'both start fields missing',
      undefined,
      undefined,
      ['start_threshold_percent', 'start_floor_seconds'],
    ],
    ['a threshold of 0', 0, 300, ['start_threshold_percent']],
    ['a threshold over 100', 101, 300, ['start_threshold_percent']],
    ['a threshold as text', '10', 300, ['start_threshold_percent']],
    ['a negative floor', 10, -1, ['start_floor_seconds']],
    ['a floor in fractions', 10, 1.5, ['start_floor_seconds']],
    ['a floor past a week', 10, 7 * 24 * 3600 + 1, ['start_floor_seconds']],
  ])('%s is starts off, and the fields are named', (_name, threshold, floor, invalid) => {
    expect(readAccountRule(threshold, floor, 70)).toEqual({ rule: DEFAULT_RULE, invalid });
  });

  test('a finish line missing or out of bounds is the server’s 70 %, named; starts stand', () => {
    expect(readAccountRule(10, 300, undefined)).toEqual({
      rule: at(10),
      invalid: ['finish_threshold_percent'],
    });
    expect(readAccountRule(10, 300, 101).rule.finishThresholdPercent).toBe(70);
  });

  test('a finish line read always wins over the default', () => {
    for (const finish of [50, 90]) {
      expect(readAccountRule(null, 300, finish).rule.finishThresholdPercent).toBe(finish);
    }
  });
});
