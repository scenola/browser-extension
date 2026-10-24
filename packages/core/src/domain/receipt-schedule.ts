/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { sentPlayView } from './receipts';
import type { ReceiptState } from './receipts';
import { DAY_MS, HOUR_MS, MINUTE_MS } from './time';
import type { EpochMs } from './time';

/** What the schedule needs to know about a sent play. */
export interface ReceiptTrack {
  /** `null`: nothing to read back (the `202` kept nothing, or its answer was lost). */
  readonly scrobbleId: string | null;
  readonly sentAt: EpochMs;
  /** The latest answer: the `202`'s, then each read's. */
  readonly receipt: { readonly state: ReceiptState; readonly reason: string | null } | null;
  /** The latest read attempt, answered or not; `null` before the first. */
  readonly receiptReadAt: EpochMs | null;
  /** When a read answered `404`: the server no longer has it, and tracking it ended. */
  readonly receiptGoneAt: EpochMs | null;
}

export type ReceiptReadReason = 'scheduled' | 'popup';

/** The server usually decides within seconds: the first read soon after the `202`. */
export const RECEIPT_FIRST_READ_MS = 10_000;
/**
 * The reads a play still waiting gets by alarm, as times after it was sent: close together while
 * the server is most likely to answer — its decision within seconds, its own backstop within
 * minutes when that is late — so a play does not sit at *Sent* long enough to look lost.
 */
export const RECEIPT_EARLY_READS_MS: readonly number[] = Object.freeze([
  RECEIPT_FIRST_READ_MS,
  MINUTE_MS,
  5 * MINUTE_MS,
  15 * MINUTE_MS,
]);
/** After them, every hour through the play's first day: a lookup that takes longer… */
export const RECEIPT_WAITING_REREAD_MS = HOUR_MS;
/**
 * …then every 6 hours: a play still waiting a day on waits for the person to answer in the app,
 * and opening the popup reads it then anyway…
 */
export const RECEIPT_LATE_REREAD_MS = 6 * HOUR_MS;
/** …which is when the hourly reads give way to the late ones. */
export const RECEIPT_LATE_AFTER_MS = DAY_MS;
/** Whenever the popup opens, a waiting play is read at most once a minute. */
export const RECEIPT_POPUP_REREAD_MS = MINUTE_MS;
/** Opening the popup reads the receipts of the waiting plays, newest first, at most this many. */
export const RECEIPT_POPUP_READ_LIMIT = 20;
/** Receipts read at the same time, in a pass with many due. */
export const RECEIPT_READS_AT_ONCE = 4;
/** A receipt is not read once the play is 30 days old, the longest the history keeps one. */
export const RECEIPT_READ_WINDOW_MS = 30 * DAY_MS;

/** The server will not change this answer, or it no longer has one to give. */
export function isReceiptSettled(t: ReceiptTrack): boolean {
  return sentPlayView(t).settled;
}

/**
 * The alarm's next read after the last one: the next early read, else an hour on, else — a day
 * after sending — six.
 */
function scheduledAfter(sentAt: EpochMs, readAt: EpochMs): EpochMs {
  const early = RECEIPT_EARLY_READS_MS.find((after) => sentAt + after > readAt);
  if (early !== undefined) return sentAt + early;
  const late = readAt - sentAt >= RECEIPT_LATE_AFTER_MS;
  return readAt + (late ? RECEIPT_LATE_REREAD_MS : RECEIPT_WAITING_REREAD_MS);
}

/**
 * When the receipt should next be read, or `null` when it never should again (settled,
 * nothing to read, or 30 days after sending). The time may be past: the read is overdue.
 * Opening the popup may read a play sooner than its alarm, a minute after its last read, but
 * never before the first: the `202` has only just answered.
 */
export function nextReceiptRead(
  t: ReceiptTrack,
  reason: ReceiptReadReason,
  now: EpochMs,
): EpochMs | null {
  if (t.scrobbleId === null || isReceiptSettled(t)) return null;
  const deadline = t.sentAt + RECEIPT_READ_WINDOW_MS;
  if (now > deadline) return null;
  let at: EpochMs;
  if (t.receiptReadAt === null) {
    at = t.sentAt + RECEIPT_FIRST_READ_MS;
  } else {
    const scheduled = scheduledAfter(t.sentAt, t.receiptReadAt);
    at =
      reason === 'popup'
        ? Math.min(scheduled, t.receiptReadAt + RECEIPT_POPUP_REREAD_MS)
        : scheduled;
  }
  return at > deadline ? null : at;
}
