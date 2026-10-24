/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';

import {
  ExpiringMap,
  NonceIssuer,
  SlidingWindow,
  base62,
  canonicalId,
  credentialChecksum,
  credentialKind,
  decodeId,
  encodeId,
  mintExtensionCredential,
  newId,
} from './state.ts';

// Vectors from the backend's own id and credential functions, run on 2026-10-21.

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));

describe('ids, as app.core.ids spells them', () => {
  test('encode_id', () => {
    expect(encodeId(bytesOf('0194f3a81b2c7d3e8f400123456789ab'))).toBe(
      '01jkstg6scfmz8yg014d2pf2db',
    );
    expect(encodeId(bytesOf('ff'.repeat(16)))).toBe('7zzzzzzzzzzzzzzzzzzzzzzzzz');
  });

  test('decode_id: either case, the aliases, at most 128 bits, no u', () => {
    const hex = (id: string): string => Buffer.from(decodeId(id) ?? []).toString('hex');
    expect(hex('01JXK4A9B2C8M4N6P8Q0R2S4T6')).toBe('01976645256262284a9ac8b8302c9346');
    expect(hex('O1jxk4a9b2c8m4n6p8q0r2s4t6')).toBe('01976645256262284a9ac8b8302c9346');
    expect(decodeId('8zzzzzzzzzzzzzzzzzzzzzzzzz')).toBeNull();
    expect(decodeId('01jxk4a9b2c8m4n6p8q0r2s4tu')).toBeNull();
    expect(decodeId('01jxk4a9b2c8m4n6p8q0r2s4t')).toBeNull();
    expect(canonicalId('OIL0000000000000000000000z')).toBe('0110000000000000000000000z');
  });

  test('a minted id is a UUIDv7 carrying its millisecond', () => {
    const at = Date.parse('2026-10-21T12:00:00.123Z');
    const bytes = decodeId(newId(at)) ?? new Uint8Array(16);
    expect(Buffer.from(bytes.subarray(0, 6)).readUIntBE(0, 6)).toBe(at);
    expect((bytes[6] ?? 0) >> 4).toBe(7);
    expect((bytes[8] ?? 0) >> 6).toBe(2);
  });
});

describe('credentials, as app.scrobbling.credentials makes them', () => {
  test('the checksum and base62 are the backend’s', () => {
    expect(credentialChecksum(`mts_ext_${'0'.repeat(43)}`)).toBe('4NBKgq');
    expect(credentialChecksum(`mts_ext_${'Z'.repeat(43)}`)).toBe('26NKEX');
    expect(credentialChecksum(`mts_pat_${'abc'.repeat(14)}d`)).toBe('2dq8aq');
    const bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    expect(base62(BigInt(`0x${bytes.toString('hex')}`), 43)).toBe(
      '003aUlTJC7tjlCTQj2uNU3MFagCXG9LRKRcwGkBIDlf',
    );
  });

  test('a minted credential has its kind; a changed character does not', () => {
    const credential = mintExtensionCredential();
    expect(credential).toMatch(/^mts_ext_[0-9A-Za-z]{49}$/);
    expect(credentialKind(credential)).toBe('extension');
    const last = credential.at(-1) === 'a' ? 'b' : 'a';
    expect(credentialKind(credential.slice(0, -1) + last)).toBeNull();
    expect(credentialKind(`mts_ext_${'0'.repeat(43)}4NBKgq`)).toBe('extension');
    expect(credentialKind(`mts_pat_${'0'.repeat(43)}4NBKgq`)).toBeNull();
  });
});

describe('the nonce', () => {
  test('current in its bucket and the next; stale after', () => {
    const nonces = new NonceIssuer();
    const t0 = Date.parse('2026-10-21T12:00:00Z');
    const nonce = nonces.issue(t0);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(nonces.isCurrent(nonce, t0 + 299_999)).toBe(true);
    expect(nonces.isCurrent(nonce, t0 + 599_999)).toBe(true);
    expect(nonces.isCurrent(nonce, t0 + 600_000)).toBe(false);
    expect(new NonceIssuer().isCurrent(nonce, t0)).toBe(false);
  });
});

describe('bounded stores', () => {
  test('the sliding window refuses at capacity, waits for the oldest, never below a second', () => {
    const window = new SlidingWindow(2);
    expect(window.admit(0).allowed).toBe(true);
    expect(window.admit(59_500).allowed).toBe(true);
    expect(window.admit(59_600)).toEqual({ allowed: false, count: 2, retryAfterSeconds: 1 });
    expect(window.admit(60_000).allowed).toBe(true);
    expect(window.admit(60_000)).toEqual({ allowed: false, count: 2, retryAfterSeconds: 60 });
  });

  test('an expiring map drops its oldest past its cap, and an entry at its lifetime', () => {
    const map = new ExpiringMap<number>(2, 1000);
    map.set('a', 1, 0);
    map.set('b', 2, 0);
    map.set('c', 3, 0);
    expect(map.get('a', 0)).toBeUndefined();
    expect(map.get('b', 999)).toBe(2);
    expect(map.get('b', 1000)).toBeUndefined();
    expect(map.size).toBeLessThanOrEqual(2);
  });
});
