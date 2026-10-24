/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from 'vitest';

import { PAUSE_INDEFINITELY } from '../domain/settings';
import { HOUR_MS } from '../domain/time';
import { T0, makeWorld } from './test-world';

test('pauses until a moment, and resumes with null', async () => {
  const w = makeWorld();
  await w.pause.execute(T0 + HOUR_MS);
  expect(w.settings.value.pausedUntil).toBe(T0 + HOUR_MS);
  await w.pause.execute(null);
  expect(w.settings.value.pausedUntil).toBeNull();
});

test('"until I turn it back on" is stored as PAUSE_INDEFINITELY and holds', async () => {
  const w = makeWorld();
  await w.pause.execute(PAUSE_INDEFINITELY);
  expect(w.settings.value.pausedUntil).toBe(PAUSE_INDEFINITELY);
  await w.pause.execute(null);
  expect(w.settings.value.pausedUntil).toBeNull();
});

test('a moment already past is no pause at all', async () => {
  const w = makeWorld();
  await w.pause.execute(T0);
  expect(w.settings.value.pausedUntil).toBeNull();
});

test('a time that is not a number is refused', async () => {
  const w = makeWorld();
  await expect(w.pause.execute(Number.NaN)).rejects.toThrow(RangeError);
  expect(w.settings.value.pausedUntil).toBeNull();
});
