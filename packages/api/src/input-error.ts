/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Why this package refused to build what it was asked for. Each reason is an input
 * the server would refuse, or a key that cannot do what a DPoP key must — a bug or broken
 * storage, never a server answer.
 *
 * Refusing here is the cheap failure. A proof the server refuses on a resource route answers
 * `401 scrobbling.credential_invalid` (one answer for every reason, on purpose), and that
 * answer sends the person to reconnect — a new connection, counted against their ten.
 */
export type ProtocolFault =
  /** The random source did not answer the bytes asked for, or answered the same bytes twice. */
  | 'bad_random'
  /** Not an RFC 7636 §4.1 code verifier: 43–128 unreserved characters. */
  | 'bad_verifier'
  /** Not a non-extractable ECDSA P-256 signing key, or not the key the JWK names. */
  | 'bad_key'
  /** Not a public EC P-256 JWK with two canonical 32-byte coordinates (a `d` is refused). */
  | 'bad_jwk'
  /** Not 1–16 ASCII letters. */
  | 'bad_method'
  /** Not an absolute http(s) URL whose host and path the server spells as the browser does. */
  | 'bad_url'
  /** Not what the server takes as a `jti`: 8–128 of `A–Z a–z 0–9 . _ ~ -`. */
  | 'bad_jti'
  /** Not an RFC 9110 token68 of at most 1024 characters. */
  | 'bad_access_token'
  /** Not a finite, non-negative epoch-milliseconds instant within the Date range. */
  | 'bad_time';

/**
 * A refusal with its reason. The message is the reason alone — never the URL, the token, the
 * nonce or the key it was given, so it can reach a log or a diagnostic as it is.
 */
export class ProtocolInputError extends Error {
  readonly reason: ProtocolFault;

  constructor(reason: ProtocolFault) {
    super(reason);
    this.name = 'ProtocolInputError';
    this.reason = reason;
  }
}
