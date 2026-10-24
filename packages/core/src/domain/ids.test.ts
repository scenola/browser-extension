/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from 'vitest';
import { uuidv7 } from './ids';

test('uuidv7 is version 7, variant 10, time-ordered', () => {
  const a = uuidv7(1_700_000_000_000, () => new Uint8Array(10).fill(0xff));
  const b = uuidv7(1_700_000_000_001, () => new Uint8Array(10));
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(a < b).toBe(true);
});

test('uuidv7 puts the millisecond timestamp in the first 48 bits', () => {
  const id = uuidv7(0x0123_4567_89ab, () => new Uint8Array(10));
  expect(id.replace(/-/g, '').slice(0, 12)).toBe('0123456789ab');
});

test('uuidv7 asks for ten random bytes and refuses fewer', () => {
  let asked = 0;
  uuidv7(1, (n) => {
    asked = n;
    return new Uint8Array(n);
  });
  expect(asked).toBe(10);
  expect(() => uuidv7(1, () => new Uint8Array(4))).toThrow();
});
