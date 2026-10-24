/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The store build's sign-in, driven through
// WXT's fake browser: `identity.launchWebAuthFlow` stands for Chrome's window and answers the
// redirect the web app's approval would, and a fake token endpoint answers the code exchange
// after checking what the API's token request is. Every test is a fresh worker: the module (and
// its one-flow mutex) is imported anew, over a fresh IndexedDB unless the test is about a restart.

import 'fake-indexeddb/auto';

import { FakeClock } from '@mt/core/testing';
import { memoryNonceStore } from '@mt/api';
import type { ConnectResult } from '@mt/core';
import { IDBFactory } from 'fake-indexeddb';
import { EmbeddedJWK, calculateJwkThumbprint, decodeProtectedHeader, jwtVerify } from 'jose';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { API_BASE_URL, WEB_APP_BASE_URL } from '../config';
import type { ChromePkceDpopDeps } from './auth-chrome';

/** Chrome's redirect for an extension: `https://<32 letters a–p>.chromiumapp.org/`. */
const REDIRECT = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/';
const T0 = Date.UTC(2026, 9, 22, 18, 0);
/** A credential minted with the backend's checksum. */
const ACCESS_TOKEN = 'mts_ext_ka7RCcRX83UbUVjedTTl7QxIK0rr56HqGWpj9MbfFw00RgoX0';
/** Ninety days, the server's sliding lifetime. */
const EXPIRES_IN = 90 * 24 * 3600;
/** Base64url without padding, as RFC 7636 and RFC 7638 write it. */
const B64URL_43 = /^[A-Za-z0-9_-]{43}$/u;

interface TokenCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly form: URLSearchParams;
}

/** The API's token endpoint: records each request and answers the DPoP-bound credential. */
function tokenEndpoint(answer: () => Promise<Response> = ok) {
  const calls: TokenCall[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const body = init?.body;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      form: new URLSearchParams(typeof body === 'string' ? body : (body as URLSearchParams)),
    });
    return answer();
  });
  return { fetch, calls };
}

function ok(): Promise<Response> {
  return Promise.resolve(
    new Response(
      JSON.stringify({ access_token: ACCESS_TOKEN, token_type: 'DPoP', expires_in: EXPIRES_IN }),
      { status: 200, headers: { 'Content-Type': 'application/json', 'DPoP-Nonce': 'nonce-1' } },
    ),
  );
}

/** What the approval window was opened with, and the redirect the fake answers. */
interface Window {
  readonly urls: URL[];
}

/** The web app approves: the redirect carries a code and the `state` it was given (RFC 6749). */
function approving(
  window: Window,
  stateOf: (url: URL) => string | null = (u) => u.searchParams.get('state'),
) {
  return vi.fn(({ url }: { url: string }) => {
    const opened = new URL(url);
    window.urls.push(opened);
    const back = new URL(REDIRECT);
    back.searchParams.set('code', 'c1');
    const state = stateOf(opened);
    if (state !== null) back.searchParams.set('state', state);
    return Promise.resolve(back.href);
  });
}

/** A new worker: its modules, its database handle, its strategy. */
async function worker(fetch: typeof globalThis.fetch, identity: ChromePkceDpopDeps['identity']) {
  vi.resetModules();
  const { ChromePkceDpopAuth, SessionFlowStore, discardInterruptedSignIn } =
    await import('./auth-chrome');
  const { IdbConnectionRepo } = await import('./connection-store');
  const { openDatabase } = await import('./idb');
  const db = await openDatabase();
  const connection = new IdbConnectionRepo(() => Promise.resolve(db));
  const flows = new SessionFlowStore(fakeBrowser.storage.session);
  const log = vi.fn(() => Promise.resolve());
  const auth = new ChromePkceDpopAuth({
    apiBase: API_BASE_URL,
    fetch,
    nonces: memoryNonceStore(),
    clock: new FakeClock(T0),
    credentials: connection,
    flows,
    redirectUri: () => REDIRECT,
    log,
    webBase: WEB_APP_BASE_URL,
    identity,
    keepAlive: () => Promise.resolve(),
  });
  return { auth, connection, flows, db, log, discardInterruptedSignIn };
}

async function sha256Base64url(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
});

describe('ChromePkceDpopAuth', () => {
  test('connects: a non-extractable key, bound to the thumbprint the approval carried', async () => {
    const window: Window = { urls: [] };
    fakeBrowser.identity.launchWebAuthFlow = approving(window);
    const server = tokenEndpoint();
    const { auth, connection } = await worker(server.fetch, fakeBrowser.identity);

    const result = await auth.connect();

    // Connected, expiring `expires_in` after the sign-in.
    expect(result).toEqual({
      kind: 'connected',
      state: {
        kind: 'connected',
        id: expect.any(String) as string,
        strategy: 'pkce_dpop',
        connectedAt: T0,
        expiresAt: T0 + EXPIRES_IN * 1000,
      },
    });
    expect(await connection.get()).toEqual(result.kind === 'connected' ? result.state : null);

    // One interactive window on the web app's approval page, with exactly the query the approval
    // page expects.
    expect(fakeBrowser.identity.launchWebAuthFlow).toHaveBeenCalledTimes(1);
    expect(fakeBrowser.identity.launchWebAuthFlow).toHaveBeenCalledWith(
      expect.objectContaining({ interactive: true }),
    );
    const opened = window.urls[0];
    if (opened === undefined) throw new Error('no window');
    expect(`${opened.origin}${opened.pathname}`).toBe(`${WEB_APP_BASE_URL}/connect/extension`);
    expect([...opened.searchParams.keys()].sort()).toEqual([
      'client',
      'code_challenge',
      'code_challenge_method',
      'dpop_jkt',
      'redirect_uri',
      'state',
    ]);
    expect(opened.searchParams.get('client')).toBe('chrome_extension');
    expect(opened.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(opened.searchParams.get('code_challenge_method')).toBe('S256');
    // A 32-byte random `state` (43 base64url characters).
    expect(opened.searchParams.get('state')).toMatch(B64URL_43);

    // The stored key is the one the approval named, and it cannot be exported.
    const stored = await connection.credential();
    const pair = stored?.pair ?? null;
    if (pair === null) throw new Error('no credential stored');
    expect(stored?.accessToken).toBe(ACCESS_TOKEN);
    expect(pair.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('jwk', pair.privateKey)).rejects.toThrow();
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    expect(publicJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    const { x = '', y = '' } = publicJwk;
    expect(opened.searchParams.get('dpop_jkt')).toBe(
      await calculateJwkThumbprint({ kty: 'EC', crv: 'P-256', x, y }),
    );

    // The code exchange: form-encoded, one DPoP proof by that key, no Idempotency-Key.
    expect(server.calls).toHaveLength(1);
    const call = server.calls[0];
    if (call === undefined) throw new Error('no token request');
    expect(call.url).toBe(`${API_BASE_URL}/v1/integrations/oauth/token`);
    expect(call.method).toBe('POST');
    expect(call.headers.get('Content-Type')).toMatch(/^application\/x-www-form-urlencoded/u);
    expect(call.headers.has('Idempotency-Key')).toBe(false);
    expect(call.form.get('grant_type')).toBe('authorization_code');
    expect(call.form.get('code')).toBe('c1');
    expect(call.form.get('redirect_uri')).toBe(REDIRECT);
    // RFC 7636 §4.6: the challenge the approval carried is S256 of the verifier sent here.
    const verifier = call.form.get('code_verifier') ?? '';
    expect(verifier).toMatch(B64URL_43);
    expect(opened.searchParams.get('code_challenge')).toBe(await sha256Base64url(verifier));
    // RFC 9449 §4: a proof of the stored key for exactly this request.
    const proof = call.headers.get('DPoP') ?? '';
    const header = decodeProtectedHeader(proof);
    expect(header.typ).toBe('dpop+jwt');
    expect(header.alg).toBe('ES256');
    expect(header.jwk).not.toHaveProperty('d');
    const { payload } = await jwtVerify(proof, EmbeddedJWK, {
      typ: 'dpop+jwt',
      algorithms: ['ES256'],
    });
    expect(payload.htm).toBe('POST');
    expect(payload.htu).toBe(`${API_BASE_URL}/v1/integrations/oauth/token`);
    expect(typeof payload.jti).toBe('string');
    expect(typeof payload.iat).toBe('number');
    expect(await calculateJwkThumbprint(header.jwk ?? {})).toBe(
      opened.searchParams.get('dpop_jkt'),
    );
  });

  test('a redirect with another `state` is cancelled, and nothing is stored or exchanged', async () => {
    const window: Window = { urls: [] };
    fakeBrowser.identity.launchWebAuthFlow = approving(window, () => 'not-the-flows-state');
    const server = tokenEndpoint();
    const { auth, connection } = await worker(server.fetch, fakeBrowser.identity);

    expect(await auth.connect()).toEqual({ kind: 'cancelled' });
    expect(await connection.get()).toEqual({ kind: 'none' });
    expect(await connection.credential()).toBeNull();
    expect(server.calls).toHaveLength(0);
  });

  test('a redirect without a `state` is cancelled too', async () => {
    const window: Window = { urls: [] };
    fakeBrowser.identity.launchWebAuthFlow = approving(window, () => null);
    const server = tokenEndpoint();
    const { auth, connection } = await worker(server.fetch, fakeBrowser.identity);

    expect(await auth.connect()).toEqual({ kind: 'cancelled' });
    expect(await connection.get()).toEqual({ kind: 'none' });
    expect(server.calls).toHaveLength(0);
  });

  test('a window closed by the person (a rejected flow) is cancelled', async () => {
    // Chrome's own words for a window closed without approving.
    fakeBrowser.identity.launchWebAuthFlow = vi.fn(() =>
      Promise.reject(new Error('The user did not approve access.')),
    );
    const server = tokenEndpoint();
    const { auth, connection } = await worker(server.fetch, fakeBrowser.identity);

    expect(await auth.connect()).toEqual({ kind: 'cancelled' });
    expect(await connection.get()).toEqual({ kind: 'none' });
    expect(server.calls).toHaveLength(0);
  });

  test('two connect() calls at once open one window and share one answer (one flow at a time)', async () => {
    let release: (url: string) => void = () => undefined;
    const urls: URL[] = [];
    fakeBrowser.identity.launchWebAuthFlow = vi.fn(({ url }: { url: string }) => {
      urls.push(new URL(url));
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    const server = tokenEndpoint();
    const { auth } = await worker(server.fetch, fakeBrowser.identity);

    const first = auth.connect();
    const second = auth.connect();
    await vi.waitFor(() => {
      expect(urls).toHaveLength(1);
    });
    const opened = urls[0];
    if (opened === undefined) throw new Error('no window');
    release(`${REDIRECT}?code=c1&state=${opened.searchParams.get('state') ?? ''}`);
    const [a, b] = await Promise.all([first, second]);

    expect(fakeBrowser.identity.launchWebAuthFlow).toHaveBeenCalledTimes(1);
    expect(a.kind).toBe('connected');
    expect(b).toEqual(a);
    expect(server.calls).toHaveLength(1);
  });

  describe('a worker that stops mid-flow leaves no half-made connection', () => {
    test('stopped while the window is open', async () => {
      const urls: URL[] = [];
      fakeBrowser.identity.launchWebAuthFlow = vi.fn(({ url }: { url: string }) => {
        urls.push(new URL(url));
        return new Promise<string>(() => undefined); // the worker stops before the window ends
      });
      const first = await worker(tokenEndpoint().fetch, fakeBrowser.identity);
      void first.auth.connect();
      await vi.waitFor(() => {
        expect(urls).toHaveLength(1);
      });
      first.db.close();

      // The next worker, over the same database and the same browser session.
      const next = await worker(tokenEndpoint().fetch, fakeBrowser.identity);
      await next.discardInterruptedSignIn(next.flows);
      expect(await next.connection.get()).toEqual({ kind: 'none' });
      expect(await next.connection.credential()).toBeNull();
      // The verifier and the `state` are kept for the flow only.
      expect(await fakeBrowser.storage.session.get(null)).toEqual({});
    });

    test('stopped while the code is being exchanged', async () => {
      const window: Window = { urls: [] };
      fakeBrowser.identity.launchWebAuthFlow = approving(window);
      const hanging = tokenEndpoint(() => new Promise<Response>(() => undefined));
      const first = await worker(hanging.fetch, fakeBrowser.identity);
      void first.auth.connect();
      await vi.waitFor(() => {
        expect(hanging.calls).toHaveLength(1);
      });
      first.db.close();

      const next = await worker(tokenEndpoint().fetch, fakeBrowser.identity);
      await next.discardInterruptedSignIn(next.flows);
      expect(await next.connection.get()).toEqual({ kind: 'none' });
      expect(await next.connection.credential()).toBeNull();
      expect(await fakeBrowser.storage.session.get(null)).toEqual({});
    });

    test('a connect in the next worker opens a new window with a new key and `state`', async () => {
      const urls: URL[] = [];
      fakeBrowser.identity.launchWebAuthFlow = vi.fn(({ url }: { url: string }) => {
        urls.push(new URL(url));
        return new Promise<string>(() => undefined);
      });
      const first = await worker(tokenEndpoint().fetch, fakeBrowser.identity);
      void first.auth.connect();
      await vi.waitFor(() => {
        expect(urls).toHaveLength(1);
      });
      first.db.close();

      const window: Window = { urls: [] };
      fakeBrowser.identity.launchWebAuthFlow = approving(window);
      const next = await worker(tokenEndpoint().fetch, fakeBrowser.identity);
      await next.discardInterruptedSignIn(next.flows);
      const result: ConnectResult = await next.auth.connect();

      expect(result.kind).toBe('connected');
      const before = urls[0];
      const after = window.urls[0];
      expect(after?.searchParams.get('state')).not.toBe(before?.searchParams.get('state'));
      expect(after?.searchParams.get('dpop_jkt')).not.toBe(before?.searchParams.get('dpop_jkt'));
    });
  });

  test('a diagnostics line never carries the code, the `state` or the credential', async () => {
    const window: Window = { urls: [] };
    fakeBrowser.identity.launchWebAuthFlow = approving(window);
    const { auth, log } = await worker(tokenEndpoint().fetch, fakeBrowser.identity);
    await auth.connect();

    const logged = JSON.stringify(log.mock.calls);
    const state = window.urls[0]?.searchParams.get('state') ?? 'missing';
    expect(logged).not.toContain(ACCESS_TOKEN);
    expect(logged).not.toContain(state);
    expect(logged).not.toContain('"c1"');
    expect(logged).not.toContain('chromiumapp.org');
  });
});
