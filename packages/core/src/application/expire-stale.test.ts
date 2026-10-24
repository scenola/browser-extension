/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';

import { DEFAULT_RULE } from '../domain/account-rule';
import type { OutboxEntry } from '../domain/outbox';
import type { PlayBody } from '../domain/play';
import { HISTORY_DAYS } from '../domain/settings';
import { DAY_MS, HOUR_MS } from '../domain/time';
import type { Viewing } from '../domain/viewing';
import {
  DIAGNOSTICS_MAX_ENTRIES,
  DIAGNOSTICS_RETENTION_MS,
  EXPIRE_INTERVAL_MS,
} from './expire-stale';
import type { HistoryEntry } from './ports';
import { T0, makeWorld } from './test-world';

const BODY: PlayBody = { kind: 'movie', title: 'Film', watched_at: '2026-10-20T20:59:00+02:00' };

const historyAt = (playId: string, sentAt: number): HistoryEntry => ({
  playId,
  scrobbleId: `s-${playId}`,
  body: BODY,
  sentAt,
  receipt: { state: 'recorded', reason: null, titleId: 't' },
  receiptReadAt: sentAt + 10_000,
  receiptGoneAt: null,
  label: 'Film',
});

function viewing(id: string, lastSampleAt: number, o: Partial<Viewing> = {}): Viewing {
  return {
    id,
    key: `mv:${id}:2000`,
    serviceId: null,
    reading: { kind: 'movie', title: id, year: 2000, sources: ['json-ld'] },
    ranges: [[0, 300]],
    durationSeconds: 1000,
    statedDurationSeconds: null,
    elementDurationSeconds: 1000,
    lastElementDuration: 1000,
    contentEnded: false,
    firstSeenAt: lastSampleAt - HOUR_MS,
    lastSampleAt,
    incognito: false,
    engaged: true,
    state: 'open',
    reportedPlayId: null,
    ...o,
  };
}

const entry = (playId: string, o: Partial<OutboxEntry>): OutboxEntry => ({
  playId,
  viewingId: `v-${playId}`,
  body: BODY,
  createdAt: T0,
  watchedAt: T0,
  attempts: 0,
  nextAttemptAt: T0,
  state: 'pending',
  lastError: null,
  ...o,
});

describe('ExpireStale', () => {
  test.each(HISTORY_DAYS)('keeps the history %i days, as the person chose', async (days) => {
    const w = makeWorld({ settings: { historyDays: days } });
    await w.history.put(historyAt('old', T0 - days * DAY_MS - 1));
    await w.history.put(historyAt('kept', T0 - days * DAY_MS + HOUR_MS));
    await w.expire.execute();
    expect(w.history.entries().map((h) => h.playId)).toEqual(['kept']);
  });

  // A history kept a day forgets a play long before its viewing's 7 idle days are over.
  test('a viewing whose delivered play the history forgets records it, and is not reported again', async () => {
    const w = makeWorld({ settings: { historyDays: 1 } });
    const v = viewing('stopped', T0 - 2 * DAY_MS, { ranges: [[0, 950]], reportedPlayId: 'play-7' });
    await w.viewings.put(v);
    await w.history.put(historyAt('play-7', T0 - 2 * DAY_MS));
    await w.expire.execute();
    expect(w.history.entries()).toEqual([]);
    expect((await w.viewings.byId('stopped'))?.state).toBe('reported');
    await w.report.execute(v, { rule: DEFAULT_RULE });
    expect(w.outbox.entries()).toEqual([]);
  });

  test('drops viewings idle for more than 7 days, whatever their state', async () => {
    const w = makeWorld();
    await w.viewings.put(viewing('partial', T0 - 7 * DAY_MS - 1));
    await w.viewings.put(viewing('reported', T0 - 8 * DAY_MS, { state: 'reported' }));
    await w.viewings.put(viewing('skipped', T0 - 9 * DAY_MS, { state: 'skipped' }));
    await w.viewings.put(viewing('recent', T0 - 6 * DAY_MS));
    await w.expire.execute();
    expect(w.viewings.all().map((v) => v.id)).toEqual(['recent']);
    expect(w.outbox.entries()).toEqual([]);
  });

  test('an idle viewing that is still reportable (a report interrupted) is sent, not dropped', async () => {
    const w = makeWorld();
    const done: Partial<Viewing> = { ranges: [[0, 950]] };
    await w.viewings.put(viewing('finished', T0 - 8 * DAY_MS, done));
    await w.viewings.put(
      viewing('incognito', T0 - 8 * DAY_MS, { ...done, incognito: true, key: 'mv:incognito:2000' }),
    );
    await w.expire.execute();
    expect(w.outbox.entries().map((e) => [e.viewingId, e.watchedAt])).toEqual([
      ['finished', T0 - 8 * DAY_MS],
    ]);
    expect(w.viewings.all()).toEqual([]);
    expect(w.scheduler.when('outbox')).toBe(T0);
  });

  test('an outbox entry past watched_at + 29 d dies; a dead letter goes with the history of its age', async () => {
    const w = makeWorld({ settings: { historyDays: 30 } });
    await w.outbox.add(entry('waiting', { state: 'paused', watchedAt: T0 - 29 * DAY_MS - 1 }));
    await w.outbox.add(entry('fresh', { watchedAt: T0 - DAY_MS }));
    await w.outbox.add(entry('gone', { state: 'dead', createdAt: T0 - 30 * DAY_MS - 1 }));
    await w.outbox.add(entry('shown', { state: 'dead', createdAt: T0 - 2 * DAY_MS }));
    await w.expire.execute();
    expect(w.outbox.entries().map((e) => [e.playId, e.state, e.lastError])).toEqual([
      ['waiting', 'dead', 'too_old'],
      ['fresh', 'pending', null],
      ['shown', 'dead', null],
    ]);
  });

  test('drops tab states not observed for 7 days, so their readings do not outlive the 7 days', async () => {
    const w = makeWorld();
    const tab = (tabId: number, observedAt: number) => ({
      tabId,
      viewingId: null,
      lastSample: null,
      pendingReading: { kind: 'movie' as const, title: 'Film', sources: [] },
      stableCount: 1,
      observedAt,
      addedAt: null,
      addedLabel: null,
    });
    await w.viewings.putTabState(tab(1, T0 - 7 * DAY_MS - 1));
    await w.viewings.putTabState(tab(2, T0 - 6 * DAY_MS));
    await w.expire.execute();
    expect(await w.viewings.tabState(1)).toBeNull();
    expect((await w.viewings.tabState(2))?.tabId).toBe(2);
  });

  test('prunes diagnostics to 7 days and 500 entries', async () => {
    expect(DIAGNOSTICS_RETENTION_MS).toBe(7 * DAY_MS);
    expect(DIAGNOSTICS_MAX_ENTRIES).toBe(500);
    const w = makeWorld();
    w.diagnostics.record(T0 - 7 * DAY_MS - 1);
    for (let i = 0; i < 510; i++) w.diagnostics.record(T0 - i);
    await w.expire.execute();
    expect(w.diagnostics.entries).toHaveLength(500);
    expect(w.diagnostics.entries.every((e) => e.at > T0 - 500)).toBe(true);
  });

  test('wakes itself again', async () => {
    expect(EXPIRE_INTERVAL_MS).toBe(6 * HOUR_MS);
    const w = makeWorld();
    await w.expire.execute();
    expect(w.scheduler.when('expire')).toBe(T0 + 6 * HOUR_MS);
  });
});
