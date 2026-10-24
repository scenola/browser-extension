/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { base64urlEncode } from './base64url';

/** Visible ASCII, no space: every string this package hashes is drawn from it. */
const VISIBLE_ASCII = /^[\x21-\x7e]*$/;

/**
 * `BASE64URL(SHA-256(ASCII(value)))` — RFC 7636's S256 challenge of a verifier, RFC 9449's
 * `ath` of an access token, and (over its canonical JSON) RFC 7638's thumbprint of a key: the
 * server's `s256` and `jwk_thumbprint`. Callers check their own syntax first, which is always
 * visible ASCII, so UTF-8 here is ASCII; a value outside it is a bug in the caller.
 */
export async function s256(value: string): Promise<string> {
  if (!VISIBLE_ASCII.test(value)) throw new RangeError('s256 hashes visible ASCII only');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return base64urlEncode(new Uint8Array(digest));
}
