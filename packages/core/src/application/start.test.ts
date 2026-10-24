/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The account's lines through the use cases: a start queued once the story seconds played reach
// the start line, a viewing's play held back short of the finish line, and the server's word that
// its lines did not count what was sent.

import { describe, expect, test } from 'vitest';

import { sentPlayView } from '../domain/receipts';
import { filmReading, makeWorld, must, watch } from './test-world';

/**
 * Starts at 10 % with a one-minute floor. A 1000 s film's story ends at its credits estimate,
 * 880 s, so it is begun at 88 s played.
 */
const TEN_PERCENT = { startThresholdPercent: 10, startFloorSeconds: 60 };

describe('a film begun', () => {
  test('past the line, one start is queued, with the play’s numbers but no time and no end', async () => {
    const w = makeWorld({ rule: TEN_PERCENT });
    const results = await watch(w, filmReading('Arrival', 2016), 0, 180);
    expect(results.filter((r) => r.started === true)).toHaveLength(1);
    const entries = await w.outbox.list();
    expect(entries).toHaveLength(1);
    // The tab bound at 15 s: 90 s of the story played at 105 s, the first past 88.
    expect(must(entries[0]).body).toEqual({
      report: 'start',
      kind: 'movie',
      title: 'Arrival',
      year: 2016,
      duration_seconds: 1000,
      furthest_position_seconds: 105,
      story_seconds: 880,
      played_seconds: 90,
    });
    const viewing = must(w.viewings.all()[0]);
    expect(viewing.state).toBe('open');
    expect(viewing.startSentAt).toBe(must(entries[0]).createdAt);
  });

  test('a skip ahead past the line is no start: skipped time is not played', async () => {
    const w = makeWorld({ rule: TEN_PERCENT });
    const film = filmReading('Arrival', 2016);
    await watch(w, film, 0, 45);
    await watch(w, film, 600, 630);
    expect(await w.outbox.list()).toEqual([]);
  });

  test('with starts off, nothing is queued', async () => {
    const w = makeWorld();
    await watch(w, filmReading('Arrival', 2016), 0, 180);
    expect(await w.outbox.list()).toEqual([]);
  });
});

describe('a viewing’s play and the account’s finish line', () => {
  test('sent at the line with all four numbers, mid-story, so `ended` is false', async () => {
    const w = makeWorld();
    const results = await watch(w, filmReading('Arrival', 2016), 0, 885);
    // The tab bound at 15 s: 630 s of the 880 s story played at 645 s, the first past 616.
    expect(results.flatMap((r, i) => (r.reported ? [i * 15] : []))).toEqual([645]);
    const body = must((await w.outbox.list())[0]).body;
    expect(body).toMatchObject({
      duration_seconds: 1000,
      furthest_position_seconds: 645,
      story_seconds: 880,
      played_seconds: 630,
      ended: false,
    });
  });

  test('held back short of the line: half the story, then a skip to the credits, sends nothing', async () => {
    const w = makeWorld();
    const film = filmReading('Arrival', 2016);
    await watch(w, film, 0, 450);
    await watch(w, film, 870, 900);
    expect(await w.outbox.list()).toEqual([]);
    expect(must(w.viewings.all()[0]).state).toBe('open');
  });

  test('at 50 %, the same viewing is sent', async () => {
    const w = makeWorld({ rule: { finishThresholdPercent: 50 } });
    const film = filmReading('Arrival', 2016);
    await watch(w, film, 0, 450);
    await watch(w, film, 870, 900);
    expect(await w.outbox.list()).toHaveLength(1);
  });
});

describe('the account’s lines did not count what was sent', () => {
  test('settled as not kept, never retried, and the worker is told once', async () => {
    const w = makeWorld({ rule: TEN_PERCENT });
    await watch(w, filmReading('Arrival', 2016), 0, 120);
    w.gateway.onSend = () => ({
      kind: 'accepted',
      scrobbleId: null,
      state: 'ignored',
      reason: 'not_completed',
    });
    await w.drain.execute();
    expect(await w.outbox.list()).toEqual([]);
    expect(w.notCounted.count).toBe(1);
    const [sent] = await w.history.recent(10);
    const view = sentPlayView(must(sent));
    expect([view.messageKey, view.tone, view.settled]).toEqual([
      'receipt.start.not_taken',
      'neutral',
      true,
    ]);
    await w.drain.execute();
    expect(w.gateway.sends).toHaveLength(1);
  });
});
