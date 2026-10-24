/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';

import { MAX_NONCE_LENGTH, memoryNonceStore, parseDpopNonce } from './nonce';

// RFC 9449 §8.1: nonce = 1*NQCHAR; RFC 6749 Appendix A: NQCHAR = %x21 / %x23-5B / %x5D-7E.
const EVERY_NQCHAR = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) =>
  String.fromCharCode(0x21 + i),
)
  .filter((c) => c !== '"' && c !== '\\')
  .join('');

describe('parseDpopNonce', () => {
  test("the server's nonce (base64url of 32 bytes) and every NQCHAR are nonces", () => {
    const server = 'kq3Pz0b1v9mXQe2Yb3oF1n0rPq8sT5uVwXyZa7cD4eE';
    expect(parseDpopNonce(server)).toBe(server);
    expect(parseDpopNonce(EVERY_NQCHAR)).toBe(EVERY_NQCHAR);
    expect(parseDpopNonce('n'.repeat(MAX_NONCE_LENGTH))).toBe('n'.repeat(MAX_NONCE_LENGTH));
  });

  test.each([
    ['absent (Headers.get answers null)', null],
    ['not a string', 42],
    ['empty', ''],
    ['one past the bound', 'n'.repeat(MAX_NONCE_LENGTH + 1)],
    ['a space', 'abc def'],
    ['two headers, joined by Headers.get', 'n1, n2'],
    ['a double quote', 'abc"def'],
    ['a backslash', 'abc\\def'],
    ['a tab', 'abc\tdef'],
    ['a newline', 'abc\ndef'],
    ['DEL', 'abc\u007fdef'],
    ['a non-ASCII letter', 'abcédef'],
    ['an astral character', 'abc\u{1F600}'],
  ])('%s is not a nonce', (_name, value) => {
    expect(parseDpopNonce(value)).toBeNull();
  });
});

describe('memoryNonceStore', () => {
  test('starts empty and keeps the latest nonce', async () => {
    const store = memoryNonceStore();
    expect(await store.get()).toBeNull();
    await store.set('n1');
    await store.set('n2');
    expect(await store.get()).toBe('n2');
  });

  test('a value that is not a nonce is not stored; the previous one stays', async () => {
    const store = memoryNonceStore();
    await store.set('n1');
    await store.set('n2, n3');
    await store.set('');
    await store.set('x'.repeat(MAX_NONCE_LENGTH + 1));
    expect(await store.get()).toBe('n1');
  });

  test('two stores share nothing', async () => {
    const a = memoryNonceStore();
    const b = memoryNonceStore();
    await a.set('n1');
    expect(await b.get()).toBeNull();
  });
});
