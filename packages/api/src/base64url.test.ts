/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { base64url as jose } from 'jose';
import { describe, expect, test } from 'vitest';

import { base64urlDecode, base64urlEncode } from './base64url';

// RFC 7515 Appendix C: the octets [3, 236, 255, 224, 193] are "A-z_4ME" — both URL-safe
// characters and a two-character tail in one vector.
const RFC7515_C = new Uint8Array([3, 236, 255, 224, 193]);

// RFC 7636 Appendix B: the 32 octets whose base64url is the example code verifier.
const RFC7636_B = new Uint8Array([
  116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105,
  214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
]);

function bytesOf(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 37 + seed) & 0xff);
}

test('RFC 7515 Appendix C: [3, 236, 255, 224, 193] is "A-z_4ME", both ways', () => {
  expect(base64urlEncode(RFC7515_C)).toBe('A-z_4ME');
  expect(base64urlDecode('A-z_4ME')).toEqual(RFC7515_C);
});

test('RFC 7636 Appendix B: the 32 example octets are the example verifier', () => {
  expect(base64urlEncode(RFC7636_B)).toBe('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  expect(base64urlDecode('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toEqual(RFC7636_B);
});

test('every length from 0 to 70 bytes matches an independent encoder and round-trips', () => {
  for (let length = 0; length <= 70; length++) {
    const bytes = bytesOf(length, length + 11);
    const text = base64urlEncode(bytes);
    expect(text).toBe(jose.encode(bytes));
    expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
    expect(base64urlDecode(text)).toEqual(bytes);
  }
});

test('all 256 byte values round-trip', () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  expect(base64urlDecode(base64urlEncode(all))).toEqual(all);
  expect(base64urlEncode(all)).toBe(jose.encode(all));
});

test('nothing is nothing', () => {
  expect(base64urlEncode(new Uint8Array(0))).toBe('');
  expect(base64urlDecode('')).toEqual(new Uint8Array(0));
});

describe('decoding refuses anything but canonical, unpadded base64url — with null, never a throw', () => {
  test.each([
    ['A-z_4ME=', 'padding'],
    ['A-z_4M==', 'padding on a 4k+2 tail'],
    ['A+z/4ME', 'the base64 alphabet, not base64url'],
    ['A', 'a length of 4k + 1'],
    ['A-z_4M', 'non-zero bits after the last whole byte (4k + 2)'],
    ['A-z_4MF', 'non-zero bits after the last whole byte (4k + 3)'],
    ['A-z 4ME', 'a space'],
    ['A-z_4M\n', 'a newline'],
    ['A-z_4M\u0000', 'a NUL'],
    ['A-z_4MÉ', 'a non-ASCII letter'],
    ['A-z_4M\u{1F600}', 'an astral character'],
    ['.-z_4ME', 'a character just outside the alphabet'],
  ])('%j (%s)', (text) => {
    expect(base64urlDecode(text)).toBeNull();
  });
});
