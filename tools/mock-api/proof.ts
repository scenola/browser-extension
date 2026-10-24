/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// DPoP proofs as the server checks them, in
// its order, cheapest refusal first: size, header (`typ`, `alg`, a public P-256 `jwk`), the key's
// thumbprint against the one the credential is bound to, the signature, `htm`, `htu`, `iat`, the
// nonce, `jti`, `ath`. Signatures are verified with `jose`.
//
// The expected `htu` is computed here, from the mock's own public base URL and the request's
// path, with a port of the server's `_normalized_url` (and of the `urllib.parse.urlsplit` it
// calls) — never with the extension's `dpopHtu`, which is the code under test.

import { isIPv4, isIPv6 } from 'node:net';

import { calculateJwkThumbprint, compactVerify, decodeProtectedHeader, importJWK } from 'jose';

import { s256 } from './state.ts';

/** `PROOF_MAX_BYTES`: a P-256 proof is about 600 bytes. */
export const PROOF_MAX_BYTES = 4096;

/** `JTI_PATTERN`, matched in full. */
const JTI = /^[A-Za-z0-9._~-]{8,128}$/;

/** `SHA256_B64URL_PATTERN`: a P-256 coordinate, 32 bytes in unpadded base64url. */
const COORDINATE = /^[A-Za-z0-9_-]{43}$/;

/** `DpopRejection`: every reason a proof is refused. Never sent: the wire says one thing. */
type DpopRejection =
  | 'malformed'
  | 'too_large'
  | 'wrong_typ'
  | 'wrong_alg'
  | 'bad_jwk'
  | 'wrong_key'
  | 'bad_signature'
  | 'wrong_htm'
  | 'wrong_htu'
  | 'missing_iat'
  | 'bad_jti'
  | 'wrong_ath';

export type ProofVerdict =
  | { readonly kind: 'ok'; readonly jkt: string; readonly jti: string }
  /** Right in every respect but its nonce, missing or stale (`DpopNonceRequired`). */
  | { readonly kind: 'nonce' }
  | { readonly kind: 'invalid'; readonly reason: DpopRejection };

export interface ProofCheck {
  /** The request's method. */
  readonly method: string;
  /** The URL the public sees: the mock's public base URL and the request's path (`public_url`). */
  readonly url: string;
  /** The credential presented (`ath` must hash it), or `null` at the token endpoint. */
  readonly credential: string | null;
  /** The thumbprint the credential is bound to, or `null` when the caller compares later. */
  readonly expectedJkt: string | null;
  readonly nonceIsCurrent: (nonce: string) => boolean;
}

const refuse = (reason: DpopRejection): ProofVerdict => ({ kind: 'invalid', reason });

/** Total over any string: hostile input is a refusal, never a throw. */
export async function verifyProof(proof: string, check: ProofCheck): Promise<ProofVerdict> {
  if (proof.length > PROOF_MAX_BYTES) return refuse('too_large');
  const signer = await signerOf(proof);
  if ('kind' in signer) return signer;
  const { key, jkt } = signer;
  if (check.expectedJkt !== null && jkt !== check.expectedJkt) return refuse('wrong_key');
  let payload: Uint8Array;
  try {
    ({ payload } = await compactVerify(proof, key, { algorithms: ['ES256'] }));
  } catch {
    return refuse('bad_signature');
  }
  const claims = claimsOf(payload);
  if (claims === null) return refuse('bad_signature');
  return claimsVerdict(claims, check, jkt);
}

/**
 * The key the proof's header names and its thumbprint, in `verify_proof`'s order: a readable
 * header, `typ`, `alg`, then a public P-256 key on the curve — or the refusal.
 */
async function signerOf(
  proof: string,
): Promise<
  { readonly key: Awaited<ReturnType<typeof importJWK>>; readonly jkt: string } | ProofVerdict
> {
  let header: Readonly<Record<string, unknown>>;
  try {
    header = decodeProtectedHeader(proof);
  } catch {
    return refuse('malformed');
  }
  // PyJWT's `get_unverified_header` refuses a `kid` that is not a string.
  if (Object.hasOwn(header, 'kid') && typeof header.kid !== 'string') return refuse('malformed');
  if (header.typ !== 'dpop+jwt') return refuse('wrong_typ');
  if (header.alg !== 'ES256') return refuse('wrong_alg');
  const jwk = publicJwk(header.jwk);
  if (jwk === null) return refuse('bad_jwk');
  try {
    // A point off the curve is refused here, as `public_jwk` refuses it.
    return {
      key: await importJWK(jwk, 'ES256'),
      jkt: await calculateJwkThumbprint(jwk, 'sha256'),
    };
  } catch {
    return refuse('bad_jwk');
  }
}

/** The signed claims judged in the server's order: `htm`, `htu`, `iat`, the nonce, `jti`, `ath`. */
function claimsVerdict(
  claims: Readonly<Record<string, unknown>>,
  check: ProofCheck,
  jkt: string,
): ProofVerdict {
  if (claims.htm !== check.method.toUpperCase()) return refuse('wrong_htm');
  const expected = normalizedUrl(check.url);
  const htu = claims.htu;
  if (typeof htu !== 'string' || expected === null || normalizedUrl(htu) !== expected) {
    return refuse('wrong_htu');
  }
  if (typeof claims.iat !== 'number') return refuse('missing_iat');
  const nonce = claims.nonce;
  if (typeof nonce !== 'string' || !check.nonceIsCurrent(nonce)) return { kind: 'nonce' };
  const jti = claims.jti;
  if (typeof jti !== 'string' || !JTI.test(jti)) return refuse('bad_jti');
  if (check.credential !== null) {
    const ath = claims.ath;
    if (typeof ath !== 'string' || ath !== s256(check.credential)) return refuse('wrong_ath');
  }
  return { kind: 'ok', jkt, jti };
}

interface PublicJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
}

/** `public_jwk`: the four members of a public EC P-256 key; a `d` is refused, never stripped. */
function publicJwk(value: unknown): PublicJwk | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const jwk = value as Readonly<Record<string, unknown>>;
  if (Object.hasOwn(jwk, 'd') || jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;
  const { x, y } = jwk;
  if (typeof x !== 'string' || typeof y !== 'string') return null;
  if (!COORDINATE.test(x) || !COORDINATE.test(y)) return null;
  return { kty: 'EC', crv: 'P-256', x, y };
}

/** The payload as a JSON object (PyJWT refuses any other payload), or `null`. */
function claimsOf(payload: Uint8Array): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    return null;
  }
}

// ── `_normalized_url`, over a port of `urllib.parse.urlsplit` (CPython 3.14) ─────────────────

/** `scheme_chars`. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*$/;
/** `_WHATWG_C0_CONTROL_OR_SPACE`, stripped from the start only. */
const LEADING_C0_OR_SPACE = /^[\x00-\x20]+/;
/** `_UNSAFE_URL_BYTES_TO_REMOVE`, removed everywhere. */
const UNSAFE = /[\t\r\n]/g;
/** `_check_bracketed_host`'s IPvFuture form. */
const IPV_FUTURE = /^v[a-fA-F0-9]+\..+$/;
const DIGITS = /^[0-9]+$/;
const DEFAULT_PORT: Readonly<Record<string, number>> = { http: 80, https: 443 };

/**
 * RFC 9449 §4.3's comparison as the server makes it: scheme and host lowercased, the default
 * port dropped, query and fragment removed, the path as written (never decoded, never resolved),
 * userinfo dropped. `null` where the server's `urlsplit` raises or the URL is not absolute.
 */
export function normalizedUrl(input: string): string | null {
  const parts = urlsplit(input);
  if (parts === null || parts.scheme === '') return null;
  const hostinfo = parts.netloc.slice(parts.netloc.lastIndexOf('@') + 1);
  let hostname: string;
  let port: string;
  const open = hostinfo.indexOf('[');
  if (open >= 0) {
    const bracketed = hostinfo.slice(open + 1);
    const close = bracketed.indexOf(']');
    hostname = close < 0 ? bracketed : bracketed.slice(0, close);
    const after = close < 0 ? '' : bracketed.slice(close + 1);
    const colon = after.indexOf(':');
    port = colon < 0 ? '' : after.slice(colon + 1);
  } else {
    const colon = hostinfo.indexOf(':');
    hostname = colon < 0 ? hostinfo : hostinfo.slice(0, colon);
    port = colon < 0 ? '' : hostinfo.slice(colon + 1);
  }
  if (hostname === '') return null;
  // `hostname` keeps an IPv6 zone's case, but `_normalized_url` lowercases it all again.
  let host = hostname.toLowerCase();
  let portNumber: number | null = null;
  if (port !== '') {
    if (!DIGITS.test(port)) return null;
    portNumber = Number.parseInt(port, 10);
    if (portNumber > 65535) return null;
  }
  if (host.includes(':')) host = `[${host}]`;
  const netloc =
    portNumber === null || portNumber === DEFAULT_PORT[parts.scheme]
      ? host
      : `${host}:${String(portNumber)}`;
  return `${parts.scheme}://${netloc}${parts.path === '' ? '/' : parts.path}`;
}

interface SplitResult {
  readonly scheme: string;
  readonly netloc: string;
  readonly path: string;
}

/** `urlsplit`'s scheme, netloc and path; `null` where it raises `ValueError`. */
function urlsplit(input: string): SplitResult | null {
  let url = input.replace(LEADING_C0_OR_SPACE, '').replace(UNSAFE, '');
  let scheme = '';
  const colon = url.indexOf(':');
  if (colon > 0 && SCHEME.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase();
    url = url.slice(colon + 1);
  }
  let netloc = '';
  if (url.startsWith('//')) {
    let end = url.length;
    for (const delimiter of ['/', '?', '#']) {
      const at = url.indexOf(delimiter, 2);
      if (at >= 0) end = Math.min(end, at);
    }
    netloc = url.slice(2, end);
    url = url.slice(end);
    const opens = netloc.includes('[');
    const closes = netloc.includes(']');
    if (opens !== closes) return null;
    if (opens && !bracketedNetlocIsValid(netloc)) return null;
  }
  const hash = url.indexOf('#');
  if (hash >= 0) url = url.slice(0, hash);
  const query = url.indexOf('?');
  if (query >= 0) url = url.slice(0, query);
  if (!netlocIsValid(netloc)) return null;
  return { scheme, netloc, path: url };
}

/** `_check_bracketed_netloc` and `_check_bracketed_host`. */
function bracketedNetlocIsValid(netloc: string): boolean {
  const hostAndPort = netloc.slice(netloc.lastIndexOf('@') + 1);
  const open = hostAndPort.indexOf('[');
  let hostname: string;
  if (open >= 0) {
    if (open > 0) return false;
    const bracketed = hostAndPort.slice(open + 1);
    const close = bracketed.indexOf(']');
    hostname = close < 0 ? bracketed : bracketed.slice(0, close);
    const after = close < 0 ? '' : bracketed.slice(close + 1);
    if (after !== '' && !after.startsWith(':')) return false;
  } else {
    const close = hostAndPort.indexOf(']');
    hostname = close < 0 ? hostAndPort : hostAndPort.slice(0, close);
  }
  if (hostname.startsWith('v')) return IPV_FUTURE.test(hostname);
  return isIPv6(hostname) && !isIPv4(hostname);
}

/** `_checknetloc`: a non-ASCII netloc whose NFKC form grows a delimiter is refused. */
function netlocIsValid(netloc: string): boolean {
  if (netloc === '' || /^[\x00-\x7f]*$/.test(netloc)) return true;
  const stripped = netloc.replace(/[@:#?]/g, '');
  const normalized = stripped.normalize('NFKC');
  if (stripped === normalized) return true;
  return !['/', '?', '#', '@', ':'].some((c) => normalized.includes(c));
}
