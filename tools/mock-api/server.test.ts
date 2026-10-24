/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The mock against the extension's own protocol code (its real functions): a sign-in, a
// play and its receipt end to end, then every way the real server refuses that the mock
// mirrors, and every answer a `MockScript` can force. What the mock answers about the
// account (receipts, the connection read, the start and finish lines) is in
// server-account.test.ts.

import { CompactSign, base64url } from 'jose';
import { describe, expect, test, vi } from 'vitest';

import {
  createDpopProof,
  dpopSigner,
  errorCode,
  exchangeCode,
  generateDpopKey,
  memoryNonceStore,
  publicJwk,
} from '../../packages/api/src/index';
import type { PlayBody } from '../../packages/core/src/index';

import { startMockApi } from './server.ts';
import type { MockApi, MockScript } from './server.ts';
import {
  DAY,
  MINUTE,
  MT_ID,
  REDIRECT,
  SECOND,
  T0,
  approve,
  connect,
  film,
  newKey,
  useMockApi,
} from './test-client.ts';
import type { Approved, KeyPair } from './test-client.ts';

const start = useMockApi();

/** Waits (boundedly) for the mock to reach a state; asserts nothing about how long it took. */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}

describe('the flow, with the extension’s own functions', () => {
  test('approve → token (nonce retry) → play → 202 → receipt recorded after the clock moves', async () => {
    const mock = await start();
    const c = await connect(mock);
    // The token endpoint: the first proof carried no nonce and was answered 400 use_dpop_nonce.
    expect(c.seen.map((s) => [s.status, s.code])).toEqual([
      [400, 'scrobbling.dpop_nonce_required'],
      [200, null],
    ]);
    expect(c.seen.every((s) => s.nonce !== null)).toBe(true);
    expect(c.accessToken).toMatch(/^mts_ext_[0-9A-Za-z]{49}$/);

    const sent = await c.gateway.send(newKey(), film());
    if (sent.kind !== 'accepted') throw new Error(`not accepted: ${sent.kind}`);
    expect(sent.scrobbleId).toMatch(MT_ID);
    expect(sent.state).toBe('received');
    expect(mock.plays).toHaveLength(1);
    expect(mock.plays[0]?.evidence).toEqual(film());

    expect(await c.gateway.receipt(sent.scrobbleId ?? '')).toEqual({
      kind: 'ok',
      state: 'received',
      reason: null,
      titleId: null,
      questionKey: null,
    });
    mock.advance(5 * SECOND);
    const later = await c.gateway.receipt(sent.scrobbleId ?? '');
    expect(later).toMatchObject({ kind: 'ok', state: 'recorded', reason: null });
    expect(later.kind === 'ok' ? later.titleId : null).toMatch(MT_ID);
  });

  test('a replay under the same key answers the first answer, and stores nothing twice', async () => {
    const mock = await start();
    const c = await connect(mock);
    const key = newKey();
    const first = await c.gateway.send(key, film());
    const again = await c.gateway.send(key, film());
    expect(first.kind).toBe('accepted');
    expect(again).toEqual(first);
    expect(mock.plays).toHaveLength(1);
  });

  test('a body with an unknown field is a 422 naming it', async () => {
    const mock = await start();
    const c = await connect(mock);
    const odd = { ...film(), mood: 'cosy' } as unknown as PlayBody;
    expect(await c.gateway.send(newKey(), odd)).toEqual({
      kind: 'rejected',
      status: 422,
      code: 'validation.failed',
    });
    expect(mock.plays).toHaveLength(0);
  });

  test('a proof whose htu differs is a 401, with no nonce handed over', async () => {
    const mock = await start();
    const c = await connect(mock);
    const nonce = await c.nonces.get();
    for (const url of [
      `${mock.url}/v1/integrations/play`,
      `${mock.url.replace('127.0.0.1', 'localhost')}/v1/integrations/plays`,
      `https://${new URL(mock.url).host}/v1/integrations/plays`,
    ]) {
      const proof = await createDpopProof({
        pair: c.pair,
        jwk: c.jwk,
        method: 'POST',
        url,
        nonce,
        accessToken: c.accessToken,
        now: Date.now(),
        jti: newKey(),
      });
      const response = await fetch(`${mock.url}/v1/integrations/plays`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': newKey(),
          Authorization: `DPoP ${c.accessToken}`,
          DPoP: proof,
        },
        body: JSON.stringify(film()),
      });
      expect(response.status, url).toBe(401);
      expect(errorCode(await response.json())).toBe('scrobbling.credential_invalid');
      expect(response.headers.get('WWW-Authenticate')).toBe('Bearer, DPoP algs="ES256"');
      expect(response.headers.get('DPoP-Nonce')).toBeNull();
    }
    expect(mock.plays).toHaveLength(0);
  });
});

// ── hand-made proofs, for what the client's own code would never send ──────────────────────────

const encode = (value: unknown): string =>
  base64url.encode(new TextEncoder().encode(JSON.stringify(value)));

async function athOf(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return base64url.encode(new Uint8Array(digest));
}

/** A proof signed by `pair` with exactly the given header and claims. */
async function signed(
  pair: KeyPair,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): Promise<string> {
  return new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
    .setProtectedHeader(header as { alg: string })
    .sign(pair.privateKey);
}

/** POST a play with this proof under this credential; the answer's status, code and nonce. */
async function postWith(mock: MockApi, credential: string, proof: string, body = film()) {
  const response = await fetch(`${mock.url}/v1/integrations/plays`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': newKey(),
      Authorization: `DPoP ${credential}`,
      DPoP: proof,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    code: errorCode(await response.json()),
    nonce: response.headers.get('DPoP-Nonce'),
  };
}

describe('proofs the server refuses, the mock refuses', () => {
  test('a replayed jti, a thief’s own key and every hostile shape are 401 credential_invalid', async () => {
    const mock = await start();
    const c = await connect(mock);
    const nonce = (await c.nonces.get()) ?? '';
    const htu = `${mock.url}/v1/integrations/plays`;
    const claims = {
      jti: newKey(),
      htm: 'POST',
      htu,
      iat: Math.floor(Date.now() / 1000),
      nonce,
      ath: await athOf(c.accessToken),
    };
    const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: c.jwk };
    const good = await signed(c.pair, header, claims);
    expect((await postWith(mock, c.accessToken, good)).status).toBe(202);
    // The same proof again: its jti is single use.
    expect(await postWith(mock, c.accessToken, good)).toEqual({
      status: 401,
      code: 'scrobbling.credential_invalid',
      nonce: null,
    });

    const thief = await generateDpopKey();
    const thiefJwk = await publicJwk(thief);
    const fresh = () => ({ ...claims, jti: newKey() });
    const hostile: Record<string, string> = {
      'a thief’s key, no nonce': await signed(
        thief,
        { ...header, jwk: thiefJwk },
        { ...fresh(), nonce: undefined },
      ),
      'a thief’s key': await signed(thief, { ...header, jwk: thiefJwk }, fresh()),
      'alg none': `${encode({ typ: 'dpop+jwt', alg: 'none', jwk: c.jwk })}.${encode(fresh())}.`,
      'typ JWT': await signed(c.pair, { ...header, typ: 'JWT' }, fresh()),
      'a private jwk': await signed(c.pair, { ...header, jwk: { ...c.jwk, d: c.jwk.x } }, fresh()),
      'htm GET': await signed(c.pair, header, { ...fresh(), htm: 'GET' }),
      'no iat': await signed(c.pair, header, { ...fresh(), iat: undefined }),
      'iat a string': await signed(c.pair, header, { ...fresh(), iat: '1' }),
      'a short jti': await signed(c.pair, header, { ...fresh(), jti: 'short' }),
      'a wrong ath': await signed(c.pair, header, { ...fresh(), ath: claims.jti }),
      'no ath': await signed(c.pair, header, { ...fresh(), ath: undefined }),
      'a tampered payload': `${good.split('.')[0] ?? ''}.${encode(fresh())}.${good.split('.')[2] ?? ''}`,
      'four segments': `${good}.x`,
      'over 4096 characters': await signed(c.pair, header, { ...fresh(), pad: 'x'.repeat(4096) }),
    };
    for (const [name, proof] of Object.entries(hostile)) {
      expect(await postWith(mock, c.accessToken, proof), name).toEqual({
        status: 401,
        code: 'scrobbling.credential_invalid',
        nonce: null,
      });
    }
    const hs256 = await new CompactSign(new TextEncoder().encode(JSON.stringify(fresh())))
      .setProtectedHeader({ typ: 'dpop+jwt', alg: 'HS256', jwk: c.jwk })
      .sign(new TextEncoder().encode(c.jwk.x));
    expect((await postWith(mock, c.accessToken, hs256)).status).toBe(401);
    expect(mock.plays).toHaveLength(1);
  });

  test('what the server normalises away in an htu is accepted: case, default port, query', async () => {
    const mock = await start();
    const c = await connect(mock);
    const nonce = (await c.nonces.get()) ?? '';
    const { host, port } = new URL(mock.url);
    for (const htu of [
      `HTTP://${host}/v1/integrations/plays`,
      `http://${host}/v1/integrations/plays?ignored=1#and-this`,
      `http://user:pass@${host}/v1/integrations/plays`,
      `http://127.0.0.1:${port}/v1/integrations/plays`,
    ]) {
      const proof = await signed(
        c.pair,
        { typ: 'dpop+jwt', alg: 'ES256', jwk: c.jwk },
        {
          jti: newKey(),
          htm: 'POST',
          htu,
          iat: 1,
          nonce,
          ath: await athOf(c.accessToken),
        },
      );
      expect((await postWith(mock, c.accessToken, proof)).status, htu).toBe(202);
    }
  });

  test('a stale nonce is a 401 dpop_nonce_required with a fresh one, and the retry lands', async () => {
    const mock = await start();
    const c = await connect(mock);
    mock.advance(11 * MINUTE);
    const sent = await c.gateway.send(newKey(), film(T0 + 8 * MINUTE));
    expect(sent.kind).toBe('accepted');
    expect(c.seen.slice(-2).map((s) => [s.status, s.code])).toEqual([
      [401, 'scrobbling.dpop_nonce_required'],
      [202, null],
    ]);
  });

  test('a credential presented as a bearer, or unknown, is 401; the 31st failure a minute is 429', async () => {
    const mock = await start();
    const c = await connect(mock);
    const bearer = await fetch(`${mock.url}/v1/integrations/plays`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': newKey(),
        Authorization: `Bearer ${c.accessToken}`,
      },
      body: JSON.stringify(film()),
    });
    expect(bearer.status).toBe(401);
    for (let i = 2; i <= 30; i++) {
      const response = await fetch(`${mock.url}/v1/integrations/plays/${'0'.repeat(26)}`, {
        headers: { Authorization: 'DPoP mts_ext_nope' },
      });
      expect(response.status).toBe(401);
    }
    const over = await fetch(`${mock.url}/v1/integrations/plays`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': newKey() },
      body: JSON.stringify(film()),
    });
    // The plays door's failure bucket is its own: 29 receipt failures did not spend it.
    expect(over.status).toBe(401);
    const receiptOver = await fetch(`${mock.url}/v1/integrations/plays/${'0'.repeat(26)}`);
    expect(receiptOver.status).toBe(401);
    const thirtyFirst = await fetch(`${mock.url}/v1/integrations/plays/${'0'.repeat(26)}`);
    expect(thirtyFirst.status).toBe(429);
    const body = (await thirtyFirst.json()) as { error: { retry_after_seconds: number } };
    expect(body.error.retry_after_seconds).toBeGreaterThanOrEqual(1);
    mock.advance(MINUTE);
    const afterWindow = await fetch(`${mock.url}/v1/integrations/plays/${'0'.repeat(26)}`);
    expect(afterWindow.status).toBe(401);
  });
});

describe('the error envelope, as the server’s', () => {
  test('code, message and request_id; details and retry_after_seconds only when they say something', async () => {
    const mock = await start();
    const unknown = await fetch(`${mock.url}/v1/integrations/plays/${'0'.repeat(26)}`);
    const body = (await unknown.json()) as { error: Record<string, unknown> };
    expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'request_id']);
    expect(body.error.request_id).toBe(unknown.headers.get('X-Request-Id'));
    expect(unknown.headers.get('Cache-Control')).toBe('no-store');

    const big = await fetch(`${mock.url}/v1/integrations/plays`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'x'.repeat(16 * 1024 + 1),
    });
    const tooLarge = (await big.json()) as { error: Record<string, unknown> };
    expect(Object.keys(tooLarge.error).sort()).toEqual([
      'code',
      'details',
      'message',
      'request_id',
    ]);
  });

  test('a path no route takes, and a method its route does not, answer http.error', async () => {
    const mock = await start();
    const missing = await fetch(`${mock.url}/v1/integrations/elsewhere`);
    expect(missing.status).toBe(404);
    expect(errorCode(await missing.json())).toBe('http.error');
    const wrongMethod = await fetch(`${mock.url}/v1/integrations/plays`);
    expect(wrongMethod.status).toBe(405);
    // A write is gated by its key before routing, as the idempotency layer runs first.
    const write = await fetch(`${mock.url}/v1/integrations/elsewhere`, { method: 'POST' });
    expect(write.status).toBe(400);
    expect(errorCode(await write.json())).toBe('idempotency.key_required');
  });
});

describe('the idempotency layer, as the server’s', () => {
  test('same key + different body → 422 body_mismatch; missing → 400; not a UUID → 400', async () => {
    const mock = await start();
    const c = await connect(mock);
    const key = newKey();
    expect((await c.gateway.send(key, film())).kind).toBe('accepted');
    expect(await c.gateway.send(key, { ...film(), title: 'Dune: Part Two' })).toEqual({
      kind: 'rejected',
      status: 422,
      code: 'idempotency.body_mismatch',
    });
    for (const [header, code] of [
      [null, 'idempotency.key_required'],
      ['   ', 'idempotency.key_required'],
      ['not-a-uuid', 'idempotency.key_malformed'],
    ] as const) {
      const response = await fetch(`${mock.url}/v1/integrations/plays`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(header === null ? {} : { 'Idempotency-Key': header }),
        },
        body: JSON.stringify(film()),
      });
      expect(response.status).toBe(400);
      expect(errorCode(await response.json())).toBe(code);
    }
  });

  test('a retry that only changes its key’s spelling meets the claim: 409 already_applied', async () => {
    const mock = await start();
    const c = await connect(mock);
    const key = newKey();
    expect((await c.gateway.send(key, film())).kind).toBe('accepted');
    // The record is kept under the key as sent, the claim under the canonical UUID.
    expect(await c.gateway.send(key.toUpperCase(), film())).toEqual({ kind: 'already_applied' });
    expect(mock.plays).toHaveLength(1);
  });

  test('a second request while the first holds the key is 409 in_flight', async () => {
    const mock = await start({ script: { plays: ['hang'] } });
    const c = await connect(mock);
    const key = newKey();
    const abort = new AbortController();
    const signer = dpopSigner({
      pair: c.pair,
      jwk: c.jwk,
      accessToken: c.accessToken,
      nonces: c.nonces,
      now: () => Date.now(),
      jti: newKey,
    });
    const url = `${mock.url}/v1/integrations/plays`;
    const first = fetch(url, {
      method: 'POST',
      signal: abort.signal,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        ...(await signer.headers('POST', url)),
      },
      body: JSON.stringify(film()),
    }).catch(() => 'aborted');
    // The hanging request holds the key once the mock holds the request.
    await until(() => mock.held === 1);
    expect(await c.gateway.send(key, film())).toEqual({ kind: 'in_flight' });
    abort.abort();
    expect(await first).toBe('aborted');
    // The client went away: the lock is released and the same key now lands.
    await until(() => mock.held === 0);
    expect((await c.gateway.send(key, film())).kind).toBe('accepted');
    expect(mock.plays).toHaveLength(1);
  });

  test('a lock outlives no client: past its 45 s the key runs again', async () => {
    const mock = await start({ script: { plays: ['hang'] } });
    const c = await connect(mock);
    const key = newKey();
    const signer = dpopSigner({
      pair: c.pair,
      jwk: c.jwk,
      accessToken: c.accessToken,
      nonces: c.nonces,
      now: () => Date.now(),
      jti: newKey,
    });
    const url = `${mock.url}/v1/integrations/plays`;
    const abort = new AbortController();
    const first = fetch(url, {
      method: 'POST',
      signal: abort.signal,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        ...(await signer.headers('POST', url)),
      },
      body: JSON.stringify(film()),
    }).catch(() => 'aborted');
    await until(() => mock.held === 1);
    mock.advance(45 * 1000);
    expect((await c.gateway.send(key, film())).kind).toBe('accepted');
    abort.abort();
    await first;
  });
});

describe('the body and the evidence', () => {
  test('a body over 16 KiB is 413 before anything is read or authenticated', async () => {
    const mock = await start();
    const response = await fetch(`${mock.url}/v1/integrations/plays`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'movie', title: 'x'.repeat(17 * 1024) }),
    });
    expect(response.status).toBe(413);
    expect(response.headers.get('Connection')).toBe('close');
    expect(await response.json()).toMatchObject({
      error: { code: 'request.body_too_large', details: { max_bytes: 16384 } },
    });
  });

  test('watched_at: 30 days back lands, a second more is out of range, no offset is a 422', async () => {
    const mock = await start();
    const c = await connect(mock);
    expect((await c.gateway.send(newKey(), film(T0 - 30 * DAY))).kind).toBe('accepted');
    expect((await c.gateway.send(newKey(), film(T0 + DAY))).kind).toBe('accepted');
    expect(await c.gateway.send(newKey(), film(T0 - 30 * DAY - SECOND))).toEqual({
      kind: 'rejected',
      status: 422,
      code: 'scrobbling.watched_at_out_of_range',
    });
    expect(await c.gateway.send(newKey(), film(T0 + DAY + SECOND))).toMatchObject({
      code: 'scrobbling.watched_at_out_of_range',
    });
    expect(
      await c.gateway.send(newKey(), { ...film(), watched_at: '2026-10-21T11:00:00' }),
    ).toEqual({ kind: 'rejected', status: 422, code: 'validation.failed' });
  });

  test('hostile JSON: __proto__, invalid JSON, a deep array — 422, nothing polluted', async () => {
    const mock = await start();
    const c = await connect(mock);
    const nonce = (await c.nonces.get()) ?? '';
    const url = `${mock.url}/v1/integrations/plays`;
    const send = async (body: string) => {
      const signer = dpopSigner({
        pair: c.pair,
        jwk: c.jwk,
        accessToken: c.accessToken,
        nonces: memoryNonceStore(),
        now: () => Date.now(),
        jti: newKey,
      });
      await signer.onAnswer(new Headers({ 'DPoP-Nonce': nonce }));
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': newKey(),
          ...(await signer.headers('POST', url)),
        },
        body,
      });
      return { status: response.status, json: (await response.json()) as unknown };
    };
    const polluted = await send('{"__proto__": {"polluted": true}, "kind": "movie", "title": "x"}');
    expect(polluted.status).toBe(422);
    expect(polluted.json).toMatchObject({
      error: { details: { errors: [{ loc: ['body', '__proto__'], type: 'extra_forbidden' }] } },
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const invalid = await send('{"kind": "movie",');
    expect(invalid).toMatchObject({
      status: 422,
      json: { error: { code: 'validation.failed' } },
    });
    const deep = await send(`${'['.repeat(5000)}${']'.repeat(5000)}`);
    expect(deep.status).toBe(422);
    expect(JSON.stringify(deep.json)).not.toContain('[[[');
    expect(mock.plays).toHaveLength(0);
  });
});

describe('the token endpoint, as the server’s', () => {
  test('a code is single use, lives 60 s, and is bound to its verifier and its key', async () => {
    const mock = await start();
    const exchange = (a: Approved, over: Partial<Approved> = {}) =>
      exchangeCode(
        {
          fetch,
          apiBase: mock.url,
          pair: over.pair ?? a.pair,
          jwk: over.jwk ?? a.jwk,
          nonces: memoryNonceStore(),
          now: () => Date.now(),
          jti: newKey,
        },
        {
          code: over.code ?? a.code,
          verifier: over.verifier ?? a.verifier,
          redirectUri: REDIRECT,
        },
      );
    const a = await approve(mock);
    const other = await generateDpopKey();
    // Refusals spend nothing: the right exchange still succeeds after them.
    expect((await exchange(a, { verifier: 'v'.repeat(43) })).kind).toBe('code_invalid');
    expect((await exchange(a, { pair: other, jwk: await publicJwk(other) })).kind).toBe(
      'code_invalid',
    );
    expect((await exchange(a)).kind).toBe('token');
    expect((await exchange(a)).kind).toBe('code_invalid');

    const late = await approve(mock);
    mock.advance(60 * SECOND);
    expect((await exchange(late)).kind).toBe('code_invalid');
  });

  test('the eleventh live connection is 409 scrobbler_limit_reached', async () => {
    const mock = await start();
    for (let i = 0; i < 10; i++) await connect(mock);
    const a = await approve(mock);
    const result = await exchangeCode(
      {
        fetch,
        apiBase: mock.url,
        pair: a.pair,
        jwk: a.jwk,
        nonces: memoryNonceStore(),
        now: () => Date.now(),
        jti: newKey,
      },
      { code: a.code, verifier: a.verifier, redirectUri: REDIRECT },
    );
    expect(result.kind).toBe('limit_reached');
  });
});

describe('the approval page', () => {
  const query = (over: Record<string, string> = {}) =>
    new URLSearchParams({
      client: 'chrome_extension',
      redirect_uri: REDIRECT,
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      dpop_jkt: '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I',
      state: 'af0ifjsldkj',
      ...over,
    }).toString();

  test('renders one Approve button and redirects only to the redirect it was given', async () => {
    const mock = await start();
    const page = await fetch(`${mock.url}/connect/extension?${query()}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    const html = await page.text();
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('<form method="post">');

    const approved = await fetch(`${mock.url}/connect/extension?${query()}`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(approved.status).toBe(303);
    const location = new URL(approved.headers.get('Location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get('state')).toBe('af0ifjsldkj');
    expect(location.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('never redirects anywhere else, and renders no query value', async () => {
    const mock = await start();
    const hostile = '"><script>alert(1)</script>';
    const ok = await fetch(`${mock.url}/connect/extension?${query({ state: hostile })}`);
    expect(ok.status).toBe(200);
    const html = await ok.text();
    for (const needle of ['<script', 'alert', 'af0ifjsldkj', REDIRECT, 'E9Melhoa']) {
      expect(html, needle).not.toContain(needle);
    }
    for (const redirect of [
      'https://evil.example/',
      'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org.evil.example/',
      'https://ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP.chromiumapp.org/',
      'https://abcdefghijklmnopabcdefghijklmnoq.chromiumapp.org/',
      'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/x',
      'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/?next=https://evil.example/',
      'http://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/',
      '//evil.example/',
    ]) {
      for (const method of ['GET', 'POST']) {
        const response = await fetch(
          `${mock.url}/connect/extension?${query({ redirect_uri: redirect })}`,
          { method, redirect: 'manual' },
        );
        expect(response.status, `${method} ${redirect}`).toBe(400);
        expect(response.headers.get('Location')).toBeNull();
        expect(await response.text()).not.toContain('evil');
      }
    }
    const twice = await fetch(
      `${mock.url}/connect/extension?${query()}&redirect_uri=${encodeURIComponent('https://evil.example/')}`,
      { method: 'POST', redirect: 'manual' },
    );
    expect(twice.status).toBe(400);
    expect(twice.headers.get('Location')).toBeNull();
  });

  test('/__test/approve takes the real approval body, and is shown once', async () => {
    const mock = await start();
    const body = {
      client: 'chrome_extension',
      redirect_uri: 'https://evil.example/',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      dpop_jkt: '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I',
      state: 'af0ifjsldkj',
      display_name: 'Test browser',
    };
    const post = (value: unknown, key = newKey()) =>
      fetch(`${mock.url}/__test/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(value),
      });
    const refused = await post(body);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      error: { details: { field: 'redirect_uri', reason: 'not_allowed' } },
    });
    const noName = { ...body, redirect_uri: REDIRECT, display_name: undefined };
    expect((await post(noName)).status).toBe(422);
    const key = newKey();
    expect((await post({ ...body, redirect_uri: REDIRECT }, key)).status).toBe(200);
    const again = await post({ ...body, redirect_uri: REDIRECT }, key);
    expect(again.status).toBe(409);
    expect(errorCode(await again.json())).toBe('idempotency.already_applied');
  });
});

describe('MockScript forces every answer of the token endpoint and the plays route', () => {
  test.each([
    ['nonce_required', 'unavailable'],
    ['code_invalid', 'code_invalid'],
    ['proof_invalid', 'proof_invalid'],
    ['plus_required', 'forbidden'],
    ['session_not_fresh', 'forbidden'],
    ['limit_reached', 'limit_reached'],
    ['feature_closed', 'feature_closed'],
    ['rate_limited', 'unavailable'],
    ['unavailable', 'unavailable'],
    ['internal_error', 'unavailable'],
    ['drop', 'unavailable'],
  ] as const)('token: %s → %s', async (fault, kind) => {
    const mock = await start({ script: { token: [fault] } });
    const a = await approve(mock);
    const result = await exchangeCode(
      {
        fetch,
        apiBase: mock.url,
        pair: a.pair,
        jwk: a.jwk,
        nonces: memoryNonceStore(),
        now: () => Date.now(),
        jti: newKey,
      },
      { code: a.code, verifier: a.verifier, redirectUri: REDIRECT },
    );
    expect(result.kind).toBe(kind);
  });

  test.each([
    ['feature_closed', { kind: 'feature_closed' }],
    ['too_large', { kind: 'rejected', status: 413, code: 'request.body_too_large' }],
    ['in_flight', { kind: 'in_flight' }],
    ['already_applied', { kind: 'already_applied' }],
    ['body_mismatch', { kind: 'rejected', status: 422, code: 'idempotency.body_mismatch' }],
    ['credential_invalid', { kind: 'credential_invalid' }],
    ['rate_limited', { kind: 'rate_limited', retryAfterSeconds: 30 }],
    ['validation_failed', { kind: 'rejected', status: 422, code: 'validation.failed' }],
    [
      'watched_at_out_of_range',
      { kind: 'rejected', status: 422, code: 'scrobbling.watched_at_out_of_range' },
    ],
    ['unavailable', { kind: 'unavailable', detail: 'http_503' }],
    ['overloaded', { kind: 'unavailable', detail: 'http_503' }],
    ['internal_error', { kind: 'unavailable', detail: 'http_500' }],
    ['deadline', { kind: 'unavailable', detail: 'http_504' }],
    ['drop', { kind: 'unavailable', detail: 'network:TypeError' }],
  ] as const)('plays: %s', async (fault, expected) => {
    const mock = await start({ script: { plays: [fault] } });
    const c = await connect(mock);
    expect(await c.gateway.send(newKey(), film())).toEqual(expected);
    expect(mock.plays).toHaveLength(0);
  });

  test('plays: nonce_required is retried once with the nonce it hands over', async () => {
    const mock = await start({ script: { plays: ['nonce_required'] } });
    const c = await connect(mock);
    expect((await c.gateway.send(newKey(), film())).kind).toBe('accepted');
    mock.force({ plays: ['nonce_required', 'nonce_required'] });
    expect(await c.gateway.send(newKey(), film())).toEqual({
      kind: 'unavailable',
      detail: 'nonce_refused',
    });
  });

  test('plays: a lost answer was stored; the retry under its key is answered the first answer', async () => {
    const mock = await start({ script: { plays: ['lost_answer'] } });
    const c = await connect(mock);
    const key = newKey();
    expect(await c.gateway.send(key, film())).toEqual({
      kind: 'unavailable',
      detail: 'network:TypeError',
    });
    expect(mock.plays).toHaveLength(1);
    const retry = await c.gateway.send(key, film());
    expect(retry).toMatchObject({ kind: 'accepted', scrobbleId: mock.plays[0]?.scrobbleId });
  });

  test('plays: a play not kept, a raw answer and a wait the script names', async () => {
    const script: MockScript = {
      plays: [
        { fault: 'not_kept', state: 'dismissed', reason: 'revoked' },
        { fault: 'raw', status: 418, body: { teapot: true } },
        { fault: 'rate_limited', retryAfterSeconds: 7 },
      ],
    };
    const mock = await start({ script });
    const c = await connect(mock);
    expect(await c.gateway.send(newKey(), film())).toEqual({
      kind: 'accepted',
      scrobbleId: null,
      state: 'dismissed',
      reason: 'revoked',
    });
    // A 4xx without the server's envelope judged nothing about the play: retried.
    expect(await c.gateway.send(newKey(), film())).toEqual({
      kind: 'unavailable',
      detail: 'http_418',
    });
    expect(await c.gateway.send(newKey(), film())).toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: 7,
    });
    expect(mock.plays).toHaveLength(0);
  });

  test.each([
    ['feature_closed', { kind: 'not_found' }],
    ['credential_invalid', { kind: 'credential_invalid' }],
    ['not_found', { kind: 'not_found' }],
    // A receipt read that could not be made says why, as a send does.
    ['rate_limited', { kind: 'unavailable', detail: 'http_429' }],
    ['unavailable', { kind: 'unavailable', detail: 'http_503' }],
    ['internal_error', { kind: 'unavailable', detail: 'http_500' }],
    ['drop', { kind: 'unavailable', detail: 'network:TypeError' }],
  ] as const)('receipts: %s', async (fault, expected) => {
    const mock = await start();
    const c = await connect(mock);
    const sent = await c.gateway.send(newKey(), film());
    mock.force({ receipts: [fault] });
    const id = sent.kind === 'accepted' ? (sent.scrobbleId ?? '') : '';
    expect(await c.gateway.receipt(id)).toEqual(expected);
  });

  test('a progression the mock cannot honour is a 500 that leaves no trace behind', async () => {
    const mock = await start({ script: { progression: () => [] } });
    const c = await connect(mock);
    const key = newKey();
    const logged: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      logged.push(String(chunk));
      return true;
    });
    try {
      expect(await c.gateway.send(key, film())).toEqual({
        kind: 'unavailable',
        detail: 'http_500',
      });
    } finally {
      spy.mockRestore();
    }
    // The log names the error's kind, and nothing the request carried.
    expect(logged).toEqual(['mock-api: TypeError while answering a request\n']);
    expect(mock.plays).toHaveLength(0);
    // Nothing was claimed: the same key runs again once the progression is one.
    mock.force({ progression: () => [{ afterMs: 0, state: 'held', reason: 'braked' }] });
    expect(await c.gateway.send(key, film())).toMatchObject({
      kind: 'accepted',
      state: 'held',
      reason: 'braked',
    });
  });

  test('a script the mock cannot honour is refused when it is given', async () => {
    await expect(
      startMockApi({ port: 0, script: { plays: ['teapot' as 'drop'] } }),
    ).rejects.toThrow(TypeError);
    const mock = await start();
    expect(() => {
      mock.force({ plays: [{ fault: 'raw', status: 99 }] });
    }).toThrow(RangeError);
    expect(() => {
      mock.advance(-1);
    }).toThrow(RangeError);
  });
});
