/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';

import { DEFAULT_RULE } from '../domain/account-rule';
import type { OutboxEntry } from '../domain/outbox';
import type { PlayBody } from '../domain/play';
import { DAY_MS, HOUR_MS } from '../domain/time';
import type { Viewing } from '../domain/viewing';
import type { HistoryEntry } from './ports';
import { T0, makeWorld } from './test-world';

const BODY: PlayBody = { kind: 'movie', title: 'Film', watched_at: '2026-10-20T20:59:00+02:00' };

function sent(playId: string, sentAt: number): HistoryEntry {
  return {
    playId,
    scrobbleId: `s-${playId}`,
    body: BODY,
    sentAt,
    receipt: { state: 'needs_confirmation', reason: 'text_only', titleId: null },
    receiptReadAt: null,
    receiptGoneAt: null,
    label: 'Film',
  };
}

/** A film past the 70 % line, its report stopped after its play was queued: still `open`. */
function stopped(o: Partial<Viewing> = {}): Viewing {
  return {
    id: 'v1',
    key: 'mv:film:2000',
    serviceId: null,
    reading: { kind: 'movie', title: 'Film', year: 2000, sources: ['json-ld'] },
    ranges: [[0, 950]],
    durationSeconds: 1000,
    statedDurationSeconds: null,
    elementDurationSeconds: 1000,
    lastElementDuration: 1000,
    contentEnded: false,
    firstSeenAt: T0 - HOUR_MS,
    lastSampleAt: T0 - 60_000,
    incognito: false,
    engaged: true,
    state: 'open',
    reportedPlayId: 'play-7',
    ...o,
  };
}

const queued: OutboxEntry = {
  playId: 'unsent',
  viewingId: 'v2',
  body: BODY,
  createdAt: T0,
  watchedAt: T0,
  attempts: 0,
  nextAttemptAt: T0,
  state: 'pending',
  lastError: null,
};

describe('ClearHistory', () => {
  // Whenever a play was sent, by a clock that has since moved back or forward.
  test('removes every play already sent, and nothing else', async () => {
    const w = makeWorld();
    await w.history.put(sent('old', T0 - 20 * DAY_MS));
    await w.history.put(sent('ahead', T0 + DAY_MS));
    await w.outbox.add(queued);
    await w.viewings.put(stopped({ id: 'v2', reportedPlayId: null }));
    await w.clearHistory.execute();
    expect(w.history.entries()).toEqual([]);
    expect(w.outbox.entries()).toEqual([queued]);
    expect((await w.viewings.byId('v2'))?.state).toBe('open');
  });

  test('a viewing that knew its play went only from the history records it first', async () => {
    const w = makeWorld();
    const v = stopped();
    await w.viewings.put(v);
    await w.history.put(sent('play-7', T0 - 1_000));
    await w.clearHistory.execute();
    expect((await w.viewings.byId('v1'))?.state).toBe('reported');
    // The report run again finds the viewing closed: the play is not queued a second time.
    await w.report.execute(v, { rule: DEFAULT_RULE });
    expect(w.outbox.entries()).toEqual([]);
  });

  test('so does a film whose start went, and only its start', async () => {
    const w = makeWorld();
    await w.viewings.put(stopped({ reportedPlayId: null, startPlayId: 'start-3' }));
    await w.history.put(sent('start-3', T0 - 2_000));
    await w.clearHistory.execute();
    expect(await w.viewings.byId('v1')).toMatchObject({
      state: 'open',
      startPlayId: 'start-3',
      startSentAt: T0 - 2_000,
    });
  });

  // A reserved id the history does not hold may still be on its way: the outbox keeps it.
  test('a viewing whose reserved play the history does not hold stays as it is', async () => {
    const w = makeWorld();
    const v = stopped();
    await w.viewings.put(v);
    await w.clearHistory.execute();
    expect(await w.viewings.byId('v1')).toEqual(v);
  });
});
