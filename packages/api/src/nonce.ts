/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The server's DPoP nonce (RFC 9449 §8–9). Freshness is the server's
// nonce, never this browser's clock: a stateless HMAC of a 5-minute bucket, the current and the
// previous accepted, so a nonce lives 5 to 10 minutes. Every answer to a request whose proof
// verified carries a fresh `DPoP-Nonce`; a stale or missing one is answered with a new nonce and
// the client retries once.

/**
 * The longest nonce kept. The server's is 43 characters; this bound is what keeps a proof
 * inside the server's 4096-byte limit at every other input's maximum (pinned by a test).
 */
export const MAX_NONCE_LENGTH = 256;

/** RFC 9449 §8.1: `nonce = 1*NQCHAR`; RFC 6749 Appendix A: `%x21 / %x23-5B / %x5D-7E`. */
const NONCE = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

/**
 * `value` when it is a nonce — 1 to `MAX_NONCE_LENGTH` NQCHARs — else `null`. Total: read a
 * `DPoP-Nonce` header (`headers.get` answers `null` when absent, and joins two headers with
 * ", ", which is not a nonce) or a stored value with it, never by trusting the string.
 */
export function parseDpopNonce(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NONCE_LENGTH) {
    return null;
  }
  return NONCE.test(value) ? value : null;
}

/**
 * Where the latest nonce lives: memory and `storage.session` in the extension, so a
 * restarted worker does not pay a round trip for it. The nonce is not a secret (the server hands
 * the same one to every client in a bucket), and losing it costs one retry, never a play.
 *
 * `get` answers a nonce or `null` — an implementation over storage parses what it reads with
 * `parseDpopNonce`. `set` keeps `nonce` only when it parses; otherwise the previous one stays,
 * which is either still current or answered with a fresh one. Two answers arriving together
 * each store a current nonce, so the last write winning is safe.
 */
export interface NonceStore {
  get(): Promise<string | null>;
  set(nonce: string): Promise<void>;
}

/** A `NonceStore` in memory: for tests, and for code with no storage behind it. */
export function memoryNonceStore(): NonceStore {
  let current: string | null = null;
  return {
    get: () => Promise.resolve(current),
    set: (nonce) => {
      const parsed = parseDpopNonce(nonce);
      if (parsed !== null) current = parsed;
      return Promise.resolve();
    },
  };
}
