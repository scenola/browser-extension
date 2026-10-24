/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The DPoP key: ECDSA P-256, generated with `extractable: false`
// so no code — ours, a content script's, a debugger's console — can read the private half out.
// The `CryptoKeyPair` itself is stored in the extension origin's IndexedDB (structured clone
// keeps a key non-extractable). A credential that leaks without the key is useless; malware
// that copies the whole browser profile is out of reach of anything in a browser.

import { base64urlDecode } from './base64url';
import { s256 } from './digest';
import { ProtocolInputError } from './input-error';

/**
 * The public key as a proof's header carries it, and as RFC 7638 hashes it: the four members
 * of an EC P-256 public JWK, nothing more.
 */
export interface PublicJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
}

const KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;

/** A P-256 coordinate: 32 bytes, 43 unpadded base64url characters. */
const COORDINATE_BYTES = 32;
const COORDINATE = /^[A-Za-z0-9_-]{43}$/;

/**
 * A fresh DPoP key pair: ECDSA P-256, the private key `extractable: false` with the one usage
 * `sign` (WebCrypto makes the public half extractable, with no usage of its own). Refuses
 * (`bad_key`) a platform that answered anything else, rather than bind a credential to it.
 */
export async function generateDpopKey(): Promise<CryptoKeyPair> {
  const pair = await crypto.subtle.generateKey(KEY_ALGORITHM, false, ['sign']);
  if (!isDpopKeyPair(pair)) throw new ProtocolInputError('bad_key');
  return pair;
}

/**
 * Whether `value` is a DPoP key pair this package signs with: a non-extractable P-256 ECDSA
 * private key that may sign, and a P-256 ECDSA public key. Total over whatever storage holds:
 * plain data shaped like a key is not a `CryptoKey` and answers `false`.
 */
export function isDpopKeyPair(value: unknown): value is CryptoKeyPair {
  if (typeof value !== 'object' || value === null) return false;
  const { privateKey, publicKey } = value as Partial<Record<'privateKey' | 'publicKey', unknown>>;
  return isSigningKey(privateKey) && isPublicKey(publicKey);
}

/**
 * The pair's public key as a `PublicJwk`. Refuses (`bad_key`) a public key that is not P-256
 * ECDSA or does not export as one.
 */
export async function publicJwk(pair: CryptoKeyPair): Promise<PublicJwk> {
  if (!isPublicKey(pair.publicKey)) throw new ProtocolInputError('bad_key');
  let exported: unknown;
  try {
    exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  } catch {
    throw new ProtocolInputError('bad_key');
  }
  const jwk = readPublicJwk(exported);
  if (jwk === null) throw new ProtocolInputError('bad_key');
  return jwk;
}

/**
 * `value` as a `PublicJwk` when it is a public EC P-256 JWK whose coordinates are canonical
 * 32-byte base64url, else `null`. Members RFC 7638 does not hash (`ext`, `key_ops`, `kid`…)
 * are dropped; a `d` member is a private key and is refused, never stripped (the server's own
 * rule). Total over whatever storage holds.
 */
export function readPublicJwk(value: unknown): PublicJwk | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const jwk = value as Readonly<Record<string, unknown>>;
  if ('d' in jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;
  const { x, y } = jwk;
  if (!isCoordinate(x) || !isCoordinate(y)) return null;
  return { kty: 'EC', crv: 'P-256', x, y };
}

/**
 * RFC 7638: `BASE64URL(SHA-256(UTF-8(JSON)))` of the required members in lexicographic order
 * with no whitespace — for EC, `{"crv":…,"kty":…,"x":…,"y":…}`. This is the `dpop_jkt` the
 * approval carries, which binds the connection to the key. Refuses (`bad_jwk`) a JWK that
 * `readPublicJwk` does not read.
 */
export async function jwkThumbprint(jwk: PublicJwk): Promise<string> {
  const checked = readPublicJwk(jwk);
  if (checked === null) throw new ProtocolInputError('bad_jwk');
  // Spelled out, not left to JSON.stringify's key order; the coordinates are base64url, so
  // nothing in them needs escaping.
  return s256(`{"crv":"P-256","kty":"EC","x":"${checked.x}","y":"${checked.y}"}`);
}

/** A key this package will sign a proof with: non-extractable P-256 ECDSA, usage `sign`. */
function isSigningKey(key: unknown): key is CryptoKey {
  return (
    key instanceof CryptoKey &&
    key.type === 'private' &&
    !key.extractable &&
    key.usages.includes('sign') &&
    isP256Ecdsa(key.algorithm)
  );
}

function isPublicKey(key: unknown): key is CryptoKey {
  return key instanceof CryptoKey && key.type === 'public' && isP256Ecdsa(key.algorithm);
}

function isP256Ecdsa(algorithm: KeyAlgorithm): boolean {
  return (
    algorithm.name === KEY_ALGORITHM.name &&
    'namedCurve' in algorithm &&
    algorithm.namedCurve === KEY_ALGORITHM.namedCurve
  );
}

function isCoordinate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    COORDINATE.test(value) &&
    base64urlDecode(value)?.length === COORDINATE_BYTES
  );
}
