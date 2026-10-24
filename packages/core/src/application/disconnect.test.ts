/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// *Disconnect from this browser*: the account leaves with everything recorded for it, in an
// order that a worker stopped at any step cannot turn into a play sent to the next account.

import { describe, expect, test } from 'vitest';

import type { OutboxEntry, SendResult } from '../domain/outbox';
import { MINUTE_MS } from '../domain/time';
import { SEND_FIRST_WAIT_MS } from './disconnect';
import type { AuthStrategy, ConnectResult, HistoryEntry } from './ports';
import { ACCOUNT, CONNECTED, T0, filmReading, makeWorld, watch } from './test-world';
import type { World } from './test-world';
import { FakeAuthStrategy } from './testing/in-memory';

const BODY = { kind: 'movie', title: 'Film', watched_at: '2026-10-20T20:59:00+02:00' } as const;

const entry = (playId: string, o: Partial<OutboxEntry> = {}): OutboxEntry => ({
  playId,
  viewingId: `v-${playId}`,
  body: BODY,
  createdAt: T0 - MINUTE_MS,
  watchedAt: T0 - MINUTE_MS,
  attempts: 0,
  nextAttemptAt: T0 - MINUTE_MS,
  state: 'pending',
  lastError: null,
  accountKey: ACCOUNT,
  ...o,
});

const sent = (playId: string): HistoryEntry => ({
  playId,
  scrobbleId: `s-${playId}`,
  body: BODY,
  sentAt: T0 - 2 * MINUTE_MS,
  receipt: { state: 'recorded', reason: null, titleId: 't1' },
  receiptReadAt: null,
  receiptGoneAt: null,
  label: 'Film',
  accountKey: ACCOUNT,
});

const accepted = (playId: string): SendResult => ({
  kind: 'accepted',
  scrobbleId: `s-${playId}`,
  state: 'received',
  reason: null,
});

/** A promise and the function that settles it. */
function gate<T = void>(): { readonly promise: Promise<T>; readonly open: (value: T) => void } {
  let open: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Lets the promises already queued run on (the in-memory ports answer within a few turns). */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

const nextAccount: ConnectResult = { kind: 'connected', state: { ...CONNECTED, id: 'c2' } };

/** A connection with two plays not sent yet, one sent, an open viewing and its tab. */
async function withAccountData(w: World): Promise<void> {
  await w.outbox.add(entry('p1'));
  await w.outbox.add(entry('p2', { state: 'paused', attempts: 1 }));
  await w.history.put(sent('p0'));
  await watch(w, filmReading('Heat', 1995), 0, 45);
  await w.scheduler.at('outbox', T0 + MINUTE_MS);
  await w.scheduler.at('receipts', T0 + 10_000);
}

/** What the account leaves, as the stores hold it. */
function leftHere(w: World) {
  return {
    outbox: w.outbox.entries().length,
    history: w.history.entries().length,
    viewings: w.viewings.all().length,
    tabs: w.viewings.tabs().length,
  };
}

const NOTHING = { outbox: 0, history: 0, viewings: 0, tabs: 0 };

describe('Disconnect and delete', () => {
  test('the credential, the key and everything recorded for the account go', async () => {
    const w = makeWorld();
    await withAccountData(w);
    expect(leftHere(w)).toEqual({ outbox: 2, history: 1, viewings: 1, tabs: 1 });

    const result = await w.disconnect.execute({ sendFirst: false });

    expect(result).toEqual({ sent: 0, deleted: 2 });
    expect(w.connection.current).toEqual({ kind: 'none' });
    expect(w.connection.forgets).toBe(1);
    expect(w.connection.leaving).toBe(false);
    expect(leftHere(w)).toEqual(NOTHING);
    expect(w.scheduler.when('outbox')).toBeUndefined();
    expect(w.scheduler.when('receipts')).toBeUndefined();
    expect(w.gateway.sends).toEqual([]);
  });

  test('a play given up on is deleted with the rest, and counted', async () => {
    const w = makeWorld();
    await w.outbox.add(entry('p1', { state: 'dead', lastError: 'http_422' }));

    expect(await w.disconnect.execute({ sendFirst: false })).toEqual({ sent: 0, deleted: 1 });
    expect(w.outbox.entries()).toEqual([]);
  });

  test('the next connection is sent nothing of the account that left', async () => {
    const w = makeWorld();
    await withAccountData(w);
    await w.disconnect.execute({ sendFirst: false });

    await w.connect.execute(new FakeAuthStrategy('pkce_dpop', nextAccount));
    await w.drain.execute();
    await w.refresh.execute({ reason: 'popup' });

    expect(w.gateway.sends).toEqual([]);
    expect(w.gateway.reads).toEqual([]);
  });
});

describe('the order', () => {
  test('the credential goes first; the send in flight ends; only then the rest goes', async () => {
    const w = makeWorld();
    await w.outbox.add(entry('p1'));
    await w.outbox.add(entry('p2', { createdAt: T0 }));
    const answer = gate<SendResult>();
    const asked = gate();
    w.gateway.onSend = () => {
      asked.open();
      return answer.promise;
    };
    const pass = w.drain.execute();
    w.inflight.add(pass);
    await asked.promise;

    const disconnecting = w.disconnect.execute({ sendFirst: false });
    await settle();
    // Nothing can be sent any more, and nothing is removed while the answer is awaited: it
    // would write the history after the removal.
    expect(w.connection.current).toEqual({ kind: 'none' });
    expect(w.connection.leaving).toBe(true);
    expect(w.account.removals).toBe(0);
    expect(w.outbox.entries()).toHaveLength(2);

    answer.open(accepted('p1'));
    await pass;
    expect(w.history.entries().map((e) => e.playId)).toEqual(['p1']);

    // The play in flight reached the account, and is counted as sent.
    expect(await disconnecting).toEqual({ sent: 1, deleted: 1 });
    // The pass stopped at its next entry: the second play was never sent.
    expect(w.gateway.sends.map((s) => s.playId)).toEqual(['p1']);
    expect(leftHere(w)).toEqual(NOTHING);
  });

  test('a stop between the two steps leaves nothing a later connection would send', async () => {
    const w = makeWorld();
    await withAccountData(w);
    w.account.stopBeforeRemove = true;

    await expect(w.disconnect.execute({ sendFirst: false })).rejects.toThrow('stopped');

    // The credential is gone and the rest is marked: no pass sends it meanwhile.
    expect(w.connection.current).toEqual({ kind: 'none' });
    expect(w.connection.leaving).toBe(true);
    expect(leftHere(w).outbox).toBe(2);
    await w.drain.execute();
    expect(w.gateway.sends).toEqual([]);

    // The next connection: what was left goes before its strategy even runs.
    const seen: number[] = [];
    const strategy: AuthStrategy = {
      id: 'pkce_dpop',
      connect: () => {
        seen.push(w.outbox.entries().length + w.history.entries().length);
        return Promise.resolve(nextAccount);
      },
    };
    await w.connect.execute(strategy);
    await w.drain.execute();
    await w.refresh.execute({ reason: 'popup' });

    expect(seen).toEqual([0]);
    expect(leftHere(w)).toEqual(NOTHING);
    expect(w.gateway.sends).toEqual([]);
    expect(w.gateway.reads).toEqual([]);
  });

  test('finish completes a disconnect a stop cut short, once', async () => {
    const w = makeWorld();
    await withAccountData(w);
    w.account.stopBeforeRemove = true;
    await w.disconnect.execute({ sendFirst: false }).catch(() => undefined);

    expect(await w.disconnect.finish()).toBe(true);
    expect(leftHere(w)).toEqual(NOTHING);
    expect(w.connection.leaving).toBe(false);
    expect(await w.disconnect.finish()).toBe(false);
    expect(w.account.removals).toBe(1);
  });

  test('a disconnect waits for a sign-in in progress, then removes that connection', async () => {
    const w = makeWorld({ connection: { kind: 'none' } });
    await w.outbox.add(entry('p1'));
    const signedIn = gate<ConnectResult>();
    const strategy: AuthStrategy = { id: 'pkce_dpop', connect: () => signedIn.promise };
    const connecting = w.connect.execute(strategy);

    const disconnecting = w.disconnect.execute({ sendFirst: false });
    await settle();
    expect(w.connection.forgets).toBe(0);

    signedIn.open(nextAccount);
    await connecting;
    await disconnecting;
    expect(w.connection.current).toEqual({ kind: 'none' });
    expect(w.outbox.entries()).toEqual([]);
  });

  test('two requests at once are one disconnect', async () => {
    const w = makeWorld();
    await withAccountData(w);
    const [a, b] = await Promise.all([
      w.disconnect.execute({ sendFirst: false }),
      w.disconnect.execute({ sendFirst: true }),
    ]);
    expect(a).toEqual(b);
    expect(w.connection.forgets).toBe(1);
  });
});

describe('Send first', () => {
  test('every play not sent yet goes now, a retry not due yet too, then all of it is removed', async () => {
    const w = makeWorld();
    await withAccountData(w);
    await w.outbox.add(entry('p3', { attempts: 2, nextAttemptAt: T0 + 5 * MINUTE_MS }));

    const result = await w.disconnect.execute({ sendFirst: true });

    expect(result).toEqual({ sent: 3, deleted: 0 });
    expect(w.gateway.sends.map((s) => s.playId).sort()).toEqual(['p1', 'p2', 'p3']);
    // Sent plays stay in the account; here they go with the rest.
    expect(leftHere(w)).toEqual(NOTHING);
    expect(w.connection.current).toEqual({ kind: 'none' });
  });

  test('it waits at most its bound, then disconnects and deletes what did not go', async () => {
    const asked: number[] = [];
    const bound = gate();
    const w = makeWorld({
      delay: (ms) => {
        asked.push(ms);
        return bound.promise;
      },
    });
    await w.outbox.add(entry('p1'));
    await w.outbox.add(entry('p2', { createdAt: T0 }));
    await w.outbox.add(entry('p3', { createdAt: T0 + 1 }));
    const second = gate<SendResult>();
    const secondAsked = gate();
    w.gateway.onSend = (playId) => {
      if (playId !== 'p2') return accepted(playId);
      secondAsked.open();
      return second.promise;
    };

    const disconnecting = w.disconnect.execute({ sendFirst: true });
    await secondAsked.promise;
    expect(asked).toEqual([SEND_FIRST_WAIT_MS]);
    expect(w.connection.forgets).toBe(0);

    // The bound passes with the second play still in flight: the credential goes.
    bound.open();
    await settle();
    expect(w.connection.current).toEqual({ kind: 'none' });
    expect(w.account.removals).toBe(0);

    // Its answer lands; the pass stops before the third.
    second.open(accepted('p2'));
    expect(await disconnecting).toEqual({ sent: 2, deleted: 1 });
    expect(w.gateway.sends.map((s) => s.playId)).toEqual(['p1', 'p2']);
    expect(leftHere(w)).toEqual(NOTHING);
  });

  test('a broken connection sends nothing: everything is deleted', async () => {
    const w = makeWorld({ connection: { kind: 'broken', reason: 'credential_invalid' } });
    await withAccountData(w);

    expect(await w.disconnect.execute({ sendFirst: true })).toEqual({ sent: 0, deleted: 2 });
    expect(w.gateway.sends).toEqual([]);
    expect(leftHere(w)).toEqual(NOTHING);
  });

  test('nothing waiting: no pass, no wait', async () => {
    const asked: number[] = [];
    const w = makeWorld({
      delay: (ms) => {
        asked.push(ms);
        return Promise.resolve();
      },
    });
    await w.history.put(sent('p0'));

    expect(await w.disconnect.execute({ sendFirst: true })).toEqual({ sent: 0, deleted: 0 });
    expect(asked).toEqual([]);
    expect(leftHere(w)).toEqual(NOTHING);
  });
});
