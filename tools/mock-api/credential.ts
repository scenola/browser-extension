/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The credential and the keys of a request: which connection a credential names, its DPoP proof
// checked; the failure budget of an address; the idempotency key and the scope it is kept under.

import {
  FAILURES_PER_MINUTE,
  credentialInvalid,
  doorNonceRequired,
  rateLimited,
} from './answers.ts';
import type { Answer, Ctx, Exchange, FailureBucket } from './answers.ts';
import { firstHeader } from './http.ts';
import { verifyProof } from './proof.ts';
import { credentialKind, sha256Hex } from './state.ts';
import type { Connection } from './state.ts';

type Authenticated =
  | { readonly kind: 'ok'; readonly connection: Connection }
  | { readonly kind: 'refused'; readonly answer: Answer };

/**
 * The connection the request's credential names, its DPoP proof checked: one `401
 * credential_invalid` for every failure (counted against the address, `429` past its budget),
 * `401 dpop_nonce_required` for a proof right in all but its nonce (not counted). A personal
 * token (`Bearer mts_pat_…`) would resolve here; the mock mints none, so every one is unknown.
 */
export async function authenticate(
  x: Exchange,
  ctx: Ctx,
  bucket: FailureBucket,
): Promise<Authenticated> {
  const presented = parseAuthorization(firstHeader(x.req, 'authorization'));
  let connection: Connection | null = null;
  if (presented !== null) {
    const [scheme, credential] = presented;
    // An extension's credential is DPoP-bound: as a bearer it is refused, like a webhook's.
    if (scheme === 'dpop' && credentialKind(credential) === 'extension') {
      connection = ctx.state.connectionOf(credential);
      if (connection !== null) {
        const bound = await boundToItsKey(x, ctx, connection, credential);
        if (bound === 'nonce') return { kind: 'refused', answer: doorNonceRequired(x, ctx) };
        if (!bound) connection = null;
      }
    }
  }
  if (connection === null) {
    return { kind: 'refused', answer: countFailure(x, ctx, bucket) ?? credentialInvalid(x, ctx) };
  }
  return { kind: 'ok', connection };
}

/** `_bound_to_its_key`: the key, the proof, the nonce, `ath`, then the `jti` made single use. */
async function boundToItsKey(
  x: Exchange,
  ctx: Ctx,
  connection: Connection,
  credential: string,
): Promise<boolean | 'nonce'> {
  const proofs = x.req.headersDistinct.dpop ?? [];
  const proof = proofs[0];
  if (proofs.length !== 1 || proof === undefined) return false;
  const now = ctx.state.now();
  const verdict = await verifyProof(proof, {
    method: x.req.method ?? '',
    url: `${ctx.publicUrl}${x.path}`,
    credential,
    expectedJkt: connection.jkt,
    nonceIsCurrent: (nonce) => ctx.state.nonces.isCurrent(nonce, now),
  });
  if (verdict.kind === 'nonce') return 'nonce';
  if (verdict.kind === 'invalid') return false;
  if (!ctx.state.recordJti(connection, verdict.jti)) return false;
  x.offeredNonce = ctx.state.nonces.issue(now);
  return true;
}

/** `count_auth_failure`: `null` within the address's budget, else the `429` replacing the refusal. */
export function countFailure(x: Exchange, ctx: Ctx, bucket: FailureBucket): Answer | null {
  const key = `${x.req.socket.remoteAddress ?? 'anon'}\n${bucket}`;
  const verdict = ctx.state.failures.admit(key, FAILURES_PER_MINUTE, ctx.state.now());
  if (verdict.allowed) return null;
  return rateLimited(FAILURES_PER_MINUTE, verdict.retryAfterSeconds, verdict.count)(x, ctx);
}

/** `parse_authorization`: `(scheme lowercased, credential)` or `null`. */
function parseAuthorization(value: string | undefined): readonly [string, string] | null {
  const text = (value ?? '').trim();
  const space = text.indexOf(' ');
  if (space < 0) return null;
  const credential = text.slice(space + 1).trim();
  if (credential === '') return null;
  return [text.slice(0, space).toLowerCase(), credential];
}

/** `_scope_for`: a recognised `mts_` credential by its hash, another bearer by itself, else by IP. */
export function scopeOf(x: Exchange): string {
  const presented = parseAuthorization(firstHeader(x.req, 'authorization'));
  const client = `ip:${x.req.socket.remoteAddress ?? 'anon'}`;
  if (presented === null) return client;
  const [scheme, token] = presented;
  if ((scheme === 'bearer' || scheme === 'dpop') && token.startsWith('mts_')) {
    return credentialKind(token) === null ? client : `c:${sha256Hex(token)}`;
  }
  // A session token: the server scopes it by its verified user; the mock has no users.
  return scheme === 'bearer' ? `u:${sha256Hex(token)}` : client;
}

type Key = { readonly raw: string; readonly canonical: string } | 'missing' | 'malformed';

/** `Idempotency-Key`, stripped, and its canonical UUID (`uuid.UUID(key)`). */
export function keyOf(x: Exchange): Key {
  const raw = (firstHeader(x.req, 'idempotency-key') ?? '').trim();
  if (raw === '') return 'missing';
  const canonical = canonicalUuid(raw);
  return canonical === null ? 'malformed' : { raw, canonical };
}

/**
 * What `uuid.UUID(hex)` accepts, as far as is safe: `urn:` and `uuid:` dropped, braces stripped
 * from the ends, hyphens dropped, then exactly 32 hex digits (Python's `int()` would also take a
 * sign, an `0x` or an underscore there; the mock does not).
 */
function canonicalUuid(text: string): string | null {
  if (text.length > 64) return null;
  const hex = text
    .replaceAll('urn:', '')
    .replaceAll('uuid:', '')
    .replace(/^[{}]+/, '')
    .replace(/[{}]+$/, '')
    .replaceAll('-', '')
    .toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  const parts = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20)];
  return `${parts.join('-')}-${hex.slice(20)}`;
}
