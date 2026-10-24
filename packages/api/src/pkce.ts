/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// PKCE (RFC 7636) for the sign-in: a verifier and a `state`,
// each 32 random bytes in base64url, and the verifier's S256 challenge. The server accepts S256
// only and checks the verifier against `[A-Za-z0-9._~-]{43,128}`.

import { base64urlEncode } from './base64url';
import { s256 } from './digest';
import { ProtocolInputError } from './input-error';

/** Random bytes per verifier and per `state`: 256 bits each, 43 base64url characters. */
const PKCE_RANDOM_BYTES = 32;

/** RFC 7636 §4.1: 43–128 unreserved characters. */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** One sign-in's secrets; held for that flow only (memory and `storage.session`). */
export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
  readonly state: string;
}

/** `n` bytes from the platform's cryptographic generator (`crypto.getRandomValues`). */
export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/**
 * A verifier, its S256 challenge and a `state`, from two draws of 32 bytes from `random`
 * (`randomBytes` in the extension; a script in tests). Refuses (`bad_random`) a source that
 * answers anything but exactly 32 bytes, or the same bytes for both draws — a stub wired where
 * a generator belongs.
 */
export async function createPkce(random: (n: number) => Uint8Array): Promise<Pkce> {
  const verifier = base64urlEncode(draw(random));
  const state = base64urlEncode(draw(random));
  if (verifier === state) throw new ProtocolInputError('bad_random');
  return { verifier, challenge: await pkceChallenge(verifier), state };
}

/** RFC 7636 §4.2's S256: `BASE64URL(SHA-256(ASCII(verifier)))`. Refuses a non-verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  if (!isCodeVerifier(verifier)) throw new ProtocolInputError('bad_verifier');
  return s256(verifier);
}

/** Whether `value` is an RFC 7636 §4.1 code verifier: 43–128 unreserved characters. */
export function isCodeVerifier(value: unknown): value is string {
  return typeof value === 'string' && VERIFIER.test(value);
}

function draw(random: (n: number) => Uint8Array): Uint8Array {
  const bytes: unknown = random(PKCE_RANDOM_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.length !== PKCE_RANDOM_BYTES) {
    throw new ProtocolInputError('bad_random');
  }
  return bytes;
}
