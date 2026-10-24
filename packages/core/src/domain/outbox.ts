/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PlayBody } from './play';
import type { ReceiptState } from './receipts';
import { DAY_MS, HOUR_MS, MINUTE_MS } from './time';
import type { EpochMs } from './time';

/**
 * A reported viewing waiting to be delivered. It is stored before
 * any network call, so a play survives the worker stopping at any moment.
 */
export interface OutboxEntry {
  /** UUIDv7, the `Idempotency-Key`: every attempt of this play sends the same one. */
  readonly playId: string;
  readonly viewingId: string;
  readonly body: PlayBody;
  readonly createdAt: EpochMs;
  /**
   * What the entry's 29 days are counted from: the play's `watched_at`, or, for a start, which
   * carries none, the moment it was queued.
   */
  readonly watchedAt: EpochMs;
  /** Attempts sent so far. */
  readonly attempts: number;
  /** When a `pending` entry is next due; only a `pending` entry is ever due. */
  readonly nextAttemptAt: EpochMs;
  /** `paused` waits for a reconnect; `dead` is never sent again ("Couldn't send"). */
  readonly state: 'pending' | 'paused' | 'dead';
  readonly lastError: string | null;
  /**
   * The account it was recorded for: the connection's `account_key` as its check last read it.
   * `null` or absent: none was known (no connection, one not read yet, or an entry kept before
   * entries carried one). Only an entry of the connection's own account is ever sent.
   */
  readonly accountKey?: string | null;
}

/** What one attempt to send a play answered: the gateway maps the HTTP answer onto this. */
export type SendResult =
  | {
      readonly kind: 'accepted';
      readonly scrobbleId: string | null;
      readonly state: ReceiptState;
      readonly reason: string | null;
    }
  | { readonly kind: 'already_applied' }
  | { readonly kind: 'in_flight' }
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number }
  | { readonly kind: 'credential_invalid' }
  | { readonly kind: 'feature_closed' }
  | { readonly kind: 'rejected'; readonly status: number; readonly code: string | null }
  | { readonly kind: 'unavailable'; readonly detail: string };

export type OutboxStep =
  | {
      readonly kind: 'done';
      readonly scrobbleId: string | null;
      readonly receipt: { readonly state: ReceiptState; readonly reason: string | null } | null;
    }
  | { readonly kind: 'retry'; readonly at: EpochMs }
  | { readonly kind: 'pause_all' }
  | { readonly kind: 'dead'; readonly reason: string };

/** The backoff after a 5xx, a network error or a timeout, indexed by attempts already made. */
export const OUTBOX_BACKOFF_MS: readonly number[] = [1, 2, 5, 15, 60].map((m) => m * MINUTE_MS);
/** Past the ladder, every 6 h. */
export const OUTBOX_SLOW_RETRY_MS = 6 * HOUR_MS;
/** A backoff delay moves by up to this share either way, so many browsers do not retry in step. */
export const OUTBOX_JITTER = 0.1;
/** `409 idempotency.in_flight`: the first request under this key is still running. */
export const IN_FLIGHT_RETRY_MS = 30_000;
/** `404`: the feature is closed; hold and look again. */
export const FEATURE_CLOSED_RETRY_MS = 6 * HOUR_MS;
/** The server refuses a `watched_at` over 30 days back; the outbox stops a day before. */
export const OUTBOX_GIVE_UP_MS = 29 * DAY_MS;

/** A `random()` in `[0, 1]`; anything else (or `NaN`) is the middle, no jitter. */
function unit(random: () => number): number {
  const r = random();
  return Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0.5;
}

/** The delay before the next attempt after `attempts` failed ones, with jitter. */
export function backoffDelay(attempts: number, random: () => number): number {
  const index = Number.isInteger(attempts) && attempts > 0 ? attempts : 0;
  const base = OUTBOX_BACKOFF_MS[index] ?? OUTBOX_SLOW_RETRY_MS;
  return Math.round(base * (1 + OUTBOX_JITTER * (2 * unit(random) - 1)));
}

const giveUpAt = (entry: OutboxEntry): EpochMs => entry.watchedAt + OUTBOX_GIVE_UP_MS;

/** The entry can no longer be accepted: `watched_at` is more than 29 days old. */
export function isTooOld(entry: OutboxEntry, now: EpochMs): boolean {
  return now > giveUpAt(entry);
}

function retry(entry: OutboxEntry, at: EpochMs): OutboxStep {
  return at > giveUpAt(entry) ? { kind: 'dead', reason: 'too_old' } : { kind: 'retry', at };
}

/**
 * What the outbox does with one answer. `entry` is as it was before this
 * attempt (its `attempts` counts the earlier ones); `random` is the jitter source.
 */
export function outboxStep(
  entry: OutboxEntry,
  result: SendResult,
  now: EpochMs,
  random: () => number,
): OutboxStep {
  switch (result.kind) {
    case 'accepted':
      return {
        kind: 'done',
        scrobbleId: result.scrobbleId,
        receipt: { state: result.state, reason: result.reason },
      };
    case 'already_applied':
      return { kind: 'done', scrobbleId: null, receipt: null };
    case 'in_flight':
      return retry(entry, now + IN_FLIGHT_RETRY_MS);
    case 'rate_limited': {
      const s = result.retryAfterSeconds;
      return retry(
        entry,
        Number.isFinite(s) && s >= 0
          ? now + Math.max(s, 1) * 1000
          : now + backoffDelay(entry.attempts, random),
      );
    }
    case 'unavailable':
      return retry(entry, now + backoffDelay(entry.attempts, random));
    case 'feature_closed':
      return retry(entry, now + FEATURE_CLOSED_RETRY_MS);
    case 'credential_invalid':
      return { kind: 'pause_all' };
    case 'rejected':
      return { kind: 'dead', reason: rejectedReason(result) };
  }
}

/**
 * The account's lines did not count what was sent — a viewing short of the finish line, a start
 * short of the start line or with starts off — and nothing was kept (`ignored` /
 * `not_completed`, `scrobble_id: null`). The extension sends only what its copy of the lines
 * counts, so the lines changed since they were read, and are worth reading again now.
 */
export function notCounted(result: SendResult): boolean {
  return (
    result.kind === 'accepted' &&
    result.scrobbleId === null &&
    result.state === 'ignored' &&
    result.reason === 'not_completed'
  );
}

function rejectedReason(r: Extract<SendResult, { kind: 'rejected' }>): string {
  return `rejected:${String(r.status)}${r.code === null ? '' : `:${r.code}`}`;
}

/** How an attempt's answer is remembered on the entry (diagnostics only; never sent). */
export function describeSendResult(result: SendResult): string | null {
  switch (result.kind) {
    case 'accepted':
    case 'already_applied':
      return null;
    case 'rate_limited':
      return `rate_limited:${String(result.retryAfterSeconds)}`;
    case 'rejected':
      return rejectedReason(result);
    case 'unavailable':
      return `unavailable:${result.detail}`;
    case 'in_flight':
    case 'credential_invalid':
    case 'feature_closed':
      return result.kind;
  }
}
