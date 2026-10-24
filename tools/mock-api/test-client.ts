/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The client side of the mock's tests: a mock per test, and a sign-in made with the
// extension's own protocol functions, so every test talks to the mock as the extension does.

import { afterEach, expect } from 'vitest';

import {
  buildApprovalUrl,
  createPkce,
  createPlaysGateway,
  dpopSigner,
  errorCode,
  exchangeCode,
  generateDpopKey,
  jwkThumbprint,
  memoryNonceStore,
  publicJwk,
  randomBytes,
} from '../../packages/api/src/index';
import type { NonceStore, PublicJwk } from '../../packages/api/src/index';
import { uuidv7 } from '../../packages/core/src/index';
import type { ViewingBody } from '../../packages/core/src/index';

import { startMockApi } from './server.ts';
import type { MockApi, MockApiOptions } from './server.ts';

export const T0 = Date.parse('2026-10-21T12:00:00.000Z');
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const DAY = 24 * 60 * MINUTE;
export const REDIRECT = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/';
export const MT_ID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;

/** Starts a mock on the test clock for one test, and closes it when the test ends. */
export function useMockApi(): (options?: Partial<MockApiOptions>) => Promise<MockApi> {
  let api: MockApi | null = null;
  afterEach(async () => {
    await api?.close();
    api = null;
  });
  return async (options = {}) => {
    api = await startMockApi({ port: 0, now: T0, ...options });
    return api;
  };
}

export const newKey = (): string => uuidv7(Date.now(), randomBytes);

/** A `fetch` that records each answer's status, error code and nonce; called unbound. */
function watchedFetch() {
  const seen: { status: number; code: string | null; nonce: string | null }[] = [];
  const watched: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    let code: string | null = null;
    try {
      code = errorCode(await response.clone().json());
    } catch {
      code = null;
    }
    seen.push({ status: response.status, code, nonce: response.headers.get('DPoP-Nonce') });
    return response;
  };
  return { fetch: watched, seen };
}

/** The DOM's `CryptoKeyPair`, which this Node-typed project names through the API's own key. */
export type KeyPair = Awaited<ReturnType<typeof generateDpopKey>>;

export interface Approved {
  readonly code: string;
  readonly verifier: string;
  readonly pair: KeyPair;
  readonly jwk: PublicJwk;
}

/** The approval as `TestAuth` performs it: the approval URL's query, posted to the mock. */
export async function approve(mock: MockApi, keys?: { pair: KeyPair; jwk: PublicJwk }) {
  const pair = keys?.pair ?? (await generateDpopKey());
  const jwk = keys?.jwk ?? (await publicJwk(pair));
  const pkce = await createPkce(randomBytes);
  const url = new URL(
    buildApprovalUrl(mock.url, {
      redirectUri: REDIRECT,
      challenge: pkce.challenge,
      jkt: await jwkThumbprint(jwk),
      state: pkce.state,
    }),
  );
  const q = url.searchParams;
  const response = await fetch(`${mock.url}/__test/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': newKey() },
    body: JSON.stringify({
      client: q.get('client'),
      redirect_uri: q.get('redirect_uri'),
      code_challenge: q.get('code_challenge'),
      code_challenge_method: q.get('code_challenge_method'),
      dpop_jkt: q.get('dpop_jkt'),
      state: q.get('state'),
      display_name: 'Test browser',
    }),
  });
  expect(response.status).toBe(200);
  const { redirect_to } = (await response.json()) as { redirect_to: string };
  const back = new URL(redirect_to);
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
  expect(back.searchParams.get('state')).toBe(pkce.state);
  const code = back.searchParams.get('code') ?? '';
  return { code, verifier: pkce.verifier, pair, jwk } satisfies Approved;
}

export interface Connected {
  readonly gateway: ReturnType<typeof createPlaysGateway>;
  readonly accessToken: string;
  readonly pair: KeyPair;
  readonly jwk: PublicJwk;
  readonly nonces: NonceStore;
  readonly seen: { status: number; code: string | null; nonce: string | null }[];
}

export async function connect(mock: MockApi): Promise<Connected> {
  const approved = await approve(mock);
  const nonces = memoryNonceStore();
  const watched = watchedFetch();
  const result = await exchangeCode(
    {
      fetch: watched.fetch,
      apiBase: mock.url,
      pair: approved.pair,
      jwk: approved.jwk,
      nonces,
      now: () => Date.now(),
      jti: newKey,
    },
    { code: approved.code, verifier: approved.verifier, redirectUri: REDIRECT },
  );
  if (result.kind !== 'token') throw new Error(`no token: ${result.kind}`);
  const signer = dpopSigner({
    pair: approved.pair,
    jwk: approved.jwk,
    accessToken: result.accessToken,
    nonces,
    now: () => Date.now(),
    jti: newKey,
  });
  const gateway = createPlaysGateway({
    fetch: watched.fetch,
    apiBase: mock.url,
    signer: () => Promise.resolve(signer),
  });
  return {
    gateway,
    accessToken: result.accessToken,
    pair: approved.pair,
    jwk: approved.jwk,
    nonces,
    seen: watched.seen,
  };
}

export const iso = (at: number): string => new Date(at).toISOString();

export const film = (at = T0 - 3 * MINUTE): ViewingBody => ({
  kind: 'movie',
  ids: { tmdb: 438631 },
  title: 'Dune',
  year: 2021,
  watched_at: iso(at),
  duration_seconds: 9360,
  furthest_position_seconds: 9000,
  ended: true,
});
