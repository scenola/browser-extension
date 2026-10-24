/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A play belongs to the account it was recorded for. What a connection check says the
// connection acts for (`account_key`) decides what the browser keeps: a new connection deletes,
// never sends, what carries another key or none; a connection from before keys takes its own.

import { describe, expect, test } from 'vitest';

import type { OutboxEntry } from '../domain/outbox';
import { MINUTE_MS } from '../domain/time';
import type { HistoryEntry } from './ports';
import {
  ACCOUNT,
  CONNECTED,
  OTHER_ACCOUNT,
  T0,
  episodeReading,
  filmReading,
  makeWorld,
  watch,
} from './test-world';
import type { World } from './test-world';

const BODY = { kind: 'movie', title: 'Film', watched_at: '2026-10-20T20:59:00+02:00' } as const;

const queued = (playId: string, accountKey: string | null): OutboxEntry => ({
  playId,
  viewingId: `v-${playId}`,
  body: BODY,
  createdAt: T0 - MINUTE_MS,
  watchedAt: T0 - MINUTE_MS,
  attempts: 0,
  nextAttemptAt: T0 - MINUTE_MS,
  state: 'pending',
  lastError: null,
  accountKey,
});

const sent = (playId: string, accountKey: string | null): HistoryEntry => ({
  playId,
  scrobbleId: `s-${playId}`,
  body: BODY,
  sentAt: T0 - MINUTE_MS,
  receipt: { state: 'received', reason: null, titleId: null },
  receiptReadAt: null,
  receiptGoneAt: null,
  label: 'Film',
  accountKey,
});

/** Records of three origins: this account, another one, and none known. */
async function mixed(w: World): Promise<void> {
  await w.outbox.add(queued('mine', ACCOUNT));
  await w.outbox.add(queued('theirs', OTHER_ACCOUNT));
  await w.outbox.add(queued('nobody', null));
  await w.history.put(sent('mine-sent', ACCOUNT));
  await w.history.put(sent('theirs-sent', OTHER_ACCOUNT));
  await w.history.put(sent('nobody-sent', null));
}

const ids = (records: readonly { readonly playId: string }[]) =>
  records.map((r) => r.playId).sort();

describe('a connection a sign-in made', () => {
  test('keeps only what carries its key: the rest is deleted, never sent', async () => {
    const w = makeWorld({ known: { kind: 'unread' } });
    await mixed(w);
    await watch(w, filmReading('Heat', 1995), 0, 45);
    expect(w.viewings.all()[0]?.accountKey).toBeNull();

    expect(await w.confirm.execute(CONNECTED, ACCOUNT)).toEqual({ kind: 'kept', deleted: 2 });

    expect(ids(w.outbox.entries())).toEqual(['mine']);
    expect(ids(w.history.entries())).toEqual(['mine-sent']);
    // The viewing begun before the account was known is nobody's: it goes too.
    expect(w.viewings.all()).toEqual([]);
    expect(w.connection.known).toEqual({ kind: 'read', key: ACCOUNT });

    await w.drain.execute({ early: true });
    expect(w.gateway.sends.map((s) => s.playId)).toEqual(['mine']);
  });

  test("another person's account: everything of the one before goes", async () => {
    const w = makeWorld({ known: { kind: 'unread' } });
    await mixed(w);

    await w.confirm.execute(CONNECTED, 'a1:00000000000000000000000000000003');
    await w.drain.execute({ early: true });

    expect(w.outbox.entries()).toEqual([]);
    expect(w.history.entries()).toEqual([]);
    expect(w.gateway.sends).toEqual([]);
  });
});

describe('a connection stored before connections named their account', () => {
  test('what carries no key is its own, and takes the key', async () => {
    const w = makeWorld({ known: { kind: 'inherited' } });
    await w.outbox.add(queued('before', null));
    await w.history.put(sent('before-sent', null));
    await watch(w, filmReading('Heat', 1995), 0, 45);
    // Nothing is sent until then.
    await w.drain.execute();
    expect(w.gateway.sends).toEqual([]);

    expect(await w.confirm.execute(CONNECTED, ACCOUNT)).toEqual({ kind: 'kept', deleted: 0 });

    expect(w.outbox.entries().map((e) => e.accountKey)).toEqual([ACCOUNT]);
    expect(w.history.entries().map((e) => e.accountKey)).toEqual([ACCOUNT]);
    expect(w.viewings.all().map((v) => v.accountKey)).toEqual([ACCOUNT]);
    await w.drain.execute();
    expect(w.gateway.sends.map((s) => s.playId)).toEqual(['before']);
  });
});

describe('a connection whose account is known', () => {
  test('the same key again moves nothing', async () => {
    const w = makeWorld();
    await mixed(w);
    expect(await w.confirm.execute(CONNECTED, ACCOUNT)).toEqual({ kind: 'same' });
    expect(w.outbox.entries()).toHaveLength(3);
  });

  test('a changed key reads what is held as another account’s: deleted', async () => {
    const w = makeWorld();
    await w.outbox.add(queued('mine', ACCOUNT));
    const rotated = 'a1:0000000000000000000000000000000f';

    expect(await w.confirm.execute(CONNECTED, rotated)).toEqual({ kind: 'kept', deleted: 1 });
    expect(w.outbox.entries()).toEqual([]);
    expect(w.connection.known).toEqual({ kind: 'read', key: rotated });
  });

  test('a check answered after a disconnect changes nothing', async () => {
    const w = makeWorld({ known: { kind: 'unread' } });
    await mixed(w);
    await w.connection.forget();

    expect(await w.confirm.execute(CONNECTED, ACCOUNT)).toEqual({ kind: 'stale' });
    expect(w.outbox.entries()).toHaveLength(3);
  });

  test('every play, start and viewing recorded from then on carries the key', async () => {
    const w = makeWorld({ rule: { startThresholdPercent: 5 } });
    await watch(w, episodeReading(2), 0, 1000);
    const [viewing] = w.viewings.all();
    expect(viewing?.accountKey).toBe(ACCOUNT);
    expect(w.outbox.entries().length).toBeGreaterThan(0);
    for (const e of w.outbox.entries()) expect(e.accountKey).toBe(ACCOUNT);
    await w.drain.execute();
    for (const e of w.history.entries()) expect(e.accountKey).toBe(ACCOUNT);
  });
});
