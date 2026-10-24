/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// DPoP proofs (RFC 9449 §4), made to be what the server's proof verifier
// accepts:
//
//   header  {typ: "dpop+jwt", alg: "ES256", jwk: {kty, crv, x, y}}
//   payload {jti, htm, htu, iat, nonce?, ath?}
//
// signed by the pair's private key with WebCrypto, whose ECDSA signature is already JWS's
// r‖s (64 bytes) — no DER conversion.
//
// On a resource route the server answers every refused proof the same way, `401
// scrobbling.credential_invalid`, and that answer sends the person to reconnect — a new
// connection, counted against their ten. So every input the server checks is checked here
// first, and an input it would refuse is refused here (`ProtocolInputError`), before anything
// is signed or sent. The one exception is the nonce: it is the server's, so a value that is not
// a nonce is left out, and the server answers with a fresh one.

import { MAX_DATE_MS } from '@mt/core';
import type { EpochMs } from '@mt/core';

import { base64urlEncode } from './base64url';
import { s256 } from './digest';
import { ProtocolInputError } from './input-error';
import type { PublicJwk } from './keys';
import { isDpopKeyPair, publicJwk, readPublicJwk } from './keys';
import { parseDpopNonce } from './nonce';

/**
 * The longest request URL a proof is made for. With the other inputs' bounds it keeps every
 * proof inside the server's `PROOF_MAX_BYTES` (4096), which a test pins at every maximum.
 */
const MAX_URL_LENGTH = 2048;

/** An HTTP method as this package spells one: ASCII letters (RFC 9110's token, narrowed). */
const METHOD = /^[A-Za-z]{1,16}$/;

/** What the server takes as a `jti`: anything else is refused before the proof is read. */
const JTI = /^[A-Za-z0-9._~-]{8,128}$/;

/** RFC 9110 §11.2 token68, the syntax of a DPoP access token (RFC 9449 §7.1). */
const TOKEN68 = /^[A-Za-z0-9._~+/-]+=*$/;
const MAX_ACCESS_TOKEN_LENGTH = 1024;

/** Visible ASCII, no space: an API URL is written in nothing else. */
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

/** `scheme://authority`, the authority as written (before the browser rewrites any of it). */
const AUTHORITY = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/;

/** What a proof is made from. */
export interface DpopProofInput {
  /** The connection's key pair (`generateDpopKey`): non-extractable P-256 ECDSA. */
  readonly pair: CryptoKeyPair;
  /** The pair's public key (`publicJwk`); checked to be that key before anything is signed. */
  readonly jwk: PublicJwk;
  /** The request's method, as passed to `fetch`; sent upper-case, as the server compares it. */
  readonly method: string;
  /** The request's URL, as passed to `fetch`: the configured public API base URL + path. */
  readonly url: string;
  /** The latest nonce from the server, or `null` when none has been handed over yet. */
  readonly nonce: string | null;
  /** The credential the request presents, or `null` at the token endpoint (no `ath`). */
  readonly accessToken: string | null;
  /** When the proof is made; `iat` is this in whole seconds. The server never compares it. */
  readonly now: EpochMs;
  /**
   * The proof's identifier: fresh for every proof, a retry and a nonce retry included — the
   * server keeps each `jti` for 10 minutes and refuses a second use (on a resource route, as
   * `credential_invalid`). A UUID (v4 or v7: `uuidv7` from `@mt/core`) or 96+ random bits in
   * base64url; it must match `[A-Za-z0-9._~-]{8,128}`.
   */
  readonly jti: string;
}

/**
 * A DPoP proof for one request, as a compact JWS. Rejects with `ProtocolInputError` — its
 * `reason` and nothing it was given — when an input is one the server would refuse
 * (`bad_url`, `bad_method`, `bad_jti`, `bad_access_token`, `bad_time`, `bad_jwk`), or when
 * the key is not a DPoP key or not the key `jwk` names (`bad_key`). A `nonce` that is not one
 * (`parseDpopNonce`) is left out of the proof.
 */
export async function createDpopProof(input: DpopProofInput): Promise<string> {
  if (!METHOD.test(input.method)) throw new ProtocolInputError('bad_method');
  const htu = dpopHtu(input.url);
  if (htu === null) throw new ProtocolInputError('bad_url');
  if (!JTI.test(input.jti)) throw new ProtocolInputError('bad_jti');
  const { now, accessToken } = input;
  if (!(Number.isFinite(now) && now >= 0 && now <= MAX_DATE_MS)) {
    throw new ProtocolInputError('bad_time');
  }
  if (accessToken !== null && !isAccessToken(accessToken)) {
    throw new ProtocolInputError('bad_access_token');
  }
  const jwk = readPublicJwk(input.jwk);
  if (jwk === null) throw new ProtocolInputError('bad_jwk');
  const pair: unknown = input.pair;
  if (!isDpopKeyPair(pair)) throw new ProtocolInputError('bad_key');
  // The header must name the key that signs: a stored JWK that drifted from its pair would be
  // a proof the server refuses, so compare it with the pair's own public half.
  const own = await publicJwk(pair);
  if (own.x !== jwk.x || own.y !== jwk.y) throw new ProtocolInputError('bad_key');

  const nonce = input.nonce === null ? null : parseDpopNonce(input.nonce);
  const header = {
    typ: 'dpop+jwt',
    alg: 'ES256',
    jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
  };
  const payload: Record<string, string | number> = {
    jti: input.jti,
    htm: input.method.toUpperCase(),
    htu,
    iat: Math.floor(now / 1000),
  };
  if (nonce !== null) payload.nonce = nonce;
  if (accessToken !== null) payload.ath = await s256(accessToken);

  const signingInput = `${segment(header)}.${segment(payload)}`;
  let signature: Uint8Array;
  try {
    signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        new TextEncoder().encode(signingInput),
      ),
    );
  } catch {
    throw new ProtocolInputError('bad_key');
  }
  if (signature.length !== 64) throw new ProtocolInputError('bad_key');
  return `${signingInput}.${base64urlEncode(signature)}`;
}

/**
 * Whether `value` can be presented as a credential — `Authorization: DPoP <value>` or `Bearer
 * <value>`: an RFC 9110 token68 of at most 1024 characters. Total over what storage or an
 * answer holds.
 */
export function isAccessToken(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= MAX_ACCESS_TOKEN_LENGTH && TOKEN68.test(value)
  );
}

/**
 * The `htu` for a request to `url`: `scheme://host[:port]/path`, without query and fragment
 * (RFC 9449 §4.2) — or `null` when the server would not rebuild the same string from its
 * public base URL and the request's path, so no proof for it could verify.
 *
 * The server lowercases scheme and host, drops the default port and compares the path as the
 * request carried it, percent-decoded. The browser's URL parser (whose serialisation `fetch`
 * sends) agrees with that for a URL written plainly, and rewrites the rest. So a URL is refused
 * when it is not visible ASCII, carries userinfo, is not absolute `http`/`https`, names a host
 * the parser would rewrite beyond lowercasing (an internationalised name, an IPv6 address not in
 * its compressed form, a short or hexadecimal IPv4 address, a percent-encoded host), or has a
 * `%` in its path once parsed. Dot segments are resolved, as `fetch` resolves them.
 */
export function dpopHtu(url: string): string | null {
  if (url.length > MAX_URL_LENGTH || !VISIBLE_ASCII.test(url)) return null;
  const authority = AUTHORITY.exec(url)?.[1];
  if (authority === undefined || authority.includes('@')) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (hostAsWritten(authority).toLowerCase() !== parsed.hostname) return null;
  if (parsed.pathname.includes('%')) return null;
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

/** The host of an authority without userinfo: up to `]` for an IPv6 literal, else to `:`. */
function hostAsWritten(authority: string): string {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    return end < 0 ? authority : authority.slice(0, end + 1);
  }
  const colon = authority.indexOf(':');
  return colon < 0 ? authority : authority.slice(0, colon);
}

function segment(value: unknown): string {
  return base64urlEncode(new TextEncoder().encode(JSON.stringify(value)));
}
