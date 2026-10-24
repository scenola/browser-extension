/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';

import {
  FEATURE_CLOSED_RETRY_MS,
  IN_FLIGHT_RETRY_MS,
  OUTBOX_BACKOFF_MS,
  OUTBOX_GIVE_UP_MS,
  OUTBOX_JITTER,
  OUTBOX_SLOW_RETRY_MS,
  backoffDelay,
  isTooOld,
  outboxStep,
} from './outbox';
import type { OutboxEntry, SendResult } from './outbox';
import { DAY_MS, HOUR_MS, MINUTE_MS } from './time';

const WATCHED = 1_800_000_000_000;
const NOW = WATCHED + 5_000;
/** `random() = 0.5` is the middle of the jitter band: no jitter. */
const NO_JITTER = (): number => 0.5;

function entry(o: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    playId: 'p1',
    viewingId: 'v1',
    body: { kind: 'movie', title: 'Film', watched_at: '2027-01-15T08:00:00+00:00' },
    createdAt: WATCHED,
    watchedAt: WATCHED,
    attempts: 0,
    nextAttemptAt: WATCHED,
    state: 'pending',
    lastError: null,
    ...o,
  };
}

const step = (result: SendResult, e: OutboxEntry = entry(), now = NOW) =>
  outboxStep(e, result, now, NO_JITTER);

describe('constants', () => {
  test('are pinned', () => {
    expect(OUTBOX_BACKOFF_MS).toEqual([1, 2, 5, 15, 60].map((m) => m * MINUTE_MS));
    expect(OUTBOX_SLOW_RETRY_MS).toBe(6 * HOUR_MS);
    expect(OUTBOX_JITTER).toBe(0.1);
    expect(IN_FLIGHT_RETRY_MS).toBe(30_000);
    expect(FEATURE_CLOSED_RETRY_MS).toBe(6 * HOUR_MS);
    expect(OUTBOX_GIVE_UP_MS).toBe(29 * DAY_MS);
  });
});

describe('outboxStep: one answer each', () => {
  test('202: done; the scrobble id and the answer are kept', () => {
    expect(step({ kind: 'accepted', scrobbleId: 's1', state: 'received', reason: null })).toEqual({
      kind: 'done',
      scrobbleId: 's1',
      receipt: { state: 'received', reason: null },
    });
  });

  test('202 that keeps nothing (scrobble_id null): done, its answer is the receipt', () => {
    expect(
      step({ kind: 'accepted', scrobbleId: null, state: 'dismissed', reason: 'account_deletion' }),
    ).toEqual({
      kind: 'done',
      scrobbleId: null,
      receipt: { state: 'dismissed', reason: 'account_deletion' },
    });
  });

  test('409 idempotency.already_applied: done; stored before, its answer is gone', () => {
    expect(step({ kind: 'already_applied' })).toEqual({
      kind: 'done',
      scrobbleId: null,
      receipt: null,
    });
  });

  test('409 idempotency.in_flight: retry in 30 s with the same key', () => {
    expect(step({ kind: 'in_flight' })).toEqual({ kind: 'retry', at: NOW + 30_000 });
  });

  test('429: retry after retry_after_seconds, no jitter', () => {
    expect(step({ kind: 'rate_limited', retryAfterSeconds: 42 })).toEqual({
      kind: 'retry',
      at: NOW + 42_000,
    });
  });

  test('429 with an unusable retry_after: the backoff, never NaN or the past', () => {
    expect(step({ kind: 'rate_limited', retryAfterSeconds: Number.NaN })).toEqual({
      kind: 'retry',
      at: NOW + MINUTE_MS,
    });
    expect(step({ kind: 'rate_limited', retryAfterSeconds: -5 })).toEqual({
      kind: 'retry',
      at: NOW + MINUTE_MS,
    });
  });

  test('5xx, a network error or the 15 s timeout: the backoff by attempts', () => {
    expect(step({ kind: 'unavailable', detail: 'http_503' })).toEqual({
      kind: 'retry',
      at: NOW + MINUTE_MS,
    });
    expect(step({ kind: 'unavailable', detail: 'timeout' }, entry({ attempts: 2 }))).toEqual({
      kind: 'retry',
      at: NOW + 5 * MINUTE_MS,
    });
  });

  test('401 scrobbling.credential_invalid: pause the whole outbox', () => {
    expect(step({ kind: 'credential_invalid' })).toEqual({ kind: 'pause_all' });
  });

  test('404 (the feature is closed): hold, retry 6-hourly', () => {
    expect(step({ kind: 'feature_closed' })).toEqual({ kind: 'retry', at: NOW + 6 * HOUR_MS });
  });

  test('422 and 413: a dead letter, never retried', () => {
    expect(step({ kind: 'rejected', status: 422, code: 'validation.failed' })).toEqual({
      kind: 'dead',
      reason: 'rejected:422:validation.failed',
    });
    expect(step({ kind: 'rejected', status: 413, code: null })).toEqual({
      kind: 'dead',
      reason: 'rejected:413',
    });
  });

  // 401 scrobbling.dpop_nonce_required is answered inside the gateway (one immediate
  // retry with the new nonce); it never reaches the outbox as a result.
});

describe('the backoff', () => {
  test('1, 2, 5, 15, 60 min, then every 6 h (jitter fixed to 0)', () => {
    const delays = [0, 1, 2, 3, 4, 5, 6].map((attempts) => backoffDelay(attempts, NO_JITTER));
    expect(delays).toEqual([
      MINUTE_MS,
      2 * MINUTE_MS,
      5 * MINUTE_MS,
      15 * MINUTE_MS,
      60 * MINUTE_MS,
      6 * HOUR_MS,
      6 * HOUR_MS,
    ]);
  });

  test('jitter stays within ±10 %', () => {
    expect(backoffDelay(4, () => 0)).toBe(54 * MINUTE_MS);
    expect(backoffDelay(4, () => 1)).toBe(66 * MINUTE_MS);
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(1, Math.random.bind(Math));
      expect(d).toBeGreaterThanOrEqual(0.9 * 2 * MINUTE_MS);
      expect(d).toBeLessThanOrEqual(1.1 * 2 * MINUTE_MS);
    }
  });

  test('a random source out of range is clamped, never a negative delay', () => {
    expect(backoffDelay(0, () => -3)).toBe(54_000);
    expect(backoffDelay(0, () => 7)).toBe(66_000);
    expect(backoffDelay(0, () => Number.NaN)).toBe(MINUTE_MS);
  });
});

describe('giving up: watched_at + 29 d', () => {
  const late = WATCHED + 29 * DAY_MS - 10_000;

  test.each<[string, SendResult]>([
    ['in_flight', { kind: 'in_flight' }],
    ['rate_limited', { kind: 'rate_limited', retryAfterSeconds: 60 }],
    ['unavailable', { kind: 'unavailable', detail: 'network' }],
    ['feature_closed', { kind: 'feature_closed' }],
  ])('a %s retry that would land after it is dead(too_old)', (_, result) => {
    expect(step(result, entry({ attempts: 5 }), late)).toEqual({
      kind: 'dead',
      reason: 'too_old',
    });
  });

  test('a retry landing exactly at 29 d is still a retry', () => {
    expect(
      step(
        { kind: 'rate_limited', retryAfterSeconds: 10 },
        entry(),
        WATCHED + 29 * DAY_MS - 10_000,
      ),
    ).toEqual({ kind: 'retry', at: WATCHED + 29 * DAY_MS });
  });

  test('an answer that ends the entry is never too old', () => {
    expect(step({ kind: 'already_applied' }, entry(), WATCHED + 40 * DAY_MS).kind).toBe('done');
  });

  test('isTooOld: strictly after watched_at + 29 d', () => {
    expect(isTooOld(entry(), WATCHED + 29 * DAY_MS)).toBe(false);
    expect(isTooOld(entry(), WATCHED + 29 * DAY_MS + 1)).toBe(true);
  });
});
