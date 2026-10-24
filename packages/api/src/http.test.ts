/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  MAX_ANSWER_BYTES,
  MAX_ANSWER_READS,
  MAX_RETRY_AFTER_SECONDS,
  REQUEST_TIMEOUT_MS,
  apiUrl,
  asksForNonce,
  errorCode,
  request,
  retryAfter,
} from './http';
import type { HttpAnswer } from './http';
import { answer, hangsUntilAborted, refusal, scriptedFetch } from './testing/scripted-fetch';

const URL_ = 'https://api.example/v1/integrations/plays';

afterEach(() => {
  vi.restoreAllMocks();
});

/** `AbortSignal.timeout`, replaced by a signal the test aborts itself (no wall clock). */
function controlledTimeout() {
  const controller = new AbortController();
  const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  return {
    spy,
    signal: controller.signal,
    fire: () => {
      controller.abort(new DOMException('signal timed out', 'TimeoutError'));
    },
  };
}

function send(fetchStub: typeof fetch, over: Partial<Parameters<typeof request>[0]> = {}) {
  return request({
    fetch: fetchStub,
    url: URL_,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"kind":"movie"}',
    timeoutMs: REQUEST_TIMEOUT_MS,
    ...over,
  });
}

function asResponse(a: HttpAnswer) {
  if (a.kind !== 'response') throw new Error(`expected a response, got ${a.kind}`);
  return a;
}

describe('request', () => {
  test('hands fetch the method, headers and body, follows no redirect and sends no cookies', async () => {
    const timeout = controlledTimeout();
    const { fetch: stub, calls } = scriptedFetch([answer(202, { ok: true })]);
    const got = asResponse(await send(stub));
    expect(got.status).toBe(202);
    expect(got.json).toEqual({ ok: true });
    expect(got.headers.get('content-type')).toBe('application/json');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(URL_);
    expect(call?.method).toBe('POST');
    expect(call?.body).toBe('{"kind":"movie"}');
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(call?.init.redirect).toBe('error');
    expect(call?.init.credentials).toBe('omit');
    // The deadline is AbortSignal.timeout(15 000), and that signal is the request's.
    expect(timeout.spy).toHaveBeenCalledWith(15_000);
    expect(call?.init.signal).toBe(timeout.signal);
  });

  test('a GET sends no body', async () => {
    const { fetch: stub, calls } = scriptedFetch([answer(200, {})]);
    await request({ fetch: stub, url: URL_, method: 'GET', headers: {}, timeoutMs: 15_000 });
    expect(calls[0]?.method).toBe('GET');
    expect('body' in (calls[0]?.init ?? {})).toBe(false);
  });

  test('calls fetch unbound, as a browser requires (a bound call is "Illegal invocation")', async () => {
    const { fetch: stub } = scriptedFetch([answer(200, {})]);
    // The stub refuses any `this`: had request called `input.fetch(...)`, this would be a
    // network failure, not a response.
    expect((await send(stub)).kind).toBe('response');
  });

  test('the deadline firing before an answer is a timeout', async () => {
    const timeout = controlledTimeout();
    const { fetch: stub } = scriptedFetch([hangsUntilAborted]);
    const pending = send(stub);
    timeout.fire();
    expect(await pending).toEqual({ kind: 'timeout' });
  });

  test('the deadline firing while the body is still arriving is a timeout, not an answer', async () => {
    const timeout = controlledTimeout();
    // Headers and the first bytes arrive; the rest never does. A stub's Response is not wired
    // to the signal, so this proves request watches the deadline over the body itself.
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"scrobble_id":'));
      },
    });
    const { fetch: stub } = scriptedFetch([
      () => {
        setTimeout(timeout.fire, 0);
        return new Response(stalled, { status: 202 });
      },
    ]);
    expect(await send(stub)).toEqual({ kind: 'timeout' });
  });

  test('a body that fails in transit is a network failure, not an empty answer', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"scrob'));
        controller.error(new TypeError('terminated'));
      },
    });
    const { fetch: stub } = scriptedFetch([new Response(broken, { status: 202 })]);
    expect(await send(stub)).toEqual({ kind: 'network', detail: 'TypeError' });
  });

  test('a network failure says only its kind — never the message, which can carry the URL', async () => {
    const { fetch: stub } = scriptedFetch([
      new TypeError('fetch failed: https://api.example/v1/integrations/plays?token=secret'),
    ]);
    const got = await send(stub);
    expect(got).toEqual({ kind: 'network', detail: 'TypeError' });
    expect(JSON.stringify(got)).not.toContain('secret');
  });

  test('a rejection that is not an Error, or has an odd name, is still a network failure', async () => {
    const odd = Object.assign(new Error('x'), { name: 'Name with spaces / and a URL' });
    const { fetch: stub } = scriptedFetch([
      () => Promise.reject(new Error('plain')),
      odd,
      () => {
        // A fetch that throws synchronously, before returning a promise.
        throw new Error('sync');
      },
    ]);
    expect(await send(stub)).toEqual({ kind: 'network', detail: 'Error' });
    expect(await send(stub)).toEqual({ kind: 'network', detail: 'unknown' });
    expect(await send(stub)).toEqual({ kind: 'network', detail: 'Error' });
  });

  test('a body that is not JSON, or is empty, is json: null — status and headers still read', async () => {
    const { fetch: stub } = scriptedFetch([
      new Response('<html>Bad gateway</html>', { status: 502, headers: { 'DPoP-Nonce': 'n1' } }),
      new Response(null, { status: 204 }),
      new Response('', { status: 413 }),
    ]);
    const html = asResponse(await send(stub));
    expect([html.status, html.json, html.headers.get('dpop-nonce')]).toEqual([502, null, 'n1']);
    expect(asResponse(await send(stub)).json).toBeNull();
    expect(asResponse(await send(stub)).json).toBeNull();
  });

  test('reads at most MAX_ANSWER_BYTES of a body, then stops pulling (json: null)', async () => {
    const chunk = new Uint8Array(16 * 1024).fill(0x20);
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
    });
    const { fetch: stub } = scriptedFetch([new Response(endless, { status: 200 })]);
    const got = asResponse(await send(stub));
    expect(got.json).toBeNull();
    // The bound holds on the work done, not only on what is kept.
    expect(pulls).toBeLessThanOrEqual(MAX_ANSWER_BYTES / chunk.length + 2);
  });

  test('a stream of empty chunks is cut off by its reads, not its bytes (json: null)', async () => {
    let pulls = 0;
    const empty = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(0));
      },
    });
    const { fetch: stub } = scriptedFetch([new Response(empty, { status: 200 })]);
    expect(asResponse(await send(stub)).json).toBeNull();
    expect(pulls).toBeLessThanOrEqual(MAX_ANSWER_READS + 2);
  });

  test('a body in many small chunks is read whole', async () => {
    const text = JSON.stringify({ scrobble_id: null, state: 'held', reason: 'braked' });
    const bytes = new TextEncoder().encode(text);
    let at = 0;
    const trickle = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(at, at + 1));
        at += 1;
      },
    });
    const { fetch: stub } = scriptedFetch([new Response(trickle, { status: 202 })]);
    expect(asResponse(await send(stub)).json).toEqual(JSON.parse(text));
  });

  test('a body of exactly MAX_ANSWER_BYTES is read', async () => {
    const text = `"${'a'.repeat(MAX_ANSWER_BYTES - 2)}"`;
    const { fetch: stub } = scriptedFetch([new Response(text, { status: 200 })]);
    expect(asResponse(await send(stub)).json).toBe('a'.repeat(MAX_ANSWER_BYTES - 2));
  });
});

describe('the envelope readers are total', () => {
  test('errorCode reads error.code', () => {
    expect(errorCode({ error: { code: 'scrobbling.credential_invalid', message: 'x' } })).toBe(
      'scrobbling.credential_invalid',
    );
    expect(errorCode({ error: { code: 'plus_required' } })).toBe('plus_required');
  });

  test.each([
    ['null', null],
    ['a string', 'scrobbling.credential_invalid'],
    ['an array', [{ code: 'x' }]],
    ["FastAPI's HTTPValidationError (never sent; not the envelope)", { detail: [{ msg: 'x' }] }],
    ['error not an object', { error: 'scrobbling.credential_invalid' }],
    ['error an array', { error: ['x'] }],
    ['code not a string', { error: { code: 401 } }],
    ['code with a space', { error: { code: 'scrobbling credential' } }],
    ['code upper-case', { error: { code: 'Scrobbling.X' } }],
    ['code too long', { error: { code: `a${'b'.repeat(80)}` } }],
    ['code only on the prototype', JSON.parse('{"__proto__": {"error": {"code": "x"}}}')],
    ['error only on the prototype', Object.create({ error: { code: 'x' } }) as unknown],
  ])('errorCode of %s is null', (_name, json) => {
    expect(errorCode(json)).toBeNull();
  });

  test('retryAfter reads error.retry_after_seconds, bounded to the slowest outbox retry', () => {
    expect(retryAfter({ error: { code: 'rate_limit.exceeded', retry_after_seconds: 7 } })).toBe(7);
    expect(retryAfter({ error: { retry_after_seconds: 0 } })).toBe(0);
    expect(MAX_RETRY_AFTER_SECONDS).toBe(6 * 3600);
    expect(retryAfter({ error: { retry_after_seconds: 1e12 } })).toBe(MAX_RETRY_AFTER_SECONDS);
  });

  test.each([
    ['absent', { error: { code: 'rate_limit.exceeded' } }],
    ['negative', { error: { retry_after_seconds: -1 } }],
    ['a string', { error: { retry_after_seconds: '7' } }],
    ['not finite', { error: { retry_after_seconds: Number.POSITIVE_INFINITY } }],
    ['outside the envelope', { retry_after_seconds: 7 }],
    ['no body', null],
  ])('retryAfter %s is null', (_name, json) => {
    expect(retryAfter(json)).toBeNull();
  });

  test('asksForNonce: the code, or the OAuth error in details (RFC 9449 §8)', () => {
    expect(asksForNonce({ error: { code: 'scrobbling.dpop_nonce_required' } })).toBe(true);
    expect(asksForNonce({ error: { code: 'x.y', details: { error: 'use_dpop_nonce' } } })).toBe(
      true,
    );
    expect(asksForNonce({ error: { code: 'scrobbling.credential_invalid' } })).toBe(false);
    expect(asksForNonce({ error: { details: ['use_dpop_nonce'] } })).toBe(false);
    expect(asksForNonce({ details: { error: 'use_dpop_nonce' } })).toBe(false);
    expect(asksForNonce(null)).toBe(false);
  });
});

describe('apiUrl', () => {
  test('joins the configured base and a path, whatever trailing slashes the base has', () => {
    expect(apiUrl('https://api.example', '/v1/integrations/plays')).toBe(URL_);
    expect(apiUrl('https://api.example/', '/v1/integrations/plays')).toBe(URL_);
    expect(apiUrl('https://api.example///', '/v1/integrations/plays')).toBe(URL_);
    expect(apiUrl('http://localhost:8787', '/v1/x')).toBe('http://localhost:8787/v1/x');
  });

  test('a long run of slashes is trimmed in linear time', () => {
    const base = `https://api.example${'/'.repeat(100_000)}x${'/'.repeat(100_000)}`;
    expect(apiUrl(base, '/p').endsWith('x/p')).toBe(true);
  });
});

test('refusal() builds the server envelope the readers read (the fixtures are honest)', async () => {
  const res = refusal(429, 'rate_limit.exceeded', { retry_after_seconds: 3 });
  const json: unknown = await res.json();
  expect(errorCode(json)).toBe('rate_limit.exceeded');
  expect(retryAfter(json)).toBe(3);
});
