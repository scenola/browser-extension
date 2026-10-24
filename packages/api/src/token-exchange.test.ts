/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

import { ProtocolInputError } from './input-error';
import type { PublicJwk } from './keys';
import { generateDpopKey, publicJwk } from './keys';
import { memoryNonceStore } from './nonce';
import type { NonceStore } from './nonce';
import type { Step } from './testing/scripted-fetch';
import {
  answer,
  hangsUntilAborted,
  proofClaims,
  refusal,
  scriptedFetch,
  spellings,
} from './testing/scripted-fetch';
import { exchangeCode } from './token-exchange';
import type { ExchangeDeps } from './token-exchange';

const API = 'https://api.example';
const TOKEN_URL = 'https://api.example/v1/integrations/oauth/token';
const TOKEN = 'mts_ext_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG_hij';
const INPUT = {
  code: 'c'.repeat(43),
  verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/',
};
const GRANTED = { access_token: TOKEN, token_type: 'DPoP', expires_in: 7_776_000 };
const NONCE_PLEASE = (nonce: string | null) =>
  refusal(
    400,
    'scrobbling.dpop_nonce_required',
    { details: { error: 'use_dpop_nonce' } },
    nonce === null ? {} : { 'DPoP-Nonce': nonce },
  );

let pair: CryptoKeyPair;
let jwk: PublicJwk;
let otherJwk: PublicJwk;
beforeAll(async () => {
  pair = await generateDpopKey();
  jwk = await publicJwk(pair);
  otherJwk = await publicJwk(await generateDpopKey());
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A clock that moves 1.5 s per reading, and jtis that never repeat. */
function harness(steps: readonly Step[], over: Partial<ExchangeDeps> = {}) {
  const scripted = scriptedFetch(steps);
  const nonces: NonceStore = memoryNonceStore();
  let clock = 1_700_000_000_000;
  let serial = 0;
  const deps: ExchangeDeps = {
    fetch: scripted.fetch,
    apiBase: API,
    pair,
    jwk,
    nonces,
    now: () => (clock += 1_500),
    jti: () => `jti-${String((serial += 1)).padStart(8, '0')}`,
    ...over,
  };
  return { deps, calls: scripted.calls, nonces };
}

async function reasonOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ProtocolInputError) return error.reason;
    throw error;
  }
  throw new Error('expected a ProtocolInputError');
}

describe('the request', () => {
  test('a form of exactly grant_type, code, code_verifier, redirect_uri — and no Idempotency-Key', async () => {
    const { deps, calls } = harness([answer(200, GRANTED)]);
    expect(await exchangeCode(deps, INPUT)).toEqual({
      kind: 'token',
      accessToken: TOKEN,
      expiresIn: 7_776_000,
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(TOKEN_URL);
    expect(call?.method).toBe('POST');
    expect(call?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(call?.body ?? '');
    expect([...form.entries()]).toEqual([
      ['grant_type', 'authorization_code'],
      ['code', INPUT.code],
      ['code_verifier', INPUT.verifier],
      ['redirect_uri', INPUT.redirectUri],
    ]);
    // The token endpoint is exempt from Idempotency-Key; it holds no credential to present.
    expect(call?.headers.has('idempotency-key')).toBe(false);
    expect(call?.headers.has('authorization')).toBe(false);
    expect(spellings(call?.rawHeaders, 'DPoP')).toBe(1);
  });

  test('its proof names the request (htm, htu) and carries no ath — there is no credential yet', async () => {
    const { deps, calls, nonces } = harness([answer(200, GRANTED)]);
    await nonces.set('stored-nonce');
    await exchangeCode(deps, INPUT);
    const { payload, protectedHeader } = await proofClaims(calls[0]?.headers.get('dpop') ?? null);
    expect(payload.htm).toBe('POST');
    expect(payload.htu).toBe(TOKEN_URL);
    expect(payload.nonce).toBe('stored-nonce');
    expect('ath' in payload).toBe(false);
    expect(protectedHeader.jwk).toEqual({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });
  });

  test('a form value with reserved characters reads back as given', async () => {
    const { deps, calls } = harness([answer(200, GRANTED)]);
    const redirectUri = 'https://x.chromiumapp.org/?a=1&code=evil';
    await exchangeCode(deps, { ...INPUT, redirectUri });
    const form = new URLSearchParams(calls[0]?.body ?? '');
    expect(form.getAll('code')).toEqual([INPUT.code]);
    expect(form.get('redirect_uri')).toBe(redirectUri);
  });
});

describe('the nonce (RFC 9449 §8): one retry, with the nonce the answer handed over', () => {
  test('400 use_dpop_nonce + DPoP-Nonce: n2 → the second proof carries n2, a fresh jti and iat', async () => {
    const { deps, calls } = harness([NONCE_PLEASE('n2'), answer(200, GRANTED)]);
    expect((await exchangeCode(deps, INPUT)).kind).toBe('token');
    expect(calls).toHaveLength(2);
    const first = await proofClaims(calls[0]?.headers.get('dpop') ?? null);
    const second = await proofClaims(calls[1]?.headers.get('dpop') ?? null);
    expect('nonce' in first.payload).toBe(false);
    expect(second.payload.nonce).toBe('n2');
    expect(second.payload.jti).not.toBe(first.payload.jti);
    expect(second.payload.iat).not.toBe(first.payload.iat);
    expect(calls[1]?.body).toBe(calls[0]?.body);
    expect(spellings(calls[1]?.rawHeaders, 'DPoP')).toBe(1);
  });

  test('asked twice: no third request — the answer is unavailable (the code is never spent here)', async () => {
    const { deps, calls } = harness([NONCE_PLEASE('n2'), NONCE_PLEASE('n3'), answer(200, GRANTED)]);
    // An `unavailable` says why, for the diagnostics log.
    expect(await exchangeCode(deps, INPUT)).toEqual({
      kind: 'unavailable',
      detail: 'nonce_refused',
    });
    expect(calls).toHaveLength(2);
  });

  test('asked without a nonce to use: no retry, unavailable', async () => {
    const { deps, calls } = harness([NONCE_PLEASE(null), answer(200, GRANTED)]);
    expect(await exchangeCode(deps, INPUT)).toEqual({
      kind: 'unavailable',
      detail: 'nonce_refused',
    });
    expect(calls).toHaveLength(1);
  });

  test('asked with a value that is not a nonce (two headers joined): no retry', async () => {
    const { deps, calls } = harness([NONCE_PLEASE('n2, n3'), answer(200, GRANTED)]);
    expect(await exchangeCode(deps, INPUT)).toEqual({
      kind: 'unavailable',
      detail: 'nonce_refused',
    });
    expect(calls).toHaveLength(1);
  });

  test('the OAuth error alone (details.error) is the same request', async () => {
    const { deps, calls } = harness([
      refusal(400, 'other.code', { details: { error: 'use_dpop_nonce' } }, { 'DPoP-Nonce': 'n2' }),
      answer(200, GRANTED),
    ]);
    expect((await exchangeCode(deps, INPUT)).kind).toBe('token');
    expect(calls).toHaveLength(2);
  });

  test('a nonce store that cannot read or write never loses the credential', async () => {
    const broken: NonceStore = {
      get: () => Promise.reject(new Error('storage.session is gone')),
      set: () => Promise.reject(new Error('storage.session is gone')),
    };
    const { deps, calls } = harness(
      [NONCE_PLEASE('n2'), answer(200, GRANTED, { 'DPoP-Nonce': 'n3' })],
      { nonces: broken },
    );
    expect((await exchangeCode(deps, INPUT)).kind).toBe('token');
    // The retry still carries the nonce the answer handed over, not the store's.
    expect((await proofClaims(calls[1]?.headers.get('dpop') ?? null)).payload.nonce).toBe('n2');
  });

  test('every answer’s DPoP-Nonce is kept, a success and a refusal alike', async () => {
    const ok = harness([answer(200, GRANTED, { 'DPoP-Nonce': 'after-success' })]);
    await exchangeCode(ok.deps, INPUT);
    expect(await ok.nonces.get()).toBe('after-success');
    const refused = harness([
      refusal(400, 'scrobbling.authorization_code_invalid', {}, { 'DPoP-Nonce': 'after-refusal' }),
    ]);
    await exchangeCode(refused.deps, INPUT);
    expect(await refused.nonces.get()).toBe('after-refusal');
  });
});

describe('every answer of the token endpoint', () => {
  // The fourth column is an `unavailable`'s `detail`, for the diagnostics log only.
  test.each<[string, Step, string, string?]>([
    [
      '400 authorization_code_invalid',
      refusal(400, 'scrobbling.authorization_code_invalid'),
      'code_invalid',
    ],
    ['400 dpop_proof_invalid', refusal(400, 'scrobbling.dpop_proof_invalid'), 'proof_invalid'],
    ['403 plus_required', refusal(403, 'plus_required'), 'forbidden'],
    ['403 session_not_fresh', refusal(403, 'scrobbling.session_not_fresh'), 'forbidden'],
    // Without the envelope it is a proxy's or a WAF's: nothing about the account. Try again.
    ['403 with no body', new Response(null, { status: 403 }), 'unavailable', 'http_403'],
    [
      '403 HTML from a proxy',
      new Response('<html>denied</html>', { status: 403 }),
      'unavailable',
      'http_403',
    ],
    [
      '409 scrobbler_limit_reached',
      refusal(409, 'scrobbling.scrobbler_limit_reached'),
      'limit_reached',
    ],
    ['404 (the feature is closed)', refusal(404, 'resource.not_found'), 'feature_closed'],
    // Without the envelope it is a proxy's or a misrouted path's: nothing about the feature.
    ['404 with no body', new Response(null, { status: 404 }), 'unavailable', 'http_404'],
    [
      '404 HTML from a proxy',
      new Response('<html>Not Found</html>', { status: 404 }),
      'unavailable',
      'http_404',
    ],
    ['503 service.unavailable', refusal(503, 'service.unavailable'), 'unavailable', 'http_503'],
    ['503 HTML from a proxy', new Response('<html>', { status: 503 }), 'unavailable', 'http_503'],
    ['a network error', new TypeError('Failed to fetch'), 'unavailable', 'network:TypeError'],
    // Total over what is not in the table: the server's refusal is "connect again", the rest
    // "try again".
    ['422 validation.failed', refusal(422, 'validation.failed'), 'code_invalid'],
    ['400 with an unknown code', refusal(400, 'scrobbling.something_new'), 'code_invalid'],
    ['409 with another code', refusal(409, 'idempotency.in_flight'), 'code_invalid'],
    ['418 in the server’s envelope', refusal(418, 'scrobbling.something_new'), 'code_invalid'],
    // A 4xx without the envelope is no refusal of the server's: nothing was spent.
    ['400 with no body', new Response('', { status: 400 }), 'unavailable', 'http_400'],
    [
      '400 HTML from a proxy',
      new Response('<html>Bad Request</html>', { status: 400 }),
      'unavailable',
      'http_400',
    ],
    [
      '400 with an OAuth body the server never sends',
      answer(400, { error: 'invalid_grant' }),
      'unavailable',
      'http_400',
    ],
    ['418', new Response(null, { status: 418 }), 'unavailable', 'http_418'],
    ['409 with no envelope', new Response('conflict', { status: 409 }), 'unavailable', 'http_409'],
    ['422 with a code that is not a code', refusal(422, 'Not A Code'), 'unavailable', 'http_422'],
    [
      '429 (the failure bucket)',
      refusal(429, 'rate_limit.exceeded', { retry_after_seconds: 30 }),
      'unavailable',
      'http_429',
    ],
    ['408', new Response(null, { status: 408 }), 'unavailable', 'http_408'],
    ['500', refusal(500, 'internal.error'), 'unavailable', 'http_500'],
    ['504', refusal(504, 'request.deadline_exceeded'), 'unavailable', 'http_504'],
    ['201 (not the endpoint’s answer)', answer(201, GRANTED), 'unavailable', 'http_201'],
  ])('%s → %s', async (_name, step, kind, detail) => {
    const { deps, calls } = harness([step]);
    expect(await exchangeCode(deps, INPUT)).toEqual(
      detail === undefined ? { kind } : { kind, detail },
    );
    // Never retried automatically: the code is single use.
    expect(calls).toHaveLength(1);
  });

  test('a timeout → unavailable, after AbortSignal.timeout(15 000)', async () => {
    const controller = new AbortController();
    const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const { deps, calls } = harness([hangsUntilAborted]);
    const pending = exchangeCode(deps, INPUT);
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    controller.abort(new DOMException('signal timed out', 'TimeoutError'));
    expect(await pending).toEqual({ kind: 'unavailable', detail: 'timeout' });
    expect(spy).toHaveBeenCalledWith(15_000);
  });
});

describe('a 200 is a credential only when it is one this extension can present', () => {
  test.each([
    [
      'token_type in another case (RFC 6749 §5.1: case-insensitive)',
      { ...GRANTED, token_type: 'dpop' },
    ],
    ['an extra member', { ...GRANTED, scope: 'plays' }],
  ])('%s → token', async (_name, body) => {
    const { deps } = harness([answer(200, body)]);
    expect((await exchangeCode(deps, INPUT)).kind).toBe('token');
  });

  test('expires_in is bounded by the absolute lifetime (365 d) and whole seconds', async () => {
    const huge = harness([answer(200, { ...GRANTED, expires_in: 1e15 })]);
    expect(await exchangeCode(huge.deps, INPUT)).toMatchObject({ expiresIn: 365 * 86_400 });
    const fractional = harness([answer(200, { ...GRANTED, expires_in: 99.9 })]);
    expect(await exchangeCode(fractional.deps, INPUT)).toMatchObject({ expiresIn: 99 });
    const zero = harness([answer(200, { ...GRANTED, expires_in: 0 })]);
    expect(await exchangeCode(zero.deps, INPUT)).toMatchObject({ expiresIn: 0 });
  });

  test.each([
    ['no access_token', { token_type: 'DPoP', expires_in: 60 }],
    ['access_token not a string', { ...GRANTED, access_token: 42 }],
    ['access_token not a token68 (a space)', { ...GRANTED, access_token: 'mts_ext_a b' }],
    ['access_token with a line break', { ...GRANTED, access_token: 'mts_ext_a\r\nX-Evil: 1' }],
    [
      'access_token past 1024 characters',
      { ...GRANTED, access_token: `mts_ext_${'a'.repeat(1020)}` },
    ],
    ['token_type Bearer', { ...GRANTED, token_type: 'Bearer' }],
    ['no token_type', { access_token: TOKEN, expires_in: 60 }],
    ['expires_in as text', { ...GRANTED, expires_in: '3600' }],
    ['expires_in negative', { ...GRANTED, expires_in: -1 }],
    ['no expires_in', { access_token: TOKEN, token_type: 'DPoP' }],
    ['an array', [GRANTED]],
    ['null', null],
  ])('%s → unavailable (not an answer this extension can store)', async (_name, body) => {
    const { deps } = harness([answer(200, body)]);
    expect(await exchangeCode(deps, INPUT)).toEqual({
      kind: 'unavailable',
      detail: 'http_200_unreadable',
    });
  });

  test('a 200 that is not JSON → unavailable', async () => {
    const { deps } = harness([new Response('<html>ok</html>', { status: 200 })]);
    expect(await exchangeCode(deps, INPUT)).toEqual({
      kind: 'unavailable',
      detail: 'http_200_unreadable',
    });
  });
});

describe('what this package refuses before sending anything', () => {
  test('a pair that is not the JWK’s key (bad_key) → proof_invalid, no request', async () => {
    const { deps, calls } = harness([answer(200, GRANTED)], { jwk: otherJwk });
    expect(await exchangeCode(deps, INPUT)).toEqual({ kind: 'proof_invalid' });
    expect(calls).toHaveLength(0);
  });

  test('a stored JWK that is not one (bad_jwk) → proof_invalid, no request', async () => {
    const { deps, calls } = harness([answer(200, GRANTED)], {
      jwk: { kty: 'EC', crv: 'P-256', x: 'short', y: 'short' },
    });
    expect(await exchangeCode(deps, INPUT)).toEqual({ kind: 'proof_invalid' });
    expect(calls).toHaveLength(0);
  });

  test('whatever storage held instead of a pair (bad_key) → proof_invalid, no request', async () => {
    const { deps, calls } = harness([answer(200, GRANTED)], {
      pair: { privateKey: {}, publicKey: {} } as unknown as CryptoKeyPair,
    });
    expect(await exchangeCode(deps, INPUT)).toEqual({ kind: 'proof_invalid' });
    expect(calls).toHaveLength(0);
  });

  test.each<[string, Partial<ExchangeDeps>, string]>([
    ['an API base that is not a URL (bad_url)', { apiBase: 'api.example' }, 'bad_url'],
    ['a jti the server would refuse (bad_jti)', { jti: () => 'short' }, 'bad_jti'],
    ['a clock outside the Date range (bad_time)', { now: () => Number.NaN }, 'bad_time'],
  ])('%s is a bug: thrown, loudly, and nothing is sent', async (_name, over, reason) => {
    const { deps, calls } = harness([answer(200, GRANTED)], over);
    expect(await reasonOf(exchangeCode(deps, INPUT))).toBe(reason);
    expect(calls).toHaveLength(0);
  });

  test('a bug on the nonce retry is thrown too, and the retry is not sent', async () => {
    let jtis = 0;
    const { deps, calls } = harness([NONCE_PLEASE('n2'), answer(200, GRANTED)], {
      jti: () => ((jtis += 1) === 1 ? 'jti-00000001' : 'bad'),
    });
    expect(await reasonOf(exchangeCode(deps, INPUT))).toBe('bad_jti');
    expect(calls).toHaveLength(1);
  });

  test('a verifier that is not one (bad_verifier) is a bug: thrown, nothing sent', async () => {
    const { deps, calls } = harness([answer(200, GRANTED)]);
    expect(await reasonOf(exchangeCode(deps, { ...INPUT, verifier: 'short' }))).toBe(
      'bad_verifier',
    );
    expect(calls).toHaveLength(0);
  });

  test.each([
    ['empty', ''],
    ['past the 128 characters the server takes', 'c'.repeat(129)],
  ])('a code that is %s was never the server’s: code_invalid, nothing sent', async (_n, code) => {
    const { deps, calls } = harness([answer(200, GRANTED)]);
    expect(await exchangeCode(deps, { ...INPUT, code })).toEqual({ kind: 'code_invalid' });
    expect(calls).toHaveLength(0);
  });
});
