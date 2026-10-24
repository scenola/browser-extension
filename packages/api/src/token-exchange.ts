/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The token exchange: `POST /v1/integrations/oauth/token`, the
// PKCE code traded — form-encoded, with a DPoP proof and no `Idempotency-Key` (the route is
// exempt; the code is single use) — for the DPoP-bound credential, shown once.
//
// The code is single use and lives 60 seconds, so nothing here is retried except the one
// thing RFC 9449 §8 asks: a `400` with `details.error = use_dpop_nonce` is answered once, with
// a new proof carrying the nonce that answer handed over. Every other answer is final, and
// becomes what the person is told.

import type { ConnectResult, EpochMs } from '@mt/core';

import { createDpopProof, isAccessToken } from './dpop';
import {
  REQUEST_TIMEOUT_MS,
  apiUrl,
  asksForNonce,
  errorCode,
  handedNonce,
  member,
  noAnswer,
  request,
} from './http';
import type { HttpAnswer } from './http';
import { ProtocolInputError } from './input-error';
import type { ProtocolFault } from './input-error';
import type { PublicJwk } from './keys';
import type { NonceStore } from './nonce';
import { isCodeVerifier } from './pkce';
import { keepNonce, storedNonce } from './signer';

const TOKEN_PATH = '/v1/integrations/oauth/token';

/**
 * The server's `_CODE_MAX_LENGTH`: "a code we mint is 43 characters; anything longer was never
 * ours".
 */
const MAX_CODE_LENGTH = 128;

/** A credential lives at most a year from its sign-in, whatever `expires_in` says. */
const MAX_EXPIRES_IN_SECONDS = 365 * 24 * 3600;

/**
 * The local refusals that mean this key cannot make a proof: the connection must be made again
 * with a fresh key (`proof_invalid`). Every other `ProtocolInputError` is a bug in a caller.
 */
const BROKEN_KEY: ReadonlySet<ProtocolFault> = new Set(['bad_key', 'bad_jwk']);

export interface ExchangeDeps {
  readonly fetch: typeof fetch;
  /** The configured public API base URL; `htu` is built from it, never from an answer. */
  readonly apiBase: string;
  readonly pair: CryptoKeyPair;
  readonly jwk: PublicJwk;
  readonly nonces: NonceStore;
  readonly now: () => EpochMs;
  /** A fresh proof id for every proof, the nonce retry's included. */
  readonly jti: () => string;
}

export interface ExchangeInput {
  /** The code the approval redirected back with. */
  readonly code: string;
  /** The PKCE verifier the approval's challenge was made from. */
  readonly verifier: string;
  /** The redirect URI the approval was opened with. */
  readonly redirectUri: string;
}

export type ExchangeResult =
  | { readonly kind: 'token'; readonly accessToken: string; readonly expiresIn: number }
  | Exclude<ConnectResult, { kind: 'connected' }>;

/**
 * Trades the code for the credential. Total over the server's answers: `200` with a
 * credential this extension can present → `token`; `authorization_code_invalid` →
 * `code_invalid`; `dpop_proof_invalid` → `proof_invalid`; `403` in the server's envelope →
 * `forbidden` (a `403` without it, from a proxy or a WAF, → `unavailable`); `409
 * scrobbler_limit_reached` → `limit_reached`; `404` in the envelope → `feature_closed` (one
 * without it → `unavailable`); a `5xx`, a `429`, a
 * network failure or the timeout → `unavailable`; any other refusal in the server's envelope
 * (`4xx` with a machine `code`) → `code_invalid`, since the same request would be refused again
 * and the person starts over; a `4xx` without the envelope — no refusal of the server's — →
 * `unavailable`.
 *
 * Rejects with `ProtocolInputError` for a bug, before anything is sent: a verifier that is not
 * one (`bad_verifier`), or a proof input the server would refuse (`bad_url`, `bad_jti`,
 * `bad_time`, `bad_method`). A key that cannot sign (`bad_key`, `bad_jwk`) is `proof_invalid`.
 */
export async function exchangeCode(
  deps: ExchangeDeps,
  input: ExchangeInput,
): Promise<ExchangeResult> {
  if (!isCodeVerifier(input.verifier)) throw new ProtocolInputError('bad_verifier');
  // The code arrived in a redirect URL: whatever it is, one the server could not have minted
  // is answered without asking it (its form would be a 422).
  const code: unknown = input.code;
  if (typeof code !== 'string' || code.length === 0 || code.length > MAX_CODE_LENGTH) {
    return { kind: 'code_invalid' };
  }
  const url = apiUrl(deps.apiBase, TOKEN_PATH);
  const form = new URLSearchParams([
    ['grant_type', 'authorization_code'],
    ['code', code],
    ['code_verifier', input.verifier],
    ['redirect_uri', input.redirectUri],
  ]).toString();

  const first = await attempt(deps, url, form, await storedNonce(deps.nonces));
  if (first === null) return { kind: 'proof_invalid' };
  // The answer asked for a nonce (`400 use_dpop_nonce`) and handed it over.
  const nonce = handedNonce(first, 400);
  if (nonce === null) return tokenResult(first);
  const second = await attempt(deps, url, form, nonce);
  if (second === null) return { kind: 'proof_invalid' };
  return tokenResult(second);
}

/** One request with a new proof; `null` when the key cannot make one. Keeps the answer's nonce. */
async function attempt(
  deps: ExchangeDeps,
  url: string,
  form: string,
  nonce: string | null,
): Promise<HttpAnswer | null> {
  let proof: string;
  try {
    proof = await createDpopProof({
      pair: deps.pair,
      jwk: deps.jwk,
      method: 'POST',
      url,
      nonce,
      accessToken: null,
      now: deps.now(),
      jti: deps.jti(),
    });
  } catch (error: unknown) {
    if (error instanceof ProtocolInputError && BROKEN_KEY.has(error.reason)) return null;
    throw error;
  }
  const answer = await request({
    fetch: deps.fetch,
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: proof },
    body: form,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  // Never rejects: a nonce that could not be kept never loses this answer, which may be a
  // credential shown once.
  if (answer.kind === 'response') await keepNonce(deps.nonces, answer.headers);
  return answer;
}

/**
 * What the token endpoint's answer means. An `unavailable` says why in `detail` (`timeout`,
 * `network:TypeError`, `nonce_refused`, `http_<status>`, `http_200_unreadable`), for the
 * diagnostics log only.
 */
function tokenResult(answer: HttpAnswer): ExchangeResult {
  if (answer.kind !== 'response') return unavailable(noAnswer(answer));
  const { status, json } = answer;
  if (status === 200) return readToken(json) ?? unavailable('http_200_unreadable');
  if (status >= 400 && status < 500) return refusalOf(status, json);
  return unavailable(`http_${String(status)}`);
}

/** What a `4xx` from the token endpoint means. */
function refusalOf(status: number, json: unknown): ExchangeResult {
  const code = errorCode(json);
  const atStatus = unavailable(`http_${String(status)}`);
  switch (status) {
    case 400:
      return badRequestOf(code, json) ?? finalRefusal(code, atStatus);
    // The server's `403` (Plus ended, the approving session signed out) is in its envelope; one
    // without it is a proxy's or a WAF's, which says nothing about the account: try again.
    case 403:
      return code === null ? atStatus : { kind: 'forbidden' };
    // The same for a `404`: the server's (the feature closed) is enveloped; a proxy's is not.
    case 404:
      return code === null ? atStatus : { kind: 'feature_closed' };
    case 409:
      return code === 'scrobbling.scrobbler_limit_reached'
        ? { kind: 'limit_reached' }
        : finalRefusal(code, atStatus);
    // A 429 (the failure bucket) and a 408 refuse nothing about the code: try again later.
    case 408:
    case 429:
      return atStatus;
    default:
      return finalRefusal(code, atStatus);
  }
}

/** A `400` the server explains: the code or the proof refused, or a nonce asked for. */
function badRequestOf(code: string | null, json: unknown): ExchangeResult | null {
  if (code === 'scrobbling.authorization_code_invalid') return { kind: 'code_invalid' };
  if (code === 'scrobbling.dpop_proof_invalid') return { kind: 'proof_invalid' };
  // Asked for a nonce a second time, or without one to use: nothing was spent; try again.
  if (asksForNonce(json)) return unavailable('nonce_refused');
  return null;
}

/**
 * Only the server's own refusal is final. It answers every one in its envelope — an OAuth
 * error rides in its `details.error` (`TokenDpopNonceRequired`), never in a bare body of its
 * own — so a 4xx without one came from something in between (a proxy, a WAF, a base that
 * routes elsewhere) and refused nothing about the code: try again.
 */
function finalRefusal(code: string | null, atStatus: ExchangeResult): ExchangeResult {
  return code === null ? atStatus : { kind: 'code_invalid' };
}

function unavailable(detail: string): ExchangeResult {
  return { kind: 'unavailable', detail };
}

/**
 * The credential, when the body is one this extension can store and present: a token68
 * `access_token`, `token_type` DPoP (RFC 6749 §5.1: case-insensitive) and a non-negative
 * `expires_in`, in whole seconds and at most a year. Anything else is no answer.
 */
function readToken(json: unknown): ExchangeResult | null {
  const accessToken = member(json, 'access_token');
  const tokenType = member(json, 'token_type');
  const expiresIn = member(json, 'expires_in');
  if (!isAccessToken(accessToken)) return null;
  if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'dpop') return null;
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn < 0) return null;
  return {
    kind: 'token',
    accessToken,
    expiresIn: Math.min(Math.floor(expiresIn), MAX_EXPIRES_IN_SECONDS),
  };
}
