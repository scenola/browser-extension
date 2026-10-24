/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';

import { buildPlay } from '../domain/play';
import type { PlayBody } from '../domain/play';
import { DEFAULT_RULE } from '../domain/account-rule';
import { HOUR_MS } from '../domain/time';
import type { Viewing } from '../domain/viewing';
import { ACCOUNT, T0, makeWorld, must } from './test-world';
import type { World } from './test-world';

// A report is taken at the account's finish line, which its caller reads from what
// the connection check kept and hands over; these use the never-read rule, 70 %.
const AT = { rule: DEFAULT_RULE } as const;

/** The sample that brought the viewing to the line: the play's moment. */
const REACHED_AT = T0 - 60_000;

/** A viewing past the 70 % line: 880 s of its 880 s story played. */
function counted(o: Partial<Viewing> = {}): Viewing {
  return {
    id: 'v1',
    key: 'ep:show:1:2',
    serviceId: null,
    reading: {
      kind: 'episode',
      showTitle: 'Show',
      season: 1,
      episode: 2,
      episodeTitle: 'Two',
      sources: ['module'],
    },
    ranges: [[0, 950]],
    durationSeconds: 1000,
    statedDurationSeconds: null,
    elementDurationSeconds: 1000,
    lastElementDuration: 1000,
    contentEnded: false,
    firstSeenAt: T0 - HOUR_MS,
    lastSampleAt: REACHED_AT,
    incognito: false,
    engaged: true,
    state: 'open',
    reportedPlayId: null,
    ...o,
  };
}

async function seeded(v: Viewing): Promise<World> {
  const w = makeWorld();
  await w.viewings.put(v);
  await w.viewings.putTabState({
    tabId: 3,
    viewingId: v.id,
    lastSample: null,
    pendingReading: null,
    stableCount: 2,
    observedAt: T0 - 1_000,
    addedAt: null,
    addedLabel: null,
  });
  return w;
}

const bodyOf = (v: Viewing): PlayBody | null => buildPlay(v, REACHED_AT, 120);

describe('ReportViewing', () => {
  test('a viewing at the line becomes one outbox entry before anything is sent', async () => {
    const v = counted();
    const w = await seeded(v);
    await w.report.execute(v, { tabId: 3, ...AT });

    expect(w.outbox.entries()).toEqual([
      {
        playId: 'play-1',
        viewingId: 'v1',
        body: bodyOf(v),
        createdAt: T0,
        watchedAt: REACHED_AT,
        attempts: 0,
        nextAttemptAt: T0,
        state: 'pending',
        lastError: null,
        accountKey: ACCOUNT,
      },
    ]);
    expect(w.outbox.entries()[0]?.body.watched_at).toBe('2026-10-20T20:59:00+02:00');
    const closed = await w.viewings.byId('v1');
    expect(closed?.state).toBe('reported');
    expect(closed?.reportedPlayId).toBe('play-1');
    const tab = await w.viewings.tabState(3);
    expect(tab?.addedAt).toBe(T0);
    expect(tab?.addedLabel).toBe('Show · S1 E2');
    expect(w.scheduler.when('outbox')).toBe(T0);
    expect(w.gateway.sends).toEqual([]);
  });

  test('called twice for one viewing: one outbox entry', async () => {
    const v = counted();
    const w = await seeded(v);
    await w.report.execute(v, { tabId: 3, ...AT });
    await w.report.execute(v, { tabId: 3, ...AT });
    await w.report.execute(counted(), { tabId: 3, ...AT });
    expect(w.outbox.entries()).toHaveLength(1);
  });

  test('called twice at once: one play, one id minted', async () => {
    const v = counted();
    const w = await seeded(v);
    await Promise.all([
      w.report.execute(v, { tabId: 3, ...AT }),
      w.report.execute(v, { tabId: 3, ...AT }),
      w.report.execute(counted(), AT),
    ]);
    expect(w.outbox.entries().map((e) => e.playId)).toEqual(['play-1']);
    expect((await w.viewings.byId('v1'))?.reportedPlayId).toBe('play-1');
    expect(w.ids.playId()).toBe('play-2');
  });

  test('inside the lock, the report needs the running task’s proof; a stale one throws', async () => {
    const v = counted();
    const w = await seeded(v);
    const stale = await w.lock.run((held) => Promise.resolve(held));
    await expect(w.report.executeHeld(v, stale, AT)).rejects.toThrow(/lock/);
    expect(w.outbox.entries()).toEqual([]);
    await w.lock.run((held) => w.report.executeHeld(v, held, { tabId: 3, ...AT }));
    expect(w.outbox.entries().map((e) => e.playId)).toEqual(['play-1']);
    expect((await w.viewings.tabState(3))?.addedLabel).toBe('Show · S1 E2');
  });

  test('interrupted after the play id was reserved: the report reuses it', async () => {
    const v = counted({ reportedPlayId: 'play-7' });
    const w = await seeded(v);
    await w.report.execute(v, AT);
    expect(w.outbox.entries().map((e) => e.playId)).toEqual(['play-7']);
    expect((await w.viewings.byId('v1'))?.reportedPlayId).toBe('play-7');
    expect(w.ids.playId()).toBe('play-1');
  });

  test('interrupted after the entry was written: still one entry, its body unchanged', async () => {
    const v = counted({ reportedPlayId: 'play-7' });
    const w = await seeded(v);
    const original = { ...must(bodyOf(v)), furthest_position_seconds: 940 };
    await w.outbox.add({
      playId: 'play-7',
      viewingId: 'v1',
      body: original,
      createdAt: T0 - 5_000,
      watchedAt: REACHED_AT,
      attempts: 0,
      nextAttemptAt: T0 - 5_000,
      state: 'pending',
      lastError: null,
    });
    await w.report.execute(v, AT);
    expect(w.outbox.entries()).toHaveLength(1);
    expect(w.outbox.entries()[0]?.body).toEqual(original);
    expect((await w.viewings.byId('v1'))?.state).toBe('reported');
  });

  test('interrupted after the play was delivered: it is not queued again', async () => {
    const v = counted({ reportedPlayId: 'play-7' });
    const w = await seeded(v);
    await w.history.put({
      playId: 'play-7',
      scrobbleId: 's7',
      body: must(bodyOf(v)),
      sentAt: T0 - 1_000,
      receipt: { state: 'received', reason: null, titleId: null },
      receiptReadAt: null,
      receiptGoneAt: null,
      label: 'Show · S1 E2',
    });
    await w.report.execute(v, AT);
    expect(w.outbox.entries()).toEqual([]);
    expect((await w.viewings.byId('v1'))?.state).toBe('reported');
  });

  test('a viewing that cannot become a play stays open, with nothing reserved', async () => {
    // An episode the page numbered but whose series it never named: the server cannot place it.
    const v = counted({
      key: 'svc:netflix:81',
      serviceId: 'netflix',
      reading: {
        kind: 'episode',
        season: 1,
        episode: 2,
        providerIds: [{ level: 'title', key: 'videoId', value: '81' }],
        sources: ['module'],
      },
    });
    const w = await seeded(v);
    await w.report.execute(v, { tabId: 3, ...AT });
    expect(w.outbox.entries()).toEqual([]);
    expect(await w.viewings.byId('v1')).toEqual(v);
    expect((await w.viewings.tabState(3))?.addedAt).toBeNull();
  });

  test.each<[string, Partial<Viewing>]>([
    ['skipped', { state: 'skipped' }],
    ['expired', { state: 'expired' }],
    ['short of the line', { ranges: [[0, 500]] }],
  ])('a %s viewing is not reported', async (_, o) => {
    const v = counted(o);
    const w = await seeded(v);
    await w.report.execute(v, { tabId: 3, ...AT });
    expect(w.outbox.entries()).toEqual([]);
    expect(w.scheduler.when('outbox')).toBeUndefined();
  });
});
