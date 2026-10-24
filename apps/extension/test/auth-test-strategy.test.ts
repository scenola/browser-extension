/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The e2e build's sign-in against the mock API: `TestAuth` against `startMockApi` is connected
// and a play can be sent. Nothing is faked between the strategy and the mock: the approval is the
// mock's `/__test/approve`, the code exchange its token endpoint with its DPoP verification, and
// the play goes through the gateway the worker builds (background.ts), signed with the key the
// sign-in stored.

import 'fake-indexeddb/auto';

import { createPlaysGateway, memoryNonceStore } from '@mt/api';
import type { Clock, PlayBody } from '@mt/core';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { startMockApi } from '../../../tools/mock-api/server.ts';
import type { MockApi } from '../../../tools/mock-api/server.ts';
import { SessionFlowStore } from '../src/platform/auth-chrome.ts';
import { TestAuth } from '../src/platform/auth-test.ts';
import { IdbConnectionRepo } from '../src/platform/connection-store.ts';
import { openDatabase } from '../src/platform/idb.ts';
import { credentialSigner } from '../src/platform/signer.ts';

/** Chrome's redirect for an extension id (32 letters a–p), which the server allowlists. */
const REDIRECT = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/';
const clock: Clock = { now: () => Date.now(), offsetMinutes: () => 0 };

let api: MockApi;

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  api = await startMockApi({ port: 0 });
});

afterEach(async () => {
  await api.close();
});

async function testAuth() {
  const db = await openDatabase();
  const connection = new IdbConnectionRepo(() => Promise.resolve(db));
  const nonces = memoryNonceStore();
  const auth = new TestAuth({
    approveUrl: `${api.url}/__test/approve`,
    apiBase: api.url,
    fetch: globalThis.fetch.bind(globalThis),
    nonces,
    clock,
    credentials: connection,
    flows: new SessionFlowStore(fakeBrowser.storage.session),
    redirectUri: () => REDIRECT,
    log: () => Promise.resolve(),
  });
  return { auth, connection, nonces };
}

test('TestAuth connects against the mock API, and a play can be sent', async () => {
  const { auth, connection, nonces } = await testAuth();

  const result = await auth.connect();

  expect(result.kind).toBe('connected');
  expect((await connection.get()).kind).toBe('connected');
  const stored = await connection.credential();
  // The token endpoint answers `mts_ext_…`, bound to a non-extractable key.
  expect(stored?.accessToken).toMatch(/^mts_ext_[0-9A-Za-z]{49}$/u);
  expect(stored?.pair?.privateKey.extractable).toBe(false);

  const gateway = createPlaysGateway({
    fetch: globalThis.fetch.bind(globalThis),
    apiBase: api.url,
    signer: credentialSigner(connection, nonces, clock),
  });
  // A film, with an offset on `watched_at` and the counting fields.
  const body: PlayBody = {
    kind: 'movie',
    title: 'Arrival',
    year: 2016,
    watched_at: new Date().toISOString(),
    duration_seconds: 6960,
    furthest_position_seconds: 6900,
    ended: true,
  };
  const playId = '01929a4e-7c2b-7d4a-9f3e-0a1b2c3d4e5f';
  const sent = await gateway.send(playId, body);

  // The API answers `202 {scrobble_id, state, reason}`.
  expect(sent).toMatchObject({ kind: 'accepted', scrobbleId: expect.any(String) as string });
  expect(api.plays).toHaveLength(1);
  expect(api.plays[0]?.evidence).toEqual(body);
  // The play's id is its Idempotency-Key.
  expect(api.plays[0]?.idempotencyKey).toBe(playId);
});

// Hostile inputs: a session with a line break would be a header injection.
test('TestAuth sends no request for a session that is not a token', async () => {
  const { auth, connection } = await testAuth();
  const fetch = vi.spyOn(globalThis, 'fetch');

  const result = await auth.connect({ token: 'not a token\r\nX-Injected: 1' });

  expect(result.kind).not.toBe('connected');
  expect(fetch).not.toHaveBeenCalled();
  expect((await connection.get()).kind).toBe('none');
  fetch.mockRestore();
});
