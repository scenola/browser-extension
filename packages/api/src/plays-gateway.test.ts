/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DEFAULT_RULE } from '@mt/core';
import type { PlayBody, ReceiptResult, SendResult } from '@mt/core';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

import { ProtocolInputError } from './input-error';
import type { PublicJwk } from './keys';
import { generateDpopKey, publicJwk } from './keys';
import { memoryNonceStore } from './nonce';
import type { NonceStore } from './nonce';
import { createPlaysGateway } from './plays-gateway';
import type { RequestSigner } from './signer';
import { bearerSigner, dpopSigner } from './signer';
import type { Step } from './testing/scripted-fetch';
import {
  answer,
  athOf,
  hangsUntilAborted,
  proofClaims,
  refusal,
  scriptedFetch,
  spellings,
} from './testing/scripted-fetch';

const API = 'https://api.example';
const PLAYS_URL = 'https://api.example/v1/integrations/plays';
const TOKEN = 'mts_ext_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG_hij';
const PLAY_ID = '0192f1a2-7b3c-7d4e-8f5a-6b7c8d9e0f10';
const SCROBBLE_ID = '01jxk4a9b2c8m4n6p8q0r2s4t6';
// The plays API documentation's example title id has a `u`, which the server's own decoder refuses; this one is an id.
const TITLE_ID = '01jx9q2w3e4r5t6y7v8a9b0p1a';
const BODY: PlayBody = {
  kind: 'episode',
  show: { title: 'Breaking Bad', year: 2008 },
  season_number: 1,
  episode_number: 2,
  watched_at: '2026-10-20T21:40:00+02:00',
  duration_seconds: 2820,
  furthest_position_seconds: 2700,
  ended: true,
};
const NONCE_PLEASE = (nonce: string | null) =>
  refusal(
    401,
    'scrobbling.dpop_nonce_required',
    {},
    nonce === null
      ? {}
      : { 'DPoP-Nonce': nonce, 'WWW-Authenticate': 'DPoP error="use_dpop_nonce", algs="ES256"' },
  );
const CREDENTIAL_INVALID = () => refusal(401, 'scrobbling.credential_invalid');

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

interface HarnessOptions {
  readonly signer?: RequestSigner | null;
  readonly signerDeps?: Partial<Parameters<typeof dpopSigner>[0]>;
  readonly apiBase?: string;
}

/** A gateway over a scripted fetch, signing with a DPoP key, a clock and jtis that move. */
function harness(steps: readonly Step[], options: HarnessOptions = {}) {
  const scripted = scriptedFetch(steps);
  const nonces: NonceStore = memoryNonceStore();
  let clock = 1_700_000_000_000;
  let serial = 0;
  let signerCalls = 0;
  const signer =
    options.signer === undefined
      ? dpopSigner({
          pair,
          jwk,
          accessToken: TOKEN,
          nonces,
          now: () => (clock += 1_500),
          jti: () => `jti-${String((serial += 1)).padStart(8, '0')}`,
          ...options.signerDeps,
        })
      : options.signer;
  const gateway = createPlaysGateway({
    fetch: scripted.fetch,
    apiBase: options.apiBase ?? API,
    signer: () => {
      signerCalls += 1;
      return Promise.resolve(signer);
    },
  });
  return { gateway, calls: scripted.calls, nonces, signerCalls: () => signerCalls };
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

describe('send: the request', () => {
  test('POST /v1/integrations/plays with the play id as Idempotency-Key and the body as JSON', async () => {
    const { gateway, calls } = harness([
      answer(202, { scrobble_id: SCROBBLE_ID, state: 'received', reason: null }),
    ]);
    expect(await gateway.send(PLAY_ID, BODY)).toEqual({
      kind: 'accepted',
      scrobbleId: SCROBBLE_ID,
      state: 'received',
      reason: null,
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(PLAYS_URL);
    expect(call?.method).toBe('POST');
    expect(call?.headers.get('idempotency-key')).toBe(PLAY_ID);
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(call?.body ?? 'null')).toEqual(BODY);
    expect(call?.headers.get('authorization')).toBe(`DPoP ${TOKEN}`);
    expect(spellings(call?.rawHeaders, 'DPoP')).toBe(1);
    expect(spellings(call?.rawHeaders, 'Authorization')).toBe(1);
  });

  test('its proof verifies with jose and names the request: htm, htu, ath', async () => {
    const { gateway, calls } = harness([
      answer(202, { scrobble_id: SCROBBLE_ID, state: 'received', reason: null }),
    ]);
    await gateway.send(PLAY_ID, BODY);
    const { payload, protectedHeader } = await proofClaims(calls[0]?.headers.get('dpop') ?? null);
    expect(payload.htm).toBe('POST');
    expect(payload.htu).toBe(PLAYS_URL);
    expect(payload.ath).toBe(await athOf(TOKEN));
    expect(protectedHeader.jwk).toEqual({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });
  });

  test('a configured base with a trailing slash names the same URL', async () => {
    const { gateway, calls } = harness(
      [answer(202, { scrobble_id: SCROBBLE_ID, state: 'received', reason: null })],
      { apiBase: `${API}/` },
    );
    await gateway.send(PLAY_ID, BODY);
    expect(calls[0]?.url).toBe(PLAYS_URL);
    expect((await proofClaims(calls[0]?.headers.get('dpop') ?? null)).payload.htu).toBe(PLAYS_URL);
  });

  test('a personal token signs as Bearer, with no proof', async () => {
    const { gateway, calls } = harness(
      [answer(202, { scrobble_id: SCROBBLE_ID, state: 'received', reason: null })],
      { signer: bearerSigner('mts_pat_abc123') },
    );
    expect((await gateway.send(PLAY_ID, BODY)).kind).toBe('accepted');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer mts_pat_abc123');
    expect(calls[0]?.headers.has('dpop')).toBe(false);
  });
});

describe('send: every answer', () => {
  test.each<[string, Step, SendResult]>([
    [
      '202 received',
      answer(202, { scrobble_id: SCROBBLE_ID, state: 'received', reason: null }),
      { kind: 'accepted', scrobbleId: SCROBBLE_ID, state: 'received', reason: null },
    ],
    [
      '202 held / braked (kept)',
      answer(202, { scrobble_id: SCROBBLE_ID, state: 'held', reason: 'braked' }),
      { kind: 'accepted', scrobbleId: SCROBBLE_ID, state: 'held', reason: 'braked' },
    ],
    [
      '202 a play that is not kept (scrobble_id null): accepted, never retried',
      answer(202, { scrobble_id: null, state: 'dismissed', reason: 'account_deletion' }),
      { kind: 'accepted', scrobbleId: null, state: 'dismissed', reason: 'account_deletion' },
    ],
    [
      '202 held past the cap (scrobble_id null)',
      answer(202, { scrobble_id: null, state: 'held', reason: 'plus_lapsed' }),
      { kind: 'accepted', scrobbleId: null, state: 'held', reason: 'plus_lapsed' },
    ],
    [
      '409 idempotency.already_applied',
      refusal(409, 'idempotency.already_applied'),
      { kind: 'already_applied' },
    ],
    ['409 idempotency.in_flight', refusal(409, 'idempotency.in_flight'), { kind: 'in_flight' }],
    [
      '429 with retry_after_seconds: 7',
      refusal(429, 'rate_limit.exceeded', { retry_after_seconds: 7 }),
      { kind: 'rate_limited', retryAfterSeconds: 7 },
    ],
    ['401 scrobbling.credential_invalid', CREDENTIAL_INVALID(), { kind: 'credential_invalid' }],
    ['404 (the feature is closed)', refusal(404, 'resource.not_found'), { kind: 'feature_closed' }],
    // Without the envelope it is a proxy's or a misrouted path's: nothing about the feature.
    [
      '404 with no body',
      new Response(null, { status: 404 }),
      { kind: 'unavailable', detail: 'http_404' },
    ],
    [
      '404 HTML from a proxy',
      new Response('<html>Not Found</html>', { status: 404 }),
      { kind: 'unavailable', detail: 'http_404' },
    ],
    [
      '422 validation.failed',
      refusal(422, 'validation.failed', { details: { errors: [], error_count: 1 } }),
      { kind: 'rejected', status: 422, code: 'validation.failed' },
    ],
    [
      '422 scrobbling.watched_at_out_of_range',
      refusal(422, 'scrobbling.watched_at_out_of_range'),
      { kind: 'rejected', status: 422, code: 'scrobbling.watched_at_out_of_range' },
    ],
    [
      '422 idempotency.body_mismatch',
      refusal(422, 'idempotency.body_mismatch'),
      { kind: 'rejected', status: 422, code: 'idempotency.body_mismatch' },
    ],
    [
      '413 request.body_too_large',
      refusal(413, 'request.body_too_large'),
      { kind: 'rejected', status: 413, code: 'request.body_too_large' },
    ],
    [
      '413 from a proxy, no envelope',
      new Response('<html>413</html>', { status: 413 }),
      { kind: 'rejected', status: 413, code: null },
    ],
    ['500', refusal(500, 'internal.error'), { kind: 'unavailable', detail: 'http_500' }],
    [
      '503 service.overloaded',
      refusal(503, 'service.overloaded', { retry_after_seconds: 2 }),
      { kind: 'unavailable', detail: 'http_503' },
    ],
    [
      '504 request.deadline_exceeded',
      refusal(504, 'request.deadline_exceeded'),
      { kind: 'unavailable', detail: 'http_504' },
    ],
    [
      'a network error',
      new TypeError('Failed to fetch'),
      { kind: 'unavailable', detail: 'network:TypeError' },
    ],
  ])('%s', async (_name, step, expected) => {
    const { gateway, calls } = harness([step]);
    expect(await gateway.send(PLAY_ID, BODY)).toEqual(expected);
    expect(calls).toHaveLength(1);
  });

  test('a 15 s timeout → unavailable', async () => {
    const controller = new AbortController();
    const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const { gateway, calls } = harness([hangsUntilAborted]);
    const pending = gateway.send(PLAY_ID, BODY);
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    controller.abort(new DOMException('signal timed out', 'TimeoutError'));
    expect(await pending).toEqual({ kind: 'unavailable', detail: 'timeout' });
    expect(spy).toHaveBeenCalledWith(15_000);
  });

  test.each<[string, Step, SendResult]>([
    // What no table names is total: the server's refusal of the play is a dead letter (it will
    // answer the same), anything else is retried with the same key — never a throw.
    [
      '400 idempotency.key_malformed',
      refusal(400, 'idempotency.key_malformed'),
      { kind: 'rejected', status: 400, code: 'idempotency.key_malformed' },
    ],
    [
      '403 in the server’s envelope',
      refusal(403, 'scrobbling.something_new'),
      { kind: 'rejected', status: 403, code: 'scrobbling.something_new' },
    ],
    [
      '409 with another code',
      refusal(409, 'scrobbling.something_new'),
      { kind: 'rejected', status: 409, code: 'scrobbling.something_new' },
    ],
    [
      '422 without the envelope: still a refusal of the body',
      new Response('<html>422</html>', { status: 422 }),
      { kind: 'rejected', status: 422, code: null },
    ],
    // A 4xx the server never sends on this route — no envelope — came from something in
    // between and judged nothing about the play: retried, bounded by the 29-day give-up.
    [
      '403 without the envelope (a WAF, a CDN)',
      new Response('denied', { status: 403 }),
      { kind: 'unavailable', detail: 'http_403' },
    ],
    [
      '405 (a base that routes elsewhere)',
      new Response(null, { status: 405, headers: { Allow: 'GET' } }),
      { kind: 'unavailable', detail: 'http_405' },
    ],
    [
      '400 with no body',
      new Response(null, { status: 400 }),
      { kind: 'unavailable', detail: 'http_400' },
    ],
    [
      '409 with no envelope',
      new Response('conflict', { status: 409 }),
      { kind: 'unavailable', detail: 'http_409' },
    ],
    [
      '418 with a code that is not a code',
      refusal(418, 'Not A Code <script>'),
      { kind: 'unavailable', detail: 'http_418' },
    ],
    // RFC 9110 §15.5.9: a 408 may be repeated; it judged nothing about the play.
    ['408', new Response(null, { status: 408 }), { kind: 'unavailable', detail: 'http_408' }],
    // A 401 that is neither refusal: never a reconnect, never a dead letter.
    [
      '401 with another code',
      refusal(401, 'auth.token_invalid'),
      { kind: 'unavailable', detail: 'http_401' },
    ],
    [
      '401 with no body',
      new Response(null, { status: 401 }),
      { kind: 'unavailable', detail: 'http_401' },
    ],
    [
      '429 with no usable wait: backed off like an outage',
      refusal(429, 'rate_limit.exceeded'),
      { kind: 'unavailable', detail: 'http_429' },
    ],
    [
      '429 with a wait past the slowest retry: bounded to 6 h, never a dead letter',
      refusal(429, 'rate_limit.exceeded', { retry_after_seconds: 1e12 }),
      { kind: 'rate_limited', retryAfterSeconds: 21_600 },
    ],
    [
      '200 (not this route’s answer: a misconfigured base, a portal)',
      answer(200, { scrobble_id: SCROBBLE_ID, state: 'received', reason: null }),
      { kind: 'unavailable', detail: 'http_200' },
    ],
    [
      '202 that is not JSON',
      new Response('<html>Accepted</html>', { status: 202 }),
      { kind: 'unavailable', detail: 'http_202_unreadable' },
    ],
    [
      '202 without a state',
      answer(202, { scrobble_id: SCROBBLE_ID }),
      { kind: 'unavailable', detail: 'http_202_unreadable' },
    ],
    [
      '202 without a scrobble_id (absent is not null)',
      answer(202, { state: 'received', reason: null }),
      { kind: 'unavailable', detail: 'http_202_unreadable' },
    ],
    [
      '202 whose scrobble_id is not an id (it would become a receipt path)',
      answer(202, { scrobble_id: '../../me', state: 'received', reason: null }),
      { kind: 'unavailable', detail: 'http_202_unreadable' },
    ],
    [
      '202 with a state this version does not know: kept, its answer unreadable',
      answer(202, { scrobble_id: SCROBBLE_ID, state: 'archived', reason: null }),
      { kind: 'already_applied' },
    ],
    [
      '202 with a state that is a prototype key',
      answer(202, { scrobble_id: SCROBBLE_ID, state: 'constructor', reason: null }),
      { kind: 'already_applied' },
    ],
    [
      '202 whose reason is not a reason: the state stands, the reason is dropped',
      answer(202, { scrobble_id: SCROBBLE_ID, state: 'held', reason: 'x'.repeat(65) }),
      { kind: 'accepted', scrobbleId: SCROBBLE_ID, state: 'held', reason: null },
    ],
    [
      '202 with a reason this version does not know: kept (shown as unknown)',
      answer(202, { scrobble_id: SCROBBLE_ID, state: 'held', reason: 'new_reason' }),
      { kind: 'accepted', scrobbleId: SCROBBLE_ID, state: 'held', reason: 'new_reason' },
    ],
  ])('%s', async (_name, step, expected) => {
    const { gateway, calls } = harness([step]);
    expect(await gateway.send(PLAY_ID, BODY)).toEqual(expected);
    expect(calls).toHaveLength(1);
  });
});

describe('send: the nonce — one retry, a fresh proof, the same play', () => {
  test('401 dpop_nonce_required then 202 → accepted after exactly two requests, one key', async () => {
    const { gateway, calls, signerCalls } = harness([
      NONCE_PLEASE('n2'),
      answer(202, { scrobble_id: SCROBBLE_ID, state: 'received', reason: null }),
    ]);
    expect(await gateway.send(PLAY_ID, BODY)).toMatchObject({ kind: 'accepted' });
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.headers.get('idempotency-key'))).toEqual([PLAY_ID, PLAY_ID]);
    expect(calls[1]?.body).toBe(calls[0]?.body);
    const first = await proofClaims(calls[0]?.headers.get('dpop') ?? null);
    const second = await proofClaims(calls[1]?.headers.get('dpop') ?? null);
    expect(second.payload.nonce).toBe('n2');
    expect(second.payload.jti).not.toBe(first.payload.jti);
    expect(second.payload.iat).not.toBe(first.payload.iat);
    for (const { payload } of [first, second]) {
      expect([payload.htm, payload.htu, payload.ath]).toEqual([
        'POST',
        PLAYS_URL,
        await athOf(TOKEN),
      ]);
    }
    expect(calls.map((c) => spellings(c.rawHeaders, 'DPoP'))).toEqual([1, 1]);
    // One credential read for the whole send.
    expect(signerCalls()).toBe(1);
  });

  test('asked twice: no third request — unavailable, retried later under the same key', async () => {
    const { gateway, calls } = harness([
      NONCE_PLEASE('n2'),
      NONCE_PLEASE('n3'),
      answer(202, { scrobble_id: SCROBBLE_ID, state: 'received', reason: null }),
    ]);
    expect(await gateway.send(PLAY_ID, BODY)).toEqual({
      kind: 'unavailable',
      detail: 'nonce_refused',
    });
    expect(calls).toHaveLength(2);
  });

  test('asked without a nonce to use: no retry', async () => {
    const { gateway, calls } = harness([
      NONCE_PLEASE(null),
      answer(202, { scrobble_id: SCROBBLE_ID, state: 'received', reason: null }),
    ]);
    expect(await gateway.send(PLAY_ID, BODY)).toEqual({
      kind: 'unavailable',
      detail: 'nonce_refused',
    });
    expect(calls).toHaveLength(1);
  });

  test('a credential refusal after the nonce retry is that refusal', async () => {
    const { gateway, calls } = harness([NONCE_PLEASE('n2'), CREDENTIAL_INVALID()]);
    expect(await gateway.send(PLAY_ID, BODY)).toEqual({ kind: 'credential_invalid' });
    expect(calls).toHaveLength(2);
  });

  test.each<[string, Step]>([
    [
      'a 202',
      answer(
        202,
        { scrobble_id: null, state: 'dismissed', reason: 'revoked' },
        { 'DPoP-Nonce': 'kept' },
      ),
    ],
    ['a 422', refusal(422, 'validation.failed', {}, { 'DPoP-Nonce': 'kept' })],
    ['a 500', refusal(500, 'internal.error', {}, { 'DPoP-Nonce': 'kept' })],
    ['a 409', refusal(409, 'idempotency.in_flight', {}, { 'DPoP-Nonce': 'kept' })],
  ])('the DPoP-Nonce of %s is kept for the next request', async (_name, step) => {
    const { gateway, nonces } = harness([step]);
    await gateway.send(PLAY_ID, BODY);
    expect(await nonces.get()).toBe('kept');
  });

  test('the next request signs with the nonce the last answer handed over', async () => {
    const { gateway, calls } = harness([
      answer(
        202,
        { scrobble_id: SCROBBLE_ID, state: 'received', reason: null },
        { 'DPoP-Nonce': 'fresh' },
      ),
      answer(202, { scrobble_id: SCROBBLE_ID, state: 'received', reason: null }),
    ]);
    await gateway.send(PLAY_ID, BODY);
    await gateway.send(PLAY_ID, BODY);
    expect((await proofClaims(calls[1]?.headers.get('dpop') ?? null)).payload.nonce).toBe('fresh');
  });
});

describe('send: refused before anything is sent', () => {
  test('no credential stored (the key or the token is gone) → credential_invalid', async () => {
    const { gateway, calls } = harness([], { signer: null });
    expect(await gateway.send(PLAY_ID, BODY)).toEqual({ kind: 'credential_invalid' });
    expect(calls).toHaveLength(0);
  });

  test.each<[string, HarnessOptions]>([
    ['the key does not match the stored JWK (bad_key)', { signerDeps: { jwk: otherJwk } }],
    [
      'the stored JWK is not one (bad_jwk)',
      { signerDeps: { jwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' } } },
    ],
    [
      'the stored credential cannot be presented (bad_access_token)',
      { signerDeps: { accessToken: 'a b' } },
    ],
    [
      'storage held no credential at all (null, never "DPoP null")',
      { signerDeps: { accessToken: null as unknown as string } },
    ],
    ['a personal token that cannot be presented', { signer: bearerSigner('mts_pat_\r\nX: y') }],
  ])('%s → credential_invalid: the connection must be redone', async (_name, options) => {
    const { gateway, calls } = harness([], options);
    expect(await gateway.send(PLAY_ID, BODY)).toEqual({ kind: 'credential_invalid' });
    expect(calls).toHaveLength(0);
  });

  test.each<[string, HarnessOptions, string]>([
    ['an API base that is not a URL', { apiBase: 'api.example' }, 'bad_url'],
    ['a jti the server would refuse', { signerDeps: { jti: () => 'x' } }, 'bad_jti'],
    ['a clock outside the Date range', { signerDeps: { now: () => -1 } }, 'bad_time'],
  ])('%s is a bug: thrown, loudly, and nothing is sent', async (_name, options, reason) => {
    const { gateway, calls } = harness([], options);
    expect(await reasonOf(gateway.send(PLAY_ID, BODY))).toBe(reason);
    expect(calls).toHaveLength(0);
  });

  test('a play id that is not a UUID is a bug: thrown, nothing sent', async () => {
    const { gateway, calls } = harness([]);
    await expect(gateway.send('not-a-uuid\r\nX-Evil: 1', BODY)).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  test('a body over 16 KiB is what the server answers 413 to: a dead letter, not sent', async () => {
    const { gateway, calls } = harness([]);
    const huge: PlayBody = { ...BODY, show: { title: 'é'.repeat(8_200) } };
    expect(await gateway.send(PLAY_ID, huge)).toEqual({
      kind: 'rejected',
      status: 413,
      code: null,
    });
    expect(calls).toHaveLength(0);
  });
});

describe('receipt', () => {
  const RECEIPT_URL = `${PLAYS_URL}/${SCROBBLE_ID}`;
  const RECORDED = {
    scrobble_id: SCROBBLE_ID,
    state: 'recorded',
    reason: null,
    title_id: TITLE_ID,
    episode_id: '01jx9q2w3e4r5t6y7u8i9o0p1b',
  };

  test('GET /v1/integrations/plays/{id}, signed for that URL', async () => {
    const { gateway, calls } = harness([answer(200, RECORDED)]);
    expect(await gateway.receipt(SCROBBLE_ID)).toEqual({
      kind: 'ok',
      state: 'recorded',
      reason: null,
      titleId: TITLE_ID,
      questionKey: null,
    });
    const [call] = calls;
    expect(call?.url).toBe(RECEIPT_URL);
    expect(call?.method).toBe('GET');
    expect(call?.body).toBeNull();
    expect(call?.headers.has('idempotency-key')).toBe(false);
    const { payload } = await proofClaims(call?.headers.get('dpop') ?? null);
    expect([payload.htm, payload.htu, payload.ath]).toEqual([
      'GET',
      RECEIPT_URL,
      await athOf(TOKEN),
    ]);
  });

  test.each<[string, Step, ReceiptResult]>([
    [
      '200 needs_confirmation',
      answer(200, {
        ...RECORDED,
        state: 'needs_confirmation',
        reason: 'text_only',
        title_id: null,
      }),
      {
        kind: 'ok',
        state: 'needs_confirmation',
        reason: 'text_only',
        titleId: null,
        questionKey: null,
      },
    ],
    [
      '200 waiting with a question_key: kept whole',
      answer(200, {
        ...RECORDED,
        state: 'needs_confirmation',
        reason: 'text_only',
        title_id: null,
        question_key: 'q1:0123456789abcdef0123456789abcdef',
      }),
      {
        kind: 'ok',
        state: 'needs_confirmation',
        reason: 'text_only',
        titleId: null,
        questionKey: 'q1:0123456789abcdef0123456789abcdef',
      },
    ],
    [
      '200 with a question_key that is not a short text: no key',
      answer(200, { ...RECORDED, question_key: 'x'.repeat(201) }),
      { kind: 'ok', state: 'recorded', reason: null, titleId: TITLE_ID, questionKey: null },
    ],
    [
      '200 with a title_id that is not an id: the state stands, the link is dropped',
      answer(200, { ...RECORDED, title_id: '../../settings' }),
      { kind: 'ok', state: 'recorded', reason: null, titleId: null, questionKey: null },
    ],
    [
      '200 in upper case (Crockford ids are case-insensitive)',
      answer(200, { ...RECORDED, scrobble_id: SCROBBLE_ID.toUpperCase() }),
      { kind: 'ok', state: 'recorded', reason: null, titleId: TITLE_ID, questionKey: null },
    ],
    [
      '404 (not this connection’s, or gone)',
      refusal(404, 'resource.not_found'),
      { kind: 'not_found' },
    ],
    // `not_found` ends the play's tracking for good: a 404 without the server's envelope — a
    // proxy, a path routed elsewhere — must never say it. Each `unavailable` says why, for the
    // diagnostics log : the envelope-less 404 and a 5xx no longer read alike.
    [
      '404 with no body',
      new Response(null, { status: 404 }),
      { kind: 'unavailable', detail: 'http_404' },
    ],
    [
      '404 HTML from a proxy',
      new Response('<html>Not Found</html>', { status: 404 }),
      { kind: 'unavailable', detail: 'http_404' },
    ],
    ['401 credential_invalid', CREDENTIAL_INVALID(), { kind: 'credential_invalid' }],
    [
      '401 another code',
      refusal(401, 'auth.token_invalid'),
      { kind: 'unavailable', detail: 'http_401' },
    ],
    [
      '429',
      refusal(429, 'rate_limit.exceeded', { retry_after_seconds: 5 }),
      { kind: 'unavailable', detail: 'http_429' },
    ],
    ['500', refusal(500, 'internal.error'), { kind: 'unavailable', detail: 'http_500' }],
    ['422', refusal(422, 'validation.failed'), { kind: 'unavailable', detail: 'http_422' }],
    [
      'a network error',
      new TypeError('Failed to fetch'),
      { kind: 'unavailable', detail: 'network:TypeError' },
    ],
    [
      '200 with a state this version does not know',
      answer(200, { ...RECORDED, state: 'archived' }),
      { kind: 'unavailable', detail: 'http_200_unreadable' },
    ],
    [
      '200 naming another play (its answer must not reach this one)',
      answer(200, { ...RECORDED, scrobble_id: '01jxk4a9b2c8m4n6p8q0r2s4t7' }),
      { kind: 'unavailable', detail: 'http_200_other_play' },
    ],
    [
      '200 that is not JSON',
      new Response('<html>', { status: 200 }),
      { kind: 'unavailable', detail: 'http_200_unreadable' },
    ],
    ['204', new Response(null, { status: 204 }), { kind: 'unavailable', detail: 'http_204' }],
  ])('%s', async (_name, step, expected) => {
    const { gateway, calls } = harness([step]);
    expect(await gateway.receipt(SCROBBLE_ID)).toEqual(expected);
    expect(calls).toHaveLength(1);
  });

  test('401 dpop_nonce_required → one retry with a fresh proof', async () => {
    const { gateway, calls } = harness([NONCE_PLEASE('n7'), answer(200, RECORDED)]);
    expect((await gateway.receipt(SCROBBLE_ID)).kind).toBe('ok');
    expect(calls).toHaveLength(2);
    const second = await proofClaims(calls[1]?.headers.get('dpop') ?? null);
    expect([second.payload.nonce, second.payload.htm]).toEqual(['n7', 'GET']);
  });

  test('asked for a nonce twice → unavailable, no third request', async () => {
    const { gateway, calls } = harness([
      NONCE_PLEASE('n7'),
      NONCE_PLEASE('n8'),
      answer(200, RECORDED),
    ]);
    expect(await gateway.receipt(SCROBBLE_ID)).toEqual({
      kind: 'unavailable',
      detail: 'nonce_refused',
    });
    expect(calls).toHaveLength(2);
  });

  test.each([
    ['a path', '../../v1/me'],
    ['a query', `${SCROBBLE_ID.slice(0, 20)}?x=1`],
    ['a UUID (the server decodes 26-character ids only)', PLAY_ID],
    ['too long', `${SCROBBLE_ID}0`],
    ['a first character over 7 (more than 128 bits)', `8${SCROBBLE_ID.slice(1)}`],
    ['empty', ''],
  ])(
    'a stored id that is %s is no receipt the server has: not_found, nothing sent',
    async (_n, id) => {
      const { gateway, calls } = harness([answer(200, RECORDED)]);
      expect(await gateway.receipt(id)).toEqual({ kind: 'not_found' });
      expect(calls).toHaveLength(0);
    },
  );

  test('no credential stored → credential_invalid, nothing sent', async () => {
    const { gateway, calls } = harness([], { signer: null });
    expect(await gateway.receipt(SCROBBLE_ID)).toEqual({ kind: 'credential_invalid' });
    expect(calls).toHaveLength(0);
  });

  test('a broken key → credential_invalid, nothing sent', async () => {
    const { gateway, calls } = harness([], { signerDeps: { jwk: otherJwk } });
    expect(await gateway.receipt(SCROBBLE_ID)).toEqual({ kind: 'credential_invalid' });
    expect(calls).toHaveLength(0);
  });

  test('the DPoP-Nonce of a receipt answer is kept', async () => {
    const { gateway, nonces } = harness([answer(200, RECORDED, { 'DPoP-Nonce': 'from-receipt' })]);
    await gateway.receipt(SCROBBLE_ID);
    expect(await nonces.get()).toBe('from-receipt');
  });
});

// The route as the backend documents it (`getIntegrationConnection`,
// `IntegrationConnectionResponse`): `200 {status, created_at, expires_at}`,
// revoked or expired → `401 scrobbling.credential_invalid`, the plays route's credential and proof.
describe('check: GET /v1/integrations/connection', () => {
  const CONNECTION_URL = 'https://api.example/v1/integrations/connection';
  // The account the connection acts for, as the server writes one: opaque to the extension.
  const ACCOUNT_KEY = 'a1:9f2c4e1a7b3d5f60c8e2a4b6d1f3e5a7';
  // The route answers the account's two lines too: starts off (`null`) and the finish at 70 %,
  // the backend's defaults.
  const ACTIVE = {
    status: 'active',
    created_at: '2026-10-20T19:40:00Z',
    expires_at: '2027-01-18T19:40:00Z',
    start_threshold_percent: null,
    start_floor_seconds: 300,
    finish_threshold_percent: 70,
    account_key: ACCOUNT_KEY,
  };

  test('a GET of the route, signed for that URL, with no body and no Idempotency-Key', async () => {
    const { gateway, calls } = harness([answer(200, ACTIVE)]);
    expect(await gateway.check()).toEqual({
      kind: 'ok',
      accountKey: ACCOUNT_KEY,
      status: 'active',
      expiresAt: Date.UTC(2027, 0, 18, 19, 40),
      rule: DEFAULT_RULE,
    });
    const [call] = calls;
    expect(call?.url).toBe(CONNECTION_URL);
    expect(call?.method).toBe('GET');
    expect(call?.body).toBeNull();
    expect(call?.headers.has('idempotency-key')).toBe(false);
    expect(call?.headers.get('authorization')).toBe(`DPoP ${TOKEN}`);
    const { payload } = await proofClaims(call?.headers.get('dpop') ?? null);
    expect([payload.htm, payload.htu, payload.ath]).toEqual([
      'GET',
      CONNECTION_URL,
      await athOf(TOKEN),
    ]);
  });

  test.each<[string, Step, Awaited<ReturnType<ReturnType<typeof harness>['gateway']['check']>>]>([
    [
      '200 braked, with microseconds and an offset (as FastAPI writes a datetime)',
      answer(200, { ...ACTIVE, status: 'braked', expires_at: '2027-01-18T21:40:00.123456+02:00' }),
      {
        kind: 'ok',
        accountKey: ACCOUNT_KEY,
        status: 'braked',
        expiresAt: Date.UTC(2027, 0, 18, 19, 40, 0, 123),
        rule: DEFAULT_RULE,
      },
    ],
    [
      '200 suspended, with no end (expires_at null)',
      answer(200, { ...ACTIVE, status: 'suspended', expires_at: null }),
      {
        kind: 'ok',
        accountKey: ACCOUNT_KEY,
        status: 'suspended',
        expiresAt: null,
        rule: DEFAULT_RULE,
      },
    ],
    [
      '200 with starts at 10 % and the finish at 90 %: the rule as stated',
      answer(200, { ...ACTIVE, start_threshold_percent: 10, finish_threshold_percent: 90 }),
      {
        kind: 'ok',
        accountKey: ACCOUNT_KEY,
        status: 'active',
        expiresAt: Date.UTC(2027, 0, 18, 19, 40),
        rule: { startThresholdPercent: 10, startFloorSeconds: 300, finishThresholdPercent: 90 },
      },
    ],
    [
      '200 without the rule: an answer, the never-read rule, the fields named',
      answer(200, {
        status: 'active',
        created_at: ACTIVE.created_at,
        expires_at: ACTIVE.expires_at,
        account_key: ACCOUNT_KEY,
      }),
      {
        kind: 'ok',
        accountKey: ACCOUNT_KEY,
        status: 'active',
        expiresAt: Date.UTC(2027, 0, 18, 19, 40),
        rule: DEFAULT_RULE,
        ruleInvalid: ['start_threshold_percent', 'start_floor_seconds', 'finish_threshold_percent'],
      },
    ],
    [
      '200 with a finish line out of bounds: the server’s default, the field named',
      answer(200, { ...ACTIVE, start_threshold_percent: 10, finish_threshold_percent: 0 }),
      {
        kind: 'ok',
        accountKey: ACCOUNT_KEY,
        status: 'active',
        expiresAt: Date.UTC(2027, 0, 18, 19, 40),
        rule: { startThresholdPercent: 10, startFloorSeconds: 300, finishThresholdPercent: 70 },
        ruleInvalid: ['finish_threshold_percent'],
      },
    ],
    [
      '200 with a threshold out of bounds: starts off, the field named',
      answer(200, { ...ACTIVE, start_threshold_percent: 150 }),
      {
        kind: 'ok',
        accountKey: ACCOUNT_KEY,
        status: 'active',
        expiresAt: Date.UTC(2027, 0, 18, 19, 40),
        rule: DEFAULT_RULE,
        ruleInvalid: ['start_threshold_percent'],
      },
    ],
    [
      '200 with a floor that is not whole seconds: starts off, the field named',
      answer(200, { ...ACTIVE, start_threshold_percent: 10, start_floor_seconds: 1.5 }),
      {
        kind: 'ok',
        accountKey: ACCOUNT_KEY,
        status: 'active',
        expiresAt: Date.UTC(2027, 0, 18, 19, 40),
        rule: DEFAULT_RULE,
        ruleInvalid: ['start_floor_seconds'],
      },
    ],
    // The route's enum names these, and never answers them to a credential that can ask: they
    // are no answer, never a status.
    // Without the account it acts for nothing may be sent: an answer that does not name one
    // is no answer.
    [
      '200 without account_key (an older server)',
      answer(200, { ...ACTIVE, account_key: undefined }),
      { kind: 'unavailable', detail: 'http_200_unreadable' },
    ],
    [
      '200 with an empty account_key',
      answer(200, { ...ACTIVE, account_key: '' }),
      { kind: 'unavailable', detail: 'http_200_unreadable' },
    ],
    [
      '200 with an account_key that is not a string',
      answer(200, { ...ACTIVE, account_key: 7 }),
      { kind: 'unavailable', detail: 'http_200_unreadable' },
    ],
    [
      '200 revoked',
      answer(200, { ...ACTIVE, status: 'revoked' }),
      { kind: 'unavailable', detail: 'http_200_unreadable' },
    ],
    [
      '200 awaiting_binding',
      answer(200, { ...ACTIVE, status: 'awaiting_binding' }),
      { kind: 'unavailable', detail: 'http_200_unreadable' },
    ],
    [
      '200 with an expiry that is not a date',
      answer(200, { ...ACTIVE, expires_at: 'soon' }),
      { kind: 'unavailable', detail: 'http_200_unreadable' },
    ],
    [
      '200 with an expiry without an offset (a local time names no instant)',
      answer(200, { ...ACTIVE, expires_at: '2027-01-18T19:40:00' }),
      { kind: 'unavailable', detail: 'http_200_unreadable' },
    ],
    [
      '200 without expires_at (the field is required)',
      answer(200, { status: 'active', created_at: ACTIVE.created_at }),
      { kind: 'unavailable', detail: 'http_200_unreadable' },
    ],
    [
      '200 that is not JSON',
      new Response('<html>', { status: 200 }),
      { kind: 'unavailable', detail: 'http_200_unreadable' },
    ],
    ['401 credential_invalid', CREDENTIAL_INVALID(), { kind: 'credential_invalid' }],
    // Only the route's own 401 ends a connection: anything else is no answer.
    [
      '401 another code',
      refusal(401, 'auth.token_invalid'),
      { kind: 'unavailable', detail: 'http_401' },
    ],
    [
      '404 in the envelope (the feature closed)',
      refusal(404, 'resource.not_found'),
      { kind: 'unavailable', detail: 'http_404' },
    ],
    [
      '404 with no body',
      new Response(null, { status: 404 }),
      { kind: 'unavailable', detail: 'http_404' },
    ],
    [
      '403 HTML from a WAF',
      new Response('<html>403</html>', { status: 403 }),
      { kind: 'unavailable', detail: 'http_403' },
    ],
    [
      '429',
      refusal(429, 'rate_limit.exceeded', { retry_after_seconds: 5 }),
      { kind: 'unavailable', detail: 'http_429' },
    ],
    ['503', refusal(503, 'service.overloaded'), { kind: 'unavailable', detail: 'http_503' }],
    [
      'a network error',
      new TypeError('Failed to fetch'),
      { kind: 'unavailable', detail: 'network:TypeError' },
    ],
  ])('%s', async (_name, step, expected) => {
    const { gateway, calls } = harness([step]);
    expect(await gateway.check()).toEqual(expected);
    expect(calls).toHaveLength(1);
  });

  test('401 dpop_nonce_required → one retry, its proof carrying the handed-over nonce', async () => {
    const { gateway, calls } = harness([NONCE_PLEASE('n9'), answer(200, ACTIVE)]);
    expect((await gateway.check()).kind).toBe('ok');
    expect(calls).toHaveLength(2);
    const second = await proofClaims(calls[1]?.headers.get('dpop') ?? null);
    expect([second.payload.nonce, second.payload.htm]).toEqual(['n9', 'GET']);
  });

  test('asked for a nonce twice → unavailable, no third request', async () => {
    const { gateway, calls } = harness([
      NONCE_PLEASE('n9'),
      NONCE_PLEASE('n10'),
      answer(200, ACTIVE),
    ]);
    expect(await gateway.check()).toEqual({ kind: 'unavailable', detail: 'nonce_refused' });
    expect(calls).toHaveLength(2);
  });

  test('no credential stored → credential_invalid, nothing sent', async () => {
    const { gateway, calls } = harness([], { signer: null });
    expect(await gateway.check()).toEqual({ kind: 'credential_invalid' });
    expect(calls).toHaveLength(0);
  });

  test('a broken key → credential_invalid, nothing sent', async () => {
    const { gateway, calls } = harness([], { signerDeps: { jwk: otherJwk } });
    expect(await gateway.check()).toEqual({ kind: 'credential_invalid' });
    expect(calls).toHaveLength(0);
  });

  test('a personal token asks as Bearer, with no proof', async () => {
    const { gateway, calls } = harness([answer(200, ACTIVE)], {
      signer: bearerSigner('mts_pat_abc123'),
    });
    expect((await gateway.check()).kind).toBe('ok');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer mts_pat_abc123');
    expect(calls[0]?.headers.has('dpop')).toBe(false);
  });

  test('a 15 s timeout → unavailable', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const { gateway, calls } = harness([hangsUntilAborted]);
    const pending = gateway.check();
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    controller.abort(new DOMException('signal timed out', 'TimeoutError'));
    expect(await pending).toEqual({ kind: 'unavailable', detail: 'timeout' });
  });

  test('the DPoP-Nonce of its answer is kept', async () => {
    const { gateway, nonces } = harness([answer(200, ACTIVE, { 'DPoP-Nonce': 'from-check' })]);
    await gateway.check();
    expect(await nonces.get()).toBe('from-check');
  });
});

describe('a nonce store that fails costs a retry, never an answer', () => {
  test('a signer whose onAnswer rejects, or throws, still answers', async () => {
    const rejects: RequestSigner = {
      headers: () => Promise.resolve({ Authorization: 'Bearer mts_pat_abc' }),
      onAnswer: () => Promise.reject(new Error('storage is gone')),
    };
    const throws: RequestSigner = {
      headers: () => Promise.resolve({ Authorization: 'Bearer mts_pat_abc' }),
      onAnswer: () => {
        throw new Error('storage is gone');
      },
    };
    for (const signer of [rejects, throws]) {
      const { gateway } = harness(
        [answer(202, { scrobble_id: SCROBBLE_ID, state: 'received', reason: null })],
        { signer },
      );
      expect((await gateway.send(PLAY_ID, BODY)).kind).toBe('accepted');
    }
  });

  const broken: NonceStore = {
    get: () => Promise.reject(new Error('storage.session is gone')),
    set: () => Promise.reject(new Error('storage.session is gone')),
  };

  const received = () => answer(202, { scrobble_id: SCROBBLE_ID, state: 'received', reason: null });

  test('a DPoP signer over a store that cannot read or write still signs, and its nonce retry lands', async () => {
    // The store keeps nothing, but the retry signs with the nonce the answer handed over.
    const { gateway, calls } = harness([NONCE_PLEASE('n2'), received()], {
      signerDeps: { nonces: broken },
    });
    expect(await gateway.send(PLAY_ID, BODY)).toMatchObject({ kind: 'accepted' });
    expect(calls).toHaveLength(2);
    const first = await proofClaims(calls[0]?.headers.get('dpop') ?? null);
    const second = await proofClaims(calls[1]?.headers.get('dpop') ?? null);
    expect('nonce' in first.payload).toBe(false);
    expect(second.payload.nonce).toBe('n2');
  });

  test('the receipt read’s nonce retry lands over a broken store too', async () => {
    const recorded = { scrobble_id: SCROBBLE_ID, state: 'recorded', reason: null, title_id: null };
    const { gateway, calls } = harness([NONCE_PLEASE('n7'), answer(200, recorded)], {
      signerDeps: { nonces: broken },
    });
    expect((await gateway.receipt(SCROBBLE_ID)).kind).toBe('ok');
    expect(calls).toHaveLength(2);
    expect((await proofClaims(calls[1]?.headers.get('dpop') ?? null)).payload.nonce).toBe('n7');
  });

  test('the retry carries the handed-over nonce, not what the store answers', async () => {
    // A store that drops every write and keeps answering an old nonce.
    const stale: NonceStore = {
      get: () => Promise.resolve('stale'),
      set: () => Promise.resolve(),
    };
    const { gateway, calls } = harness([NONCE_PLEASE('n2'), received()], {
      signerDeps: { nonces: stale },
    });
    expect(await gateway.send(PLAY_ID, BODY)).toMatchObject({ kind: 'accepted' });
    const nonces = await Promise.all(
      calls.map(async (c) => (await proofClaims(c.headers.get('dpop') ?? null)).payload.nonce),
    );
    expect(nonces).toEqual(['stale', 'n2']);
  });

  test('a bearer signer ignores a handed-over nonce', async () => {
    expect(await bearerSigner('mts_pat_abc').headers('POST', PLAYS_URL, 'n2')).toEqual({
      Authorization: 'Bearer mts_pat_abc',
    });
  });
});
