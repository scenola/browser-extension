/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';

import type { OutboxEntry } from '../domain/outbox';
import { MINUTE_MS } from '../domain/time';
import type { ConnectResult } from './ports';
import { ACCOUNT, CONNECTED, T0, makeWorld } from './test-world';
import { FakeAuthStrategy } from './testing/in-memory';

const paused = (playId: string): OutboxEntry => ({
  playId,
  viewingId: `v-${playId}`,
  body: { kind: 'movie', title: 'Film', watched_at: '2026-10-20T20:59:00+02:00' },
  createdAt: T0 - MINUTE_MS,
  watchedAt: T0 - MINUTE_MS,
  attempts: 1,
  nextAttemptAt: T0 - MINUTE_MS,
  state: 'paused',
  lastError: 'credential_invalid',
  accountKey: ACCOUNT,
});

const reconnected = { ...CONNECTED, id: 'c2' };
const connected: ConnectResult = { kind: 'connected', state: reconnected };

describe('Connect', () => {
  test('stores the connection and resumes a paused outbox', async () => {
    const w = makeWorld({ connection: { kind: 'broken', reason: 'credential_invalid' } });
    await w.outbox.add(paused('p1'));
    const strategy = new FakeAuthStrategy('personal_token', connected);

    const result = await w.connect.execute(strategy, { token: 'mts_pat_x' });

    expect(result).toEqual(connected);
    expect(strategy.inputs).toEqual([{ token: 'mts_pat_x' }]);
    expect(w.connection.current).toEqual(reconnected);
    expect(w.outbox.entries()).toEqual([{ ...paused('p1'), state: 'pending', nextAttemptAt: T0 }]);
    expect(w.scheduler.when('outbox')).toBe(T0);
  });

  test.each<ConnectResult>([
    { kind: 'cancelled' },
    { kind: 'code_invalid' },
    { kind: 'proof_invalid' },
    { kind: 'forbidden' },
    { kind: 'limit_reached' },
    { kind: 'feature_closed' },
    { kind: 'unavailable' },
  ])('a $kind answer changes nothing and is handed back', async (answer) => {
    const w = makeWorld({ connection: { kind: 'none' } });
    await w.outbox.add(paused('p1'));
    expect(await w.connect.execute(new FakeAuthStrategy('pkce_dpop', answer))).toEqual(answer);
    expect(w.connection.current).toEqual({ kind: 'none' });
    expect(w.outbox.entries()).toEqual([paused('p1')]);
    expect(w.scheduler.when('outbox')).toBeUndefined();
  });

  test('one sign-in flow at a time: a second click joins the first', async () => {
    const w = makeWorld({ connection: { kind: 'none' } });
    const strategy = new FakeAuthStrategy('pkce_dpop', connected);
    const [a, b] = await Promise.all([w.connect.execute(strategy), w.connect.execute(strategy)]);
    expect(a).toEqual(connected);
    expect(b).toEqual(connected);
    expect(strategy.inputs).toHaveLength(1);
    // Once it ended, another flow may start.
    await w.connect.execute(strategy);
    expect(strategy.inputs).toHaveLength(2);
  });

  test('a new connection sends nothing until a check names its account', async () => {
    const w = makeWorld({ connection: { kind: 'broken', reason: 'credential_invalid' } });
    await w.outbox.add(paused('p1'));

    await w.connect.execute(new FakeAuthStrategy('pkce_dpop', connected));
    expect(w.connection.known).toEqual({ kind: 'unread' });
    await w.drain.execute();
    expect(w.gateway.sends).toEqual([]);

    // The same account as before: its plays go.
    await w.confirm.execute(reconnected, ACCOUNT);
    await w.drain.execute();
    expect(w.gateway.sends.map((s) => s.playId)).toEqual(['p1']);
  });
});
