/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EpochMs } from './time';

const RANDOM_BYTES = 10;

/**
 * A UUIDv7 (RFC 9562 section 5.7): 48-bit millisecond timestamp, version 7,
 * variant 10, and 74 random bits. The caller supplies the clock and the random
 * source so the function stays pure.
 */
export function uuidv7(now: EpochMs, random: (n: number) => Uint8Array): string {
  const r = random(RANDOM_BYTES);
  if (r.length < RANDOM_BYTES) {
    throw new RangeError(
      `uuidv7 needs ${String(RANDOM_BYTES)} random bytes, got ${String(r.length)}`,
    );
  }
  const bytes = new Uint8Array(16);
  let ts = Math.floor(now);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = 0x70 | ((r[0] ?? 0) & 0x0f);
  bytes[7] = r[1] ?? 0;
  bytes[8] = 0x80 | ((r[2] ?? 0) & 0x3f);
  for (let i = 0; i < 7; i++) bytes[9 + i] = r[3 + i] ?? 0;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
