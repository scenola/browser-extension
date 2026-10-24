/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The IndexedDB stores: every store round-trips its values through a fresh open of the database
// — what a restarted worker sees, since the worker can stop at any moment and resume from
// IndexedDB — and reads what it cannot read as nothing (storage contents are hostile; a reader
// is total).

import 'fake-indexeddb/auto';

import type { HistoryEntry, OutboxEntry, PlayBody, TabState, Viewing } from '@mt/core';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { IdbConnectionRepo } from './connection-store';
import { IdbPlayHistory } from './history-store';
import { IdbAccountData, LEAVING_KEY, openDatabase } from './idb';
import type { MtDatabase } from './idb';
import { IdbOutbox } from './outbox-store';
import { IdbViewingStore } from './viewing-store';

const T0 = Date.UTC(2026, 9, 20, 19, 40);
const MINUTE = 60_000;

const opened: MtDatabase[] = [];

/** A database handle as a store takes it, opened afresh (a new worker's first open). */
async function freshOpen(): Promise<() => Promise<MtDatabase>> {
  const db = await openDatabase();
  opened.push(db);
  return () => Promise.resolve(db);
}

/** Closes every handle, as a stopped worker would. */
function closeAll(): void {
  for (const db of opened.splice(0)) db.close();
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
  closeAll();
});

/** A Netflix episode: Breaking Bad S1E2 "Cat's in the Bag...", videoId 70196253. */
const viewing: Viewing = {
  id: 'viewing-1',
  key: 'netflix/70196253',
  serviceId: 'netflix',
  reading: {
    kind: 'episode',
    showTitle: 'Breaking Bad',
    season: 1,
    episode: 2,
    episodeTitle: "Cat's in the Bag...",
    providerIds: [{ level: 'title', key: 'videoId', value: '70196253' }],
    sources: ['module'],
  },
  ranges: [
    [15, 600],
    [700, 2_800],
  ],
  durationSeconds: 2_880,
  statedDurationSeconds: 2_880,
  elementDurationSeconds: 2_880,
  lastElementDuration: 2_880,
  contentEnded: false,
  firstSeenAt: T0,
  lastSampleAt: T0 + 48 * MINUTE,
  incognito: false,
  engaged: true,
  state: 'open',
  reportedPlayId: null,
};

const tabState: TabState = {
  tabId: 7,
  viewingId: 'viewing-1',
  lastSample: {
    at: T0 + 48 * MINUTE,
    position: 2_800,
    duration: 2_880,
    paused: false,
    ended: false,
    rate: 1,
    adPlaying: false,
    muted: false,
    visibleArea: 0.8,
  },
  sittingFrameId: 0,
  sittingLength: 2_880,
  sound: { frameId: 0, at: T0 + 48 * MINUTE },
  pendingReading: null,
  stableCount: 2,
  observedAt: T0 + 48 * MINUTE,
  addedAt: null,
  addedLabel: null,
};

/** The body of the play report for that episode. */
const body: PlayBody = {
  kind: 'episode',
  ids: { provider: [{ namespace: 'provider.netflix', key: 'videoId', value: '70196253' }] },
  title: "Cat's in the Bag...",
  show: { title: 'Breaking Bad' },
  season_number: 1,
  episode_number: 2,
  watched_at: '2026-10-20T21:40:00+02:00',
  duration_seconds: 2_880,
  furthest_position_seconds: 2_800,
  ended: true,
};

const entry = (
  playId: string,
  nextAttemptAt: number,
  state: OutboxEntry['state'] = 'pending',
): OutboxEntry => ({
  playId,
  viewingId: 'viewing-1',
  body,
  createdAt: T0,
  watchedAt: T0,
  attempts: 0,
  nextAttemptAt,
  state,
  lastError: null,
});

const sent = (playId: string, sentAt: number, receipt: HistoryEntry['receipt']): HistoryEntry => ({
  playId,
  scrobbleId: `s-${playId}`,
  body,
  sentAt,
  receipt,
  receiptReadAt: null,
  receiptGoneAt: null,
  label: 'Breaking Bad · S1 E2',
});

describe('IdbViewingStore', () => {
  // Every store round-trips its values through a fresh database open.
  test('a viewing and a tab state survive a fresh open', async () => {
    const before = new IdbViewingStore(await freshOpen());
    await before.put(viewing);
    await before.putTabState(tabState);
    closeAll();

    const after = new IdbViewingStore(await freshOpen());
    expect(await after.byId('viewing-1')).toEqual(viewing);
    expect(await after.open('netflix/70196253')).toEqual(viewing);
    expect(await after.tabState(7)).toEqual(tabState);
  });

  // A viewing closes when reported, skipped or expired — a later sitting starts a
  // new one, so a reported viewing is not the open one of its key
  test('a reported viewing is not the open viewing of its key', async () => {
    const store = new IdbViewingStore(await freshOpen());
    await store.put({ ...viewing, state: 'reported', reportedPlayId: 'play-1' });
    expect(await store.open('netflix/70196253')).toBeNull();
  });

  // `idleBefore(t)` finds viewings with 7 days of inactivity.
  test('idleBefore returns the viewings last sampled before the time', async () => {
    const store = new IdbViewingStore(await freshOpen());
    await store.put(viewing);
    await store.put({
      ...viewing,
      id: 'viewing-2',
      key: 'k2',
      lastSampleAt: T0 + 9 * 24 * 60 * MINUTE,
    });
    const idle = await store.idleBefore(T0 + 7 * 24 * 60 * MINUTE);
    expect(idle.map((v) => v.id)).toEqual(['viewing-1']);
  });

  // `dropTab(tabId)` forgets a tab's state.
  test('a dropped tab state is gone after a fresh open', async () => {
    const before = new IdbViewingStore(await freshOpen());
    await before.putTabState(tabState);
    await before.dropTab(7);
    closeAll();
    expect(await new IdbViewingStore(await freshOpen()).tabState(7)).toBeNull();
  });

  // The sound mark is kept in the persisted tab state. Storage contents are hostile — an odd
  // value is "no value", never a throw.
  test.each([
    ['sound', 'loud'],
    ['sound', { frameId: -1, at: T0 }],
    ['sound', { frameId: 0 }],
    ['sound', { frameId: 1.5, at: T0 }],
    ['sittingFrameId', -1],
    ['sittingFrameId', 2.5],
    ['sittingFrameId', '0'],
    ['sittingLength', 0],
    ['sittingLength', -120],
    ['sittingLength', Number.POSITIVE_INFINITY],
    ['sittingLength', Number.NaN],
    ['sittingLength', '2880'],
  ])(
    'a stored %s of %j reads as absent and the rest of the tab state stays',
    async (field, bad) => {
      const db = await freshOpen();
      await (await db()).put('tabs', { ...tabState, [field]: bad });
      const read = await new IdbViewingStore(db).tabState(7);
      expect(read).not.toBeNull();
      expect(read?.[field as keyof TabState] ?? null).toBeNull();
      for (const [key, value] of Object.entries(tabState).filter(([name]) => name !== field)) {
        expect(read?.[key as keyof TabState]).toEqual(value);
      }
    },
  );

  // Storage is hostile, so records are read through shape checks.
  test('a record of another shape is no viewing and no tab state, never a throw', async () => {
    const db = await freshOpen();
    const raw = await db();
    await raw.put('viewings', { id: 'junk', key: 'netflix/70196253' } as unknown as Viewing);
    await raw.put('tabs', { tabId: 9, viewingId: 42 } as unknown as TabState);
    const store = new IdbViewingStore(db);
    expect(await store.byId('junk')).toBeNull();
    expect(await store.open('netflix/70196253')).toBeNull();
    expect(await store.tabState(9)).toBeNull();
  });
});

describe('IdbOutbox', () => {
  // The outbox entry is in IndexedDB before any network call, so it survives a fresh open.
  test('an entry survives a fresh open with its playId', async () => {
    const before = new IdbOutbox(await freshOpen());
    await before.add(entry('play-1', T0));
    closeAll();
    const after = new IdbOutbox(await freshOpen());
    expect(await after.due(T0)).toEqual([entry('play-1', T0)]);
  });

  // `due` honours nextAttemptAt: reporting a viewing enqueues with nextAttemptAt = now and drains
  // on enqueue, so an entry due now is due.
  test('due returns the pending entries whose time has come, and no later one', async () => {
    const outbox = new IdbOutbox(await freshOpen());
    await outbox.add(entry('past', T0 - MINUTE));
    await outbox.add(entry('now', T0));
    await outbox.add(entry('later', T0 + MINUTE));
    const due = await outbox.due(T0);
    expect(due.map((e) => e.playId).sort()).toEqual(['now', 'past']);
    expect((await outbox.due(T0 + MINUTE)).map((e) => e.playId).sort()).toEqual([
      'later',
      'now',
      'past',
    ]);
  });

  // Entry states are "pending" | "paused" | "dead" — only a pending entry is sent (paused waits
  // for a reconnect, dead is never retried).
  test('paused and dead entries are never due', async () => {
    const outbox = new IdbOutbox(await freshOpen());
    await outbox.add(entry('paused', T0 - MINUTE, 'paused'));
    await outbox.add(entry('dead', T0 - MINUTE, 'dead'));
    expect(await outbox.due(T0 + MINUTE)).toEqual([]);
  });

  // The key is the play's event id — a second add of the same play keeps the first
  test('adding the same playId twice keeps one entry', async () => {
    const outbox = new IdbOutbox(await freshOpen());
    await outbox.add(entry('play-1', T0));
    await outbox.add({ ...entry('play-1', T0), attempts: 5 });
    const due = await outbox.due(T0);
    expect(due).toHaveLength(1);
    expect(due[0]?.attempts).toBe(0);
  });

  // pauseAll, resumeAll(now) and nextDueAt.
  test('pauseAll and resumeAll survive a fresh open', async () => {
    const before = new IdbOutbox(await freshOpen());
    await before.add(entry('play-1', T0 + 5 * MINUTE));
    await before.pauseAll();
    closeAll();
    const after = new IdbOutbox(await freshOpen());
    expect(await after.nextDueAt()).toBeNull();
    await after.resumeAll(T0 + MINUTE);
    expect(await after.nextDueAt()).toBe(T0 + MINUTE);
  });
});

describe('IdbPlayHistory', () => {
  // "What was sent" shows the exact body and the answer, so both survive a fresh open.
  test('an entry survives a fresh open, its body exact', async () => {
    const waiting = sent('play-1', T0, {
      state: 'needs_confirmation',
      reason: 'text_only',
      titleId: null,
    });
    const before = new IdbPlayHistory(await freshOpen());
    await before.put(waiting);
    closeAll();
    const after = new IdbPlayHistory(await freshOpen());
    expect(await after.byPlayId('play-1')).toEqual(waiting);
    expect(await after.unsettled()).toEqual([waiting]);
  });

  // "Recently" lists the last ten plays.
  test('recent gives the newest entries first, at most the limit', async () => {
    const history = new IdbPlayHistory(await freshOpen());
    const recorded = { state: 'recorded', reason: null, titleId: 't1' } as const;
    await history.put(sent('a', T0, recorded));
    await history.put(sent('b', T0 + MINUTE, recorded));
    await history.put(sent('c', T0 + 2 * MINUTE, recorded));
    expect((await history.recent(2)).map((e) => e.playId)).toEqual(['c', 'b']);
  });

  // A recorded play is settled — only waiting ones are re-read
  test('a recorded entry is settled', async () => {
    const history = new IdbPlayHistory(await freshOpen());
    await history.put(sent('a', T0, { state: 'recorded', reason: null, titleId: 't1' }));
    expect(await history.unsettled()).toEqual([]);
  });

  // History is kept 30 days: `olderThan` names what to `remove`.
  test('olderThan names entries sent before the time, and remove deletes them', async () => {
    const history = new IdbPlayHistory(await freshOpen());
    const recorded = { state: 'recorded', reason: null, titleId: null } as const;
    await history.put(sent('old', T0, recorded));
    await history.put(sent('new', T0 + 31 * 24 * 60 * MINUTE, recorded));
    const old = await history.olderThan(T0 + 30 * 24 * 60 * MINUTE);
    expect([...old]).toEqual(['old']);
    await history.remove(old);
    closeAll();
    const after = new IdbPlayHistory(await freshOpen());
    expect(await after.byPlayId('old')).toBeNull();
    expect(await after.byPlayId('new')).not.toBeNull();
  });

  // A receipt read writes its answer through `update`: what was removed meanwhile stays removed.
  test('update changes an entry it still holds, and writes nothing for one removed', async () => {
    const history = new IdbPlayHistory(await freshOpen());
    const waiting = { state: 'received', reason: null, titleId: null } as const;
    await history.put(sent('kept', T0, waiting));
    const read = (e: HistoryEntry): HistoryEntry => ({ ...e, receiptReadAt: T0 + MINUTE });
    await history.update('kept', read);
    await history.update('removed', read);
    expect((await history.byPlayId('kept'))?.receiptReadAt).toBe(T0 + MINUTE);
    expect(await history.byPlayId('removed')).toBeNull();
  });

  // *Clear history* goes by no time: an entry a clock put in the future goes too.
  test('removeAll removes every entry, whenever it was sent', async () => {
    const history = new IdbPlayHistory(await freshOpen());
    const recorded = { state: 'recorded', reason: null, titleId: null } as const;
    await history.put(sent('past', T0, recorded));
    await history.put(sent('ahead', T0 + 365 * 24 * 60 * MINUTE, recorded));
    await history.removeAll();
    expect(await history.recent(10)).toEqual([]);
  });
});

describe('IdbConnectionRepo', () => {
  /** An ECDSA P-256 key pair with `extractable: false`, made in the test. */
  const generatePair = (): Promise<CryptoKeyPair> =>
    crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);

  const connected = {
    kind: 'connected',
    id: 'conn-1',
    strategy: 'pkce_dpop',
    connectedAt: T0,
    expiresAt: T0 + 90 * 24 * 60 * MINUTE,
  } as const;

  // A stored non-extractable CryptoKeyPair is returned with extractable === false and still
  // signs.
  test('a stored non-extractable key pair comes back non-extractable and still signs', async () => {
    const pair = await generatePair();
    const before = new IdbConnectionRepo(await freshOpen());
    await before.saveCredential(connected, 'mts_ext_test', pair);
    closeAll();

    const after = new IdbConnectionRepo(await freshOpen());
    expect(await after.get()).toEqual(connected);
    const credential = await after.credential();
    expect(credential?.accessToken).toBe('mts_ext_test');
    const stored = credential?.pair;
    expect(stored?.privateKey.extractable).toBe(false);
    if (stored === null || stored === undefined) throw new Error('no key pair came back');
    await expect(crypto.subtle.exportKey('jwk', stored.privateKey)).rejects.toThrow();
    const data = new TextEncoder().encode('proof');
    const algorithm = { name: 'ECDSA', hash: 'SHA-256' };
    const signature = await crypto.subtle.sign(algorithm, stored.privateKey, data);
    expect(await crypto.subtle.verify(algorithm, pair.publicKey, signature, data)).toBe(true);
  });

  // `forget()` removes the key pair and token: Disconnect deletes the credential and the key,
  // and leaves only the mark that what the connection left is leaving.
  test('forget removes the token and the key pair, for a fresh open too', async () => {
    const db = await freshOpen();
    const repo = new IdbConnectionRepo(db);
    await repo.saveCredential(connected, 'mts_ext_test', await generatePair());
    await repo.forget();
    expect(await repo.get()).toEqual({ kind: 'none' });
    expect(await repo.credential()).toBeNull();
    closeAll();

    const raw = await (await freshOpen())();
    const keys = await raw.getAllKeys('connection');
    const records = await raw.getAll('connection');
    expect(keys).toEqual([LEAVING_KEY]);
    expect(records).toEqual([{ leaving: true }]);
    expect(JSON.stringify(records)).not.toContain('mts_ext_test');
  });

  // What a connection left (`IdbAccountData`): marked in the forgetting's own write, so a worker
  // stopped after it still finds the mark; removed with the mark in one write.
  test('a disconnect stopped after forgetting: the mark survives a fresh open', async () => {
    const db = await freshOpen();
    await new IdbOutbox(db).add(entry('play-1', T0));
    const repo = new IdbConnectionRepo(db);
    await repo.saveCredential(connected, 'mts_ext_test', await generatePair());
    expect(await new IdbAccountData(db).leaving()).toBe(false);
    await repo.forget();
    closeAll();

    const after = await freshOpen();
    expect(await new IdbAccountData(after).leaving()).toBe(true);
    expect(await new IdbOutbox(after).list()).toHaveLength(1);
  });

  // The account a connection acts for: unknown after a sign-in, kept once a check names it, and
  // kept by a break; a record from before connections named theirs is `inherited`.
  test('the account: unread after a sign-in, read once kept, through a break and a fresh open', async () => {
    const db = await freshOpen();
    const repo = new IdbConnectionRepo(db);
    expect(await repo.account()).toEqual({ kind: 'none' });
    await repo.saveCredential(connected, 'mts_ext_test', await generatePair());
    expect(await repo.account()).toEqual({ kind: 'unread' });
    await repo.keepAccountKey('another-connection', 'a1:x');
    expect(await repo.account()).toEqual({ kind: 'unread' });
    await repo.keepAccountKey('conn-1', 'a1:mine');
    await repo.set({ kind: 'broken', reason: 'credential_invalid' });
    closeAll();
    expect(await new IdbConnectionRepo(await freshOpen()).account()).toEqual({
      kind: 'read',
      key: 'a1:mine',
    });
  });

  test('a connection stored before connections named their account is inherited', async () => {
    const db = await freshOpen();
    const raw = await db();
    await raw.put(
      'connection',
      { state: connected, connectionId: 'conn-1', accessToken: 'mts_ext_test', keyPair: null },
      'current',
    );
    expect(await new IdbConnectionRepo(db).account()).toEqual({ kind: 'inherited' });
  });

  test('adopt tags what carries no key; keepOnly removes the rest, in one write each', async () => {
    const db = await freshOpen();
    const outbox = new IdbOutbox(db);
    await outbox.add({ ...entry('mine', T0), accountKey: 'a1:mine' });
    await outbox.add({ ...entry('theirs', T0), accountKey: 'a1:theirs' });
    await outbox.add(entry('before', T0));
    await new IdbPlayHistory(db).put({ ...sent('sent-theirs', T0, null), accountKey: 'a1:theirs' });
    await new IdbViewingStore(db).put(viewing);
    const account = new IdbAccountData(db);

    await account.adopt('a1:mine');
    expect((await outbox.list()).map((e) => [e.playId, e.accountKey]).sort()).toEqual([
      ['before', 'a1:mine'],
      ['mine', 'a1:mine'],
      ['theirs', 'a1:theirs'],
    ]);
    expect((await new IdbViewingStore(db).byId(viewing.id))?.accountKey).toBe('a1:mine');

    expect(await account.keepOnly('a1:mine')).toBe(1);
    closeAll();
    const after = await freshOpen();
    expect((await new IdbOutbox(after).list()).map((e) => e.playId).sort()).toEqual([
      'before',
      'mine',
    ]);
    expect(await new IdbPlayHistory(after).recent(10)).toEqual([]);
    expect(await new IdbViewingStore(after).byId(viewing.id)).not.toBeNull();
  });

  test('remove empties every store of the account, and the mark', async () => {
    const db = await freshOpen();
    await new IdbOutbox(db).add(entry('play-1', T0));
    await new IdbPlayHistory(db).put(sent('play-0', T0, null));
    const viewings = new IdbViewingStore(db);
    await viewings.put(viewing);
    await viewings.putTabState(tabState);
    await (await db()).add('diagnostics', { at: T0, event: 'drain', detail: {} });
    const repo = new IdbConnectionRepo(db);
    await repo.saveCredential(connected, 'mts_ext_test', await generatePair());
    await repo.forget();

    await new IdbAccountData(db).remove();
    closeAll();

    const raw = await (await freshOpen())();
    const stores = ['outbox', 'history', 'viewings', 'tabs', 'diagnostics', 'connection'] as const;
    for (const store of stores) expect(await raw.count(store)).toBe(0);
    expect(await new IdbAccountData(await freshOpen()).leaving()).toBe(false);
  });

  // `get()` returns broken("key_missing") when a DPoP connection has no key pair, as when the
  // profile data was cleared.
  test('a DPoP connection whose key pair is gone is broken: key_missing', async () => {
    const db = await freshOpen();
    const repo = new IdbConnectionRepo(db);
    await repo.saveCredential(connected, 'mts_ext_test', null);
    expect(await repo.get()).toEqual({ kind: 'broken', reason: 'key_missing' });
    expect(await repo.credential()).toBeNull();
  });
});
