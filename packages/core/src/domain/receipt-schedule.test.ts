/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';

import {
  RECEIPT_EARLY_READS_MS,
  RECEIPT_FIRST_READ_MS,
  RECEIPT_LATE_AFTER_MS,
  RECEIPT_LATE_REREAD_MS,
  RECEIPT_POPUP_REREAD_MS,
  RECEIPT_READS_AT_ONCE,
  RECEIPT_READ_WINDOW_MS,
  RECEIPT_WAITING_REREAD_MS,
  isReceiptSettled,
  nextReceiptRead,
} from './receipt-schedule';
import type { ReceiptReadReason, ReceiptTrack } from './receipt-schedule';
import { DAY_MS, HOUR_MS, MINUTE_MS } from './time';

const SENT = 1_800_000_000_000;

function track(o: Partial<ReceiptTrack> = {}): ReceiptTrack {
  return {
    scrobbleId: 's1',
    sentAt: SENT,
    receipt: { state: 'received', reason: null },
    receiptReadAt: null,
    receiptGoneAt: null,
    ...o,
  };
}

const next = (t: ReceiptTrack, reason: ReceiptReadReason = 'scheduled', now = SENT) =>
  nextReceiptRead(t, reason, now);

describe('constants', () => {
  test('are pinned', () => {
    expect(RECEIPT_FIRST_READ_MS).toBe(10_000);
    expect(RECEIPT_EARLY_READS_MS).toEqual([10_000, MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS]);
    expect(RECEIPT_WAITING_REREAD_MS).toBe(HOUR_MS);
    expect(RECEIPT_LATE_REREAD_MS).toBe(6 * HOUR_MS);
    expect(RECEIPT_LATE_AFTER_MS).toBe(DAY_MS);
    expect(RECEIPT_POPUP_REREAD_MS).toBe(MINUTE_MS);
    expect(RECEIPT_READS_AT_ONCE).toBe(4);
    expect(RECEIPT_READ_WINDOW_MS).toBe(30 * DAY_MS);
  });
});

describe('nextReceiptRead', () => {
  const WAITING = [
    { state: 'received', reason: null },
    { state: 'awaiting_catalog', reason: null },
    { state: 'needs_confirmation', reason: 'text_only' },
    { state: 'held', reason: 'plus_lapsed' },
  ] as const;

  test('the first read is at +10 s', () => {
    expect(next(track())).toBe(SENT + 10_000);
  });

  test('a play still waiting is read at +1 min, +5 min and +15 min, whatever it waits on', () => {
    for (const receipt of WAITING) {
      const after = (readAt: number) => next(track({ receipt, receiptReadAt: readAt }));
      expect(after(SENT + 10_000)).toBe(SENT + MINUTE_MS);
      expect(after(SENT + MINUTE_MS)).toBe(SENT + 5 * MINUTE_MS);
      expect(after(SENT + 5 * MINUTE_MS)).toBe(SENT + 15 * MINUTE_MS);
    }
  });

  test('after the early reads: every hour through the first day', () => {
    for (const receipt of WAITING) {
      for (const readAt of [SENT + 15 * MINUTE_MS, SENT + 3 * HOUR_MS, SENT + DAY_MS - 1]) {
        expect(next(track({ receipt, receiptReadAt: readAt }))).toBe(readAt + HOUR_MS);
      }
    }
  });

  // A play still waiting a day on waits for the person; the popup reads it whenever it opens.
  test('a day after sending: every 6 hours', () => {
    for (const receipt of WAITING) {
      for (const readAt of [SENT + DAY_MS, SENT + 9 * DAY_MS]) {
        expect(next(track({ receipt, receiptReadAt: readAt }))).toBe(readAt + 6 * HOUR_MS);
        expect(next(track({ receipt, receiptReadAt: readAt }), 'popup')).toBe(readAt + MINUTE_MS);
      }
    }
  });

  test('a read between the early ones is followed by the next early one', () => {
    expect(next(track({ receiptReadAt: SENT + 3 * MINUTE_MS }))).toBe(SENT + 5 * MINUTE_MS);
  });

  test('the popup reads a play a minute after its last read, sooner than its alarm', () => {
    expect(next(track({ receiptReadAt: SENT + MINUTE_MS }), 'popup')).toBe(SENT + 2 * MINUTE_MS);
    const readAt = SENT + HOUR_MS;
    expect(next(track({ receiptReadAt: readAt }), 'popup')).toBe(readAt + MINUTE_MS);
    // An early read already a minute away is not put off.
    expect(next(track({ receiptReadAt: SENT + 10_000 }), 'popup')).toBe(SENT + MINUTE_MS);
  });

  test('the popup never reads before the first read: the 202 has only just answered', () => {
    expect(next(track(), 'popup')).toBe(SENT + 10_000);
  });

  test('an overdue read is due at its own time, which may be past', () => {
    expect(next(track(), 'scheduled', SENT + HOUR_MS)).toBe(SENT + 10_000);
  });

  test('a settled answer is never read again', () => {
    for (const receipt of [
      { state: 'recorded', reason: null },
      { state: 'duplicate', reason: null },
      { state: 'ignored', reason: 'not_completed' },
      { state: 'dismissed', reason: 'user' },
      { state: 'expired', reason: null },
    ] as const) {
      expect(next(track({ receipt, receiptReadAt: SENT + 10_000 }), 'popup')).toBeNull();
    }
  });

  test('nothing to read back (scrobble_id null): never', () => {
    expect(next(track({ scrobbleId: null }))).toBeNull();
  });

  test('a receipt the server no longer has: never, and settled', () => {
    const gone = track({
      receipt: { state: 'needs_confirmation', reason: 'text_only' },
      receiptReadAt: SENT + 10_000,
      receiptGoneAt: SENT + 10_000,
    });
    expect(next(gone, 'popup', SENT + HOUR_MS)).toBeNull();
    expect(isReceiptSettled(gone)).toBe(true);
  });

  test('30 days after sending: never, whether the read would fall after it or is overdue', () => {
    const at = SENT + 30 * DAY_MS - 30 * MINUTE_MS;
    const t = track({
      receipt: { state: 'needs_confirmation', reason: 'text_only' },
      receiptReadAt: at,
    });
    expect(next(t, 'scheduled', at)).toBeNull();
    expect(next(t, 'popup', at)).toBe(at + MINUTE_MS);
    expect(next(t, 'popup', SENT + 30 * DAY_MS + 1)).toBeNull();
  });
});

describe('isReceiptSettled', () => {
  test('follows the receipt view', () => {
    expect(isReceiptSettled(track({ receipt: { state: 'recorded', reason: null } }))).toBe(true);
    expect(isReceiptSettled(track({ receipt: { state: 'held', reason: 'braked' } }))).toBe(false);
    expect(isReceiptSettled(track({ receipt: null }))).toBe(false);
  });
});
