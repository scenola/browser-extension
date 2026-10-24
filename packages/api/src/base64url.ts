/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Unpadded base64url (RFC 4648 §5, as JOSE uses it: RFC 7515 §2). Written out rather than
// through `btoa`: `btoa` needs a binary string, which means spreading the bytes into
// `String.fromCharCode` — unbounded — and `Uint8Array.prototype.toBase64` is newer than the
// Chrome this extension supports.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** The value of each ASCII code unit in the alphabet, or -1. */
const VALUE: Int8Array = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/** `bytes` in unpadded base64url. Linear in the input; any length, including none. */
export function base64urlEncode(bytes: Uint8Array): string {
  const chars: string[] = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    chars.push(
      ALPHABET.charAt((n >>> 18) & 63),
      ALPHABET.charAt((n >>> 12) & 63),
      ALPHABET.charAt((n >>> 6) & 63),
      ALPHABET.charAt(n & 63),
    );
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16;
    chars.push(ALPHABET.charAt((n >>> 18) & 63), ALPHABET.charAt((n >>> 12) & 63));
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    chars.push(
      ALPHABET.charAt((n >>> 18) & 63),
      ALPHABET.charAt((n >>> 12) & 63),
      ALPHABET.charAt((n >>> 6) & 63),
    );
  }
  return chars.join('');
}

/**
 * The bytes `text` encodes, or `null` when it is not canonical unpadded base64url: a character
 * outside the alphabet (padding, `+`, `/`, whitespace, anything non-ASCII), a length of
 * 4k + 1, or bits set after the last whole byte (so each byte string has exactly one
 * spelling). Total and linear: hostile text gives `null`, never a throw.
 */
export function base64urlDecode(text: string): Uint8Array | null {
  if (text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? (VALUE[code] ?? -1) : -1;
    if (value < 0) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >>> bits) & 0xff;
      buffer &= (1 << bits) - 1;
    }
  }
  return buffer === 0 ? out : null;
}
