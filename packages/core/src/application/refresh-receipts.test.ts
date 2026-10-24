/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';

import type { PlayBody } from '../domain/play';
import { RECEIPT_READS_AT_ONCE } from '../domain/receipt-schedule';
import { sentPlayView } from '../domain/receipts';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../domain/time';
import type { HistoryEntry, ReceiptResult } from './ports';
import { ACCOUNT, OTHER_ACCOUNT, T0, makeWorld, must } from './test-world';
import type { World } from './test-world';

const BODY: PlayBody = { kind: 'movie', title: 'Film', watched_at: '2026-10-20T20:59:00+02:00' };

function sent(o: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    playId: 'p1',
    scrobbleId: 's1',
    body: BODY,
    sentAt: T0,
    receipt: { state: 'received', reason: null, titleId: null },
    receiptReadAt: null,
    receiptGoneAt: null,
    label: 'Film',
    accountKey: ACCOUNT,
    ...o,
  };
}

/** `count` plays sent at once, each with its own scrobble id. */
function plays(count: number): HistoryEntry[] {
  return Array.from({ length: count }, (_, i) =>
    sent({ playId: `p${String(i)}`, scrobbleId: `s${String(i)}` }),
  );
}

async function withHistory(...entries: HistoryEntry[]): Promise<World> {
  const w = makeWorld();
  for (const e of entries) await w.history.put(e);
  return w;
}

/** Answers the reads in turn; the last answer repeats. */
function answers(w: World, ...results: ReceiptResult[]): void {
  let i = 0;
  w.gateway.onReceipt = () => results[Math.min(i++, results.length - 1)] ?? { kind: 'unavailable' };
}

describe('RefreshReceipts', () => {
  test('the read schedule: +10 s, +1 min, +5 min, +15 min, then hourly until it settles', async () => {
    const w = await withHistory(sent());
    const waiting: ReceiptResult = {
      kind: 'ok',
      state: 'needs_confirmation',
      reason: 'text_only',
      titleId: null,
      questionKey: 'q1:a',
    };
    answers(
      w,
      { kind: 'ok', state: 'awaiting_catalog', reason: null, titleId: null, questionKey: null },
      waiting,
      waiting,
      waiting,
      { kind: 'ok', state: 'recorded', reason: null, titleId: 't1', questionKey: null },
    );
    const at = async (t: number): Promise<number> => {
      w.clock.set(t);
      await w.refresh.execute({ reason: 'scheduled' });
      return w.gateway.reads.length;
    };

    expect(await at(T0 + 5_000)).toBe(0);
    expect(w.scheduler.when('receipts')).toBe(T0 + 10_000);
    expect(await at(T0 + 10_000)).toBe(1);
    expect(w.scheduler.when('receipts')).toBe(T0 + MINUTE_MS);
    expect(await at(T0 + 30_000)).toBe(1);
    expect(await at(T0 + MINUTE_MS)).toBe(2);
    expect(w.history.entries()[0]?.receipt).toEqual({
      state: 'needs_confirmation',
      reason: 'text_only',
      titleId: null,
      questionKey: 'q1:a',
    });
    expect(w.scheduler.when('receipts')).toBe(T0 + 5 * MINUTE_MS);
    expect(await at(T0 + 5 * MINUTE_MS)).toBe(3);
    expect(w.scheduler.when('receipts')).toBe(T0 + 15 * MINUTE_MS);
    expect(await at(T0 + 15 * MINUTE_MS)).toBe(4);
    const hourly = T0 + 15 * MINUTE_MS + HOUR_MS;
    expect(w.scheduler.when('receipts')).toBe(hourly);
    expect(await at(hourly - 1)).toBe(4);
    expect(await at(hourly)).toBe(5);
    expect(w.history.entries()[0]).toMatchObject({
      receipt: { state: 'recorded', reason: null, titleId: 't1', questionKey: null },
      receiptReadAt: hourly,
    });
    expect(w.scheduler.when('receipts')).toBeUndefined();
    expect(await at(T0 + 2 * DAY_MS)).toBe(5);
    expect(w.gateway.reads).toEqual(['s1', 's1', 's1', 's1', 's1']);
  });

  test('a play waiting for the person is re-read every hour, or on popup at most once a minute', async () => {
    const readAt = T0 + 15 * MINUTE_MS;
    const w = await withHistory(
      sent({
        receipt: { state: 'needs_confirmation', reason: 'text_only', titleId: null },
        receiptReadAt: readAt,
      }),
    );
    answers(w, {
      kind: 'ok',
      state: 'needs_confirmation',
      reason: 'text_only',
      titleId: null,
      questionKey: null,
    });

    w.clock.set(readAt + 30_000);
    await w.refresh.execute({ reason: 'popup' });
    await w.refresh.execute({ reason: 'scheduled' });
    expect(w.gateway.reads).toHaveLength(0);

    w.clock.set(readAt + MINUTE_MS);
    await w.refresh.execute({ reason: 'popup' });
    await w.refresh.execute({ reason: 'popup' });
    expect(w.gateway.reads).toHaveLength(1);

    w.clock.set(readAt + MINUTE_MS + HOUR_MS - 1);
    await w.refresh.execute({ reason: 'scheduled' });
    expect(w.gateway.reads).toHaveLength(1);
    w.clock.set(readAt + MINUTE_MS + HOUR_MS);
    await w.refresh.execute({ reason: 'scheduled' });
    expect(w.gateway.reads).toHaveLength(2);
  });

  describe('opening the popup', () => {
    const waiting = (n: number, o: Partial<HistoryEntry> = {}): HistoryEntry =>
      sent({
        playId: `p${String(n)}`,
        scrobbleId: `s${String(n)}`,
        sentAt: T0 + n * 1_000,
        receipt: { state: 'needs_confirmation', reason: 'text_only', titleId: null },
        receiptReadAt: T0 + 2 * MINUTE_MS,
        ...o,
      });

    test('reads at most 20 waiting plays, the newest first', async () => {
      const w = await withHistory(...Array.from({ length: 25 }, (_, i) => waiting(i + 1)));
      answers(w, {
        kind: 'ok',
        state: 'needs_confirmation',
        reason: 'text_only',
        titleId: null,
        questionKey: 'q1:a',
      });
      w.clock.set(T0 + 4 * MINUTE_MS);
      await w.refresh.execute({ reason: 'popup' });
      expect(w.gateway.reads).toHaveLength(20);
      expect(w.gateway.reads[0]).toBe('s25');
      expect(w.gateway.reads).not.toContain('s5');
      expect(w.gateway.reads).toContain('s6');
    });

    // What the person looks at is current: a play the server decided since its last read shows
    // its answer, not *Sent*, whatever it was waiting on.
    test('reads every play still waiting, not only those waiting for the person', async () => {
      const w = await withHistory(
        waiting(1, { receipt: { state: 'held', reason: 'plus_lapsed', titleId: null } }),
        waiting(2, { receipt: { state: 'received', reason: null, titleId: null } }),
      );
      w.clock.set(T0 + 4 * MINUTE_MS);
      await w.refresh.execute({ reason: 'popup' });
      expect(w.gateway.reads).toEqual(['s2', 's1']);
    });

    test('a play re-queued by an answer in the app reads received with no key', async () => {
      const w = await withHistory(
        waiting(1, {
          receipt: {
            state: 'needs_confirmation',
            reason: 'text_only',
            titleId: null,
            questionKey: 'q1:a',
          },
        }),
      );
      answers(w, { kind: 'ok', state: 'received', reason: null, titleId: null, questionKey: null });
      w.clock.set(T0 + 4 * MINUTE_MS);
      await w.refresh.execute({ reason: 'popup' });
      expect(w.history.entries()[0]?.receipt).toEqual({
        state: 'received',
        reason: null,
        titleId: null,
        questionKey: null,
      });
    });
  });

  test('a 202 landing while a receipt pass reschedules keeps its +10 s read', async () => {
    const readAt = T0 + MINUTE_MS;
    const w = await withHistory(
      sent({
        receipt: { state: 'held', reason: 'plus_lapsed', titleId: null },
        receiptReadAt: readAt,
      }),
    );
    w.clock.set(readAt + MINUTE_MS);
    const unsettled = w.history.unsettled.bind(w.history);
    let calls = 0;
    // A drain records a new play and asks for its +10 s read after the pass's last look.
    w.history.unsettled = async () => {
      const entries = await unsettled();
      calls += 1;
      if (calls === 2) {
        await w.history.put(sent({ playId: 'p2', scrobbleId: 's2', sentAt: w.clock.now() }));
        await w.scheduler.at('receipts', w.clock.now() + 10_000);
      }
      return entries;
    };
    await w.refresh.execute({ reason: 'scheduled' });
    expect(w.scheduler.when('receipts')).toBe(readAt + MINUTE_MS + 10_000);
  });

  test('a receipt the server no longer has ends tracking: "no longer tracked", never waiting', async () => {
    const w = await withHistory(
      sent({
        receipt: { state: 'needs_confirmation', reason: 'text_only', titleId: null },
        receiptReadAt: T0 + 10_000,
      }),
    );
    answers(w, { kind: 'not_found' });
    w.clock.set(T0 + 10_000 + 6 * HOUR_MS);
    await w.refresh.execute({ reason: 'scheduled' });
    const gone = must(w.history.entries()[0]);
    expect(gone).toMatchObject({
      scrobbleId: 's1',
      receiptReadAt: T0 + 10_000 + 6 * HOUR_MS,
      receiptGoneAt: T0 + 10_000 + 6 * HOUR_MS,
    });
    expect(sentPlayView(gone)).toMatchObject({
      messageKey: 'receipt.no_longer_tracked',
      tone: 'neutral',
      settled: true,
    });
    expect(await w.history.unsettled()).toEqual([]);
    w.clock.set(T0 + 2 * DAY_MS);
    await w.refresh.execute({ reason: 'popup' });
    expect(w.gateway.reads).toHaveLength(1);
    expect(w.scheduler.when('receipts')).toBeUndefined();
  });

  // *Clear history* while a read is on its way: the answer has nothing to come back to.
  test('a play cleared from the history while its answer is read is not written back', async () => {
    const w = await withHistory(sent({ receipt: null }));
    w.gateway.onReceipt = async () => {
      await w.history.remove(['p1']);
      return { kind: 'ok', state: 'recorded', reason: null, titleId: 't1', questionKey: null };
    };
    w.clock.set(T0 + 10_000);
    await w.refresh.execute({ reason: 'scheduled' });
    expect(w.gateway.reads).toEqual(['s1']);
    expect(w.history.entries()).toEqual([]);
  });

  test('an outage counts as a read, so the schedule moves on instead of looping', async () => {
    const w = await withHistory(sent());
    answers(w, { kind: 'unavailable' });
    w.clock.set(T0 + 10_000);
    await w.refresh.execute({ reason: 'scheduled' });
    expect(w.history.entries()[0]).toMatchObject({
      receipt: { state: 'received', reason: null, titleId: null },
      receiptReadAt: T0 + 10_000,
    });
    expect(w.scheduler.when('receipts')).toBe(T0 + 60_000);
  });

  test('due reads go out a few at a time, every one of them made', async () => {
    const w = await withHistory(...plays(RECEIPT_READS_AT_ONCE + 2));
    let inFlight = 0;
    let most = 0;
    w.gateway.onReceipt = async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { kind: 'unavailable' };
    };
    w.clock.set(T0 + 10_000);
    await w.refresh.execute({ reason: 'scheduled' });
    expect(most).toBe(RECEIPT_READS_AT_ONCE);
    expect(w.gateway.reads).toHaveLength(RECEIPT_READS_AT_ONCE + 2);
  });

  // The reads already on their way are answered; none after them is made.
  test('credential_invalid stops the reads after its batch, breaks the connection and pauses the outbox', async () => {
    const w = await withHistory(...plays(RECEIPT_READS_AT_ONCE + 2));
    await w.outbox.add({
      playId: 'p3',
      viewingId: 'v3',
      body: BODY,
      createdAt: T0,
      watchedAt: T0,
      attempts: 0,
      nextAttemptAt: T0,
      state: 'pending',
      lastError: null,
    });
    answers(w, { kind: 'credential_invalid' });
    w.clock.set(T0 + 10_000);
    await w.refresh.execute({ reason: 'scheduled' });
    expect(w.gateway.reads).toHaveLength(RECEIPT_READS_AT_ONCE);
    expect(w.connection.current).toEqual({ kind: 'broken', reason: 'credential_invalid' });
    expect(w.outbox.entries()[0]?.state).toBe('paused');
    expect(w.scheduler.when('receipts')).toBeUndefined();
  });

  test('a play past 30 days is never read', async () => {
    const w = await withHistory(
      sent({
        sentAt: T0 - 31 * DAY_MS,
        receipt: { state: 'held', reason: 'plus_lapsed', titleId: null },
        receiptReadAt: T0 - 30 * DAY_MS - HOUR_MS,
      }),
    );
    await w.refresh.execute({ reason: 'popup' });
    await w.refresh.execute({ reason: 'scheduled' });
    expect(w.gateway.reads).toEqual([]);
  });

  test('nothing is read without a connection', async () => {
    const w = await withHistory(sent());
    await w.connection.set({ kind: 'none' });
    w.clock.set(T0 + 10_000);
    await w.refresh.execute({ reason: 'scheduled' });
    expect(w.gateway.reads).toEqual([]);
  });
});

describe('only the connection account’s plays are asked about', () => {
  test('nothing is read before a check has named the account', async () => {
    const w = makeWorld({ known: { kind: 'unread' } });
    await w.history.put(sent());
    w.clock.set(T0 + 10_000);
    await w.refresh.execute({ reason: 'scheduled' });
    expect(w.gateway.reads).toEqual([]);
  });

  test("another account's play, or one of none, is never read", async () => {
    const w = await withHistory(
      sent(),
      sent({ playId: 'p2', scrobbleId: 's2', accountKey: OTHER_ACCOUNT }),
      sent({ playId: 'p3', scrobbleId: 's3', accountKey: null }),
    );
    w.clock.set(T0 + 10_000);
    await w.refresh.execute({ reason: 'scheduled' });
    expect(w.gateway.reads).toEqual(['s1']);
  });
});
