/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test, vi } from 'vitest';

import type { OutboxEntry, SendResult } from '../domain/outbox';
import type { PlayBody } from '../domain/play';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../domain/time';
import { ACCOUNT, CONNECTED, OTHER_ACCOUNT, T0, makeWorld } from './test-world';
import type { World } from './test-world';
import { FakeAuthStrategy } from './testing/in-memory';

const BODY: PlayBody = {
  kind: 'movie',
  title: 'Film',
  year: 2000,
  watched_at: '2026-10-20T20:59:00+02:00',
  duration_seconds: 6000,
  furthest_position_seconds: 5900,
  ended: true,
};

function pending(playId: string, o: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    playId,
    viewingId: `v-${playId}`,
    body: BODY,
    createdAt: T0,
    watchedAt: T0 - MINUTE_MS,
    attempts: 0,
    nextAttemptAt: T0,
    state: 'pending',
    lastError: null,
    accountKey: ACCOUNT,
    ...o,
  };
}

async function withEntries(...entries: OutboxEntry[]): Promise<World> {
  const w = makeWorld();
  for (const e of entries) await w.outbox.add(e);
  return w;
}

const accepted = (scrobbleId: string): SendResult => ({
  kind: 'accepted',
  scrobbleId,
  state: 'received',
  reason: null,
});

describe('only the connection account’s plays are sent', () => {
  test('a new connection sends nothing before its account is read', async () => {
    const w = makeWorld({ known: { kind: 'unread' } });
    await w.outbox.add(pending('p1'));
    await w.drain.execute();
    expect(w.gateway.sends).toEqual([]);
    expect(w.unread.count).toBe(1);
    // The watchdog tries again while something waits.
    expect(w.scheduler.when('outbox')).toBe(T0 + MINUTE_MS);
  });

  test('an entry of another account, or of none, is never sent', async () => {
    const w = await withEntries(
      pending('mine'),
      pending('theirs', { accountKey: OTHER_ACCOUNT }),
      pending('nobody', { accountKey: null }),
      // Kept before entries carried a key.
      {
        playId: 'before',
        viewingId: 'v-before',
        body: BODY,
        createdAt: T0,
        watchedAt: T0 - MINUTE_MS,
        attempts: 0,
        nextAttemptAt: T0,
        state: 'pending',
        lastError: null,
      },
    );
    await w.drain.execute({ early: true });
    expect(w.gateway.sends.map((s) => s.playId)).toEqual(['mine']);
  });
});

describe('DrainOutbox', () => {
  test('202: history written, the entry removed, the expiry slid, receipts scheduled', async () => {
    const w = await withEntries(pending('p1'));
    await w.drain.execute();

    expect(w.gateway.sends).toEqual([{ playId: 'p1', body: BODY }]);
    expect(w.outbox.entries()).toEqual([]);
    expect(w.history.entries()).toEqual([
      {
        playId: 'p1',
        scrobbleId: 's-p1',
        body: BODY,
        sentAt: T0,
        receipt: { state: 'received', reason: null, titleId: null },
        receiptReadAt: null,
        receiptGoneAt: null,
        label: 'Film',
        accountKey: ACCOUNT,
      },
    ]);
    expect(w.connection.current).toEqual({ ...CONNECTED, expiresAt: T0 + 90 * DAY_MS });
    expect(w.scheduler.when('receipts')).toBe(T0 + 10_000);
    expect(w.scheduler.when('outbox')).toBeUndefined();
  });

  test('409 already_applied: done, nothing to read back, the expiry not moved', async () => {
    const w = await withEntries(pending('p1'));
    w.gateway.onSend = () => ({ kind: 'already_applied' });
    await w.drain.execute();
    expect(w.outbox.entries()).toEqual([]);
    expect(w.history.entries()[0]).toMatchObject({ scrobbleId: null, receipt: null });
    expect(w.connection.current).toEqual(CONNECTED);
    expect(w.scheduler.when('receipts')).toBeUndefined();
  });

  test('a resend answered already_applied keeps what the history already knows', async () => {
    // Stopped after the history was written and before the entry was removed.
    const w = await withEntries(pending('p1'));
    const known = {
      playId: 'p1',
      scrobbleId: 's-p1',
      body: BODY,
      sentAt: T0 - MINUTE_MS,
      receipt: { state: 'recorded' as const, reason: null, titleId: 't1' },
      receiptReadAt: T0 - 50_000,
      receiptGoneAt: null,
      label: 'Film',
    };
    await w.history.put(known);
    w.gateway.onSend = () => ({ kind: 'already_applied' });
    await w.drain.execute();
    expect(w.outbox.entries()).toEqual([]);
    expect(w.history.entries()).toEqual([known]);
  });

  test('a later receipt time never pushes back a pending earlier read', async () => {
    const w = await withEntries(pending('p1'));
    await w.drain.execute();
    expect(w.scheduler.when('receipts')).toBe(T0 + 10_000);
    w.clock.set(T0 + 5_000);
    await w.outbox.add(pending('p2', { nextAttemptAt: T0 + 5_000 }));
    await w.drain.execute();
    expect(w.scheduler.when('receipts')).toBe(T0 + 10_000);
  });

  test('a report landing while a pass reschedules keeps its alarm', async () => {
    const w = await withEntries(pending('p1'));
    const nextDueAt = w.outbox.nextDueAt.bind(w.outbox);
    let landed = false;
    // A report is queued and asks for the alarm after the pass read the next due time.
    w.outbox.nextDueAt = async () => {
      const next = await nextDueAt();
      if (!landed) {
        landed = true;
        await w.outbox.add(pending('late', { nextAttemptAt: T0 }));
        await w.scheduler.at('outbox', T0);
      }
      return next;
    };
    await w.drain.execute();
    expect(w.scheduler.when('outbox')).toBe(T0);
  });

  test('entries paused while the connection is good are resumed by the next drain', async () => {
    const w = await withEntries(pending('p1', { state: 'paused' }));
    await w.drain.execute();
    expect(w.gateway.sends.map((s) => s.playId)).toEqual(['p1']);
    expect(w.outbox.entries()).toEqual([]);
  });

  test('a reconnect landing while a refusal is recorded leaves nothing stuck', async () => {
    const w = await withEntries(pending('p1'), pending('p2'));
    const reconnected = { ...CONNECTED, id: 'c2' };
    const pauseAll = w.outbox.pauseAll.bind(w.outbox);
    let landed = false;
    // Connect runs between the outbox pausing and the connection being marked broken.
    w.outbox.pauseAll = async () => {
      await pauseAll();
      if (landed) return;
      landed = true;
      await w.connect.execute(
        new FakeAuthStrategy('test', { kind: 'connected', state: reconnected }),
      );
    };
    w.gateway.onSend = () => ({ kind: 'credential_invalid' });
    await w.drain.execute();
    expect(w.connection.current).toEqual(reconnected);

    // Nothing goes until the new connection's account is read: then the same account's do.
    w.gateway.onSend = (playId) => accepted(`s-${playId}`);
    await w.drain.execute();
    expect(w.history.entries()).toEqual([]);
    await w.confirm.execute(reconnected, ACCOUNT);
    await w.drain.execute();
    expect(w.outbox.entries()).toEqual([]);
    expect(w.history.entries().map((h) => h.playId)).toEqual(['p1', 'p2']);
  });

  test('a reconnect landing just after the refusal is recorded leaves nothing stuck', async () => {
    const w = await withEntries(pending('p1'), pending('p2'));
    const reconnected = { ...CONNECTED, id: 'c2' };
    const set = w.connection.set.bind(w.connection);
    let landed = false;
    w.connection.set = async (s) => {
      await set(s);
      if (s.kind !== 'broken' || landed) return;
      landed = true;
      await w.connect.execute(
        new FakeAuthStrategy('test', { kind: 'connected', state: reconnected }),
      );
    };
    w.gateway.onSend = () => ({ kind: 'credential_invalid' });
    await w.drain.execute();
    expect(w.connection.current).toEqual(reconnected);

    w.gateway.onSend = (playId) => accepted(`s-${playId}`);
    await w.confirm.execute(reconnected, ACCOUNT);
    await w.drain.execute();
    expect(w.outbox.entries()).toEqual([]);
    expect(w.history.entries().map((h) => h.playId)).toEqual(['p1', 'p2']);
  });

  test('a server error: the same entry, one attempt more, retried by the backoff', async () => {
    const w = await withEntries(pending('p1'));
    w.gateway.onSend = () => ({ kind: 'unavailable', detail: 'http_503' });
    await w.drain.execute();
    expect(w.outbox.entries()).toEqual([
      {
        ...pending('p1'),
        attempts: 1,
        nextAttemptAt: T0 + MINUTE_MS,
        lastError: 'unavailable:http_503',
      },
    ]);
    expect(w.scheduler.when('outbox')).toBe(T0 + MINUTE_MS);
    expect(w.history.entries()).toEqual([]);
  });

  test('restart safety: an answer lost after the server stored the play resends the same key', async () => {
    const w = await withEntries(pending('p1'));
    const server = new Map<string, string>();
    let killed = false;
    w.gateway.onSend = (playId) => {
      if (!server.has(playId)) server.set(playId, `s-${playId}`);
      if (!killed) {
        killed = true;
        throw new Error('the worker went away before the 202 was stored');
      }
      return accepted(server.get(playId) ?? '');
    };

    await w.drain.execute();
    expect(w.outbox.entries()).toEqual([
      {
        ...pending('p1'),
        attempts: 1,
        nextAttemptAt: T0 + MINUTE_MS,
        lastError: 'unavailable:threw:Error',
      },
    ]);

    w.clock.set(T0 + MINUTE_MS);
    await w.drainWith().execute();
    expect(w.gateway.sends.map((s) => s.playId)).toEqual(['p1', 'p1']);
    expect(server.size).toBe(1);
    expect(w.outbox.entries()).toEqual([]);
    expect(w.history.entries().map((h) => [h.playId, h.scrobbleId])).toEqual([['p1', 's-p1']]);
  });

  test('restart safety: a worker killed mid-send leaves the entry as it was, under a watchdog', async () => {
    const w = await withEntries(pending('p1'));
    w.gateway.onSend = () => new Promise<SendResult>(() => undefined);
    void w.drain.execute();
    await vi.waitFor(() => {
      expect(w.gateway.sends).toHaveLength(1);
    });
    expect(w.outbox.entries()).toEqual([pending('p1')]);
    expect(w.scheduler.when('outbox')).toBe(T0 + MINUTE_MS);

    // A new worker, over the same stores, woken by that alarm.
    w.gateway.onSend = (playId) => accepted(`s-${playId}`);
    w.clock.set(T0 + MINUTE_MS);
    await w.drainWith().execute();
    expect(w.gateway.sends.map((s) => s.playId)).toEqual(['p1', 'p1']);
    expect(w.outbox.entries()).toEqual([]);
    expect(w.history.entries()).toHaveLength(1);
  });

  test('credential_invalid pauses every entry and breaks the connection; Connect resumes them', async () => {
    const w = await withEntries(
      pending('p1'),
      pending('p2', { nextAttemptAt: T0 - 1 }),
      pending('p3', { nextAttemptAt: T0 + HOUR_MS }),
    );
    w.gateway.onSend = () => ({ kind: 'credential_invalid' });
    await w.drain.execute();

    expect(w.gateway.sends.map((s) => s.playId)).toEqual(['p2']);
    expect(w.outbox.entries().map((e) => [e.playId, e.state])).toEqual([
      ['p1', 'paused'],
      ['p2', 'paused'],
      ['p3', 'paused'],
    ]);
    expect(w.connection.current).toEqual({ kind: 'broken', reason: 'credential_invalid' });
    expect(w.scheduler.when('outbox')).toBeUndefined();

    // A broken connection sends nothing.
    await w.drain.execute();
    expect(w.gateway.sends).toHaveLength(1);

    const reconnected = { ...CONNECTED, id: 'c2', connectedAt: T0 + 5 * MINUTE_MS };
    w.clock.set(T0 + 5 * MINUTE_MS);
    await w.connect.execute(
      new FakeAuthStrategy('test', { kind: 'connected', state: reconnected }),
    );
    expect(w.outbox.entries().map((e) => [e.playId, e.state, e.nextAttemptAt])).toEqual([
      ['p1', 'pending', T0 + 5 * MINUTE_MS],
      ['p2', 'pending', T0 + 5 * MINUTE_MS],
      ['p3', 'pending', T0 + 5 * MINUTE_MS],
    ]);
    expect(w.scheduler.when('outbox')).toBe(T0 + 5 * MINUTE_MS);

    w.gateway.onSend = (playId) => accepted(`s-${playId}`);
    await w.confirm.execute(reconnected, ACCOUNT);
    await w.drain.execute();
    expect(w.gateway.sends.map((s) => s.playId)).toEqual(['p2', 'p1', 'p2', 'p3']);
    expect(w.outbox.entries()).toEqual([]);
  });

  test('a 401 for a credential replaced during the drain breaks nothing of the new one', async () => {
    const w = await withEntries(pending('p1'), pending('p2'));
    const replacement = { ...CONNECTED, id: 'c2' };
    w.gateway.onSend = async () => {
      await w.connection.set(replacement);
      return { kind: 'credential_invalid' };
    };
    await w.drain.execute();
    expect(w.connection.current).toEqual(replacement);
    expect(w.outbox.entries().map((e) => e.state)).toEqual(['pending', 'pending']);
    expect(w.gateway.sends).toHaveLength(1);
  });

  test('422 is a dead letter: kept for "Couldn\'t send", never sent again', async () => {
    const w = await withEntries(pending('p1'));
    w.gateway.onSend = () => ({ kind: 'rejected', status: 422, code: 'validation.failed' });
    await w.drain.execute();
    expect(w.outbox.entries()).toEqual([
      { ...pending('p1'), attempts: 1, state: 'dead', lastError: 'rejected:422:validation.failed' },
    ]);
    w.clock.advance(DAY_MS);
    await w.drain.execute();
    expect(w.gateway.sends).toHaveLength(1);
    expect(w.scheduler.when('outbox')).toBeUndefined();
  });

  test('an entry already past watched_at + 29 d dies without a request', async () => {
    const w = await withEntries(pending('p1', { watchedAt: T0 - 30 * DAY_MS }));
    await w.drain.execute();
    expect(w.gateway.sends).toEqual([]);
    expect(w.outbox.entries()[0]).toMatchObject({ state: 'dead', lastError: 'too_old' });
  });

  test.each([
    { kind: 'none' as const },
    { kind: 'broken' as const, reason: 'key_missing' as const },
  ])('skips entirely when the connection is $kind', async (state) => {
    const w = await withEntries(pending('p1'));
    await w.connection.set(state);
    await w.drain.execute();
    expect(w.gateway.sends).toEqual([]);
    expect(w.outbox.entries()).toEqual([pending('p1')]);
    expect(w.scheduler.when('outbox')).toBeUndefined();
  });

  test('sends due entries one at a time, oldest due first, and leaves the rest scheduled', async () => {
    const w = await withEntries(
      pending('late', { nextAttemptAt: T0 + 10 * MINUTE_MS }),
      pending('second', { nextAttemptAt: T0 - 1_000 }),
      pending('first', { nextAttemptAt: T0 - 2_000 }),
    );
    let inFlight = 0;
    let most = 0;
    w.gateway.onSend = async (playId) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await Promise.resolve();
      inFlight--;
      return accepted(`s-${playId}`);
    };
    await w.drain.execute();
    expect(most).toBe(1);
    expect(w.gateway.sends.map((s) => s.playId)).toEqual(['first', 'second']);
    expect(w.scheduler.when('outbox')).toBe(T0 + 10 * MINUTE_MS);
  });

  test('two drains at once send each play once', async () => {
    const w = await withEntries(pending('p1'), pending('p2'));
    await Promise.all([w.drain.execute(), w.drain.execute(), w.drain.execute()]);
    expect(w.gateway.sends.map((s) => s.playId)).toEqual(['p1', 'p2']);
    expect(w.history.entries()).toHaveLength(2);
  });
});
