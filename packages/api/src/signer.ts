/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// How a request presents the connection's credential: with a DPoP
// proof by the connection's key (the store build), or as a bearer personal token (self-builds).
// A signer reads no answer's body; it sees every answer's headers, to keep the server's nonce.

import type { EpochMs } from '@mt/core';

import { createDpopProof, isAccessToken } from './dpop';
import { ProtocolInputError } from './input-error';
import type { PublicJwk } from './keys';
import { parseDpopNonce } from './nonce';
import type { NonceStore } from './nonce';

export interface RequestSigner {
  /**
   * The headers that authenticate one request to `url` — a fresh proof on every call, so a
   * retry is never a replayed `jti`. `nonce` is the one an answer just handed over, for the
   * retry it asked for: the proof carries it whatever the store holds, so a store that could
   * not keep it costs nothing. Without it, the latest stored nonce (or none). A signer with no
   * proof ignores it. Rejects with `ProtocolInputError` when the credential or the key cannot
   * make one (its `reason` says which), before anything is sent.
   */
  headers(method: string, url: string, nonce?: string): Promise<Record<string, string>>;
  /** Sees every answer's headers, success or refusal: keeps a `DPoP-Nonce` it carries. */
  onAnswer(headers: Headers): Promise<void>;
}

export interface DpopSignerDeps {
  /** The connection's key pair (`generateDpopKey`), as storage holds it. */
  readonly pair: CryptoKeyPair;
  /** Its public JWK, as storage holds it; checked to be the pair's own key at every proof. */
  readonly jwk: PublicJwk;
  /** The `mts_ext_…` credential the key is bound to. */
  readonly accessToken: string;
  readonly nonces: NonceStore;
  readonly now: () => EpochMs;
  /** A fresh proof id for every call (`uuidv7` from `@mt/core`). */
  readonly jti: () => string;
}

/**
 * `Authorization: DPoP <token>` with `DPoP: <proof>` — `htm`/`htu` the request's, `ath` the
 * token's, the nonce handed over for this retry or else the latest stored one, a fresh `jti`
 * and `iat` — and every answer's `DPoP-Nonce` kept. The proof is made first: a token or a key
 * it refuses never reaches a header.
 */
export function dpopSigner(deps: DpopSignerDeps): RequestSigner {
  return {
    async headers(method, url, nonce) {
      // Checked here as well as in the proof: a `null` from storage would make a proof with
      // no `ath`, as at the token endpoint, and a header reading "DPoP null".
      if (!isAccessToken(deps.accessToken)) throw new ProtocolInputError('bad_access_token');
      const proof = await createDpopProof({
        pair: deps.pair,
        jwk: deps.jwk,
        method,
        url,
        nonce: nonce ?? (await storedNonce(deps.nonces)),
        accessToken: deps.accessToken,
        now: deps.now(),
        jti: deps.jti(),
      });
      return { Authorization: `DPoP ${deps.accessToken}`, DPoP: proof };
    },
    onAnswer: (headers) => keepNonce(deps.nonces, headers),
  };
}

/**
 * `Authorization: Bearer <token>` for a personal token (self-builds only); no proof,
 * no nonce (one handed over is ignored). Refuses (`bad_access_token`) a token that cannot be
 * presented in a header.
 */
export function bearerSigner(token: string): RequestSigner {
  return {
    headers: () =>
      isAccessToken(token)
        ? Promise.resolve({ Authorization: `Bearer ${token}` })
        : Promise.reject(new ProtocolInputError('bad_access_token')),
    onAnswer: () => Promise.resolve(),
  };
}

// The nonce is not a secret and losing it costs one retry, never a play or a credential
// (`nonce.ts`): a store that cannot answer is no nonce, and one that cannot keep one is a
// nonce lost — neither turns an answer into a fault.

/** The stored nonce, or `null` when there is none or the store cannot answer. */
export async function storedNonce(nonces: NonceStore): Promise<string | null> {
  try {
    return await nonces.get();
  } catch {
    return null;
  }
}

/**
 * Keeps the answer's `DPoP-Nonce` when it is one (`parseDpopNonce`: two headers joined by
 * `Headers.get` are not). Never rejects. The token exchange keeps its answers' nonces through
 * this too.
 */
export async function keepNonce(nonces: NonceStore, headers: Headers): Promise<void> {
  const nonce = parseDpopNonce(headers.get('DPoP-Nonce'));
  if (nonce === null) return;
  try {
    await nonces.set(nonce);
  } catch {
    // Lost: the next request pays one nonce retry.
  }
}
