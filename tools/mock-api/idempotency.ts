/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The idempotency layer, as the server's `IdempotencyMiddleware` runs it: BEGIN (replay, refuse
// or lock), the request's first write taking the key's claim, FINISH (record and unlock).

import { createHash } from 'node:crypto';

import { ExpiringMap } from './stores.ts';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/** `idempotency_ttl_seconds`, `RECORD_GRACE`, `idempotency_lock_ttl_seconds`. */
const RECORD_TTL_MS = 24 * HOUR_MS;
const CLAIM_TTL_MS = RECORD_TTL_MS + 5 * MINUTE_MS;
const LOCK_TTL_MS = 45 * SECOND_MS;
const MAX_RECORDS = 10_000;

/** A response as the layer records it: what a replay sends back. */
export interface StoredAnswer {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}

/** A recorded answer, or the tombstone: "applied, its answer is gone" (`409 already_applied`). */
export type Recorded = StoredAnswer | 'tombstone';

export interface Lock {
  readonly token: number;
  readonly recordKey: string;
  readonly claimKey: string;
  readonly hash: string;
  claimed: boolean;
}

type Begin =
  | { readonly kind: 'replay'; readonly answer: Recorded }
  | { readonly kind: 'mismatch' }
  | { readonly kind: 'in_flight' }
  | { readonly kind: 'locked'; readonly lock: Lock };

export type Claim =
  | { readonly kind: 'claimed' }
  | { readonly kind: 'mismatch' }
  | { readonly kind: 'replay'; readonly answer: Recorded }
  | { readonly kind: 'already_applied' };

/**
 * Records and locks are keyed by the key **as sent** (the server's Redis keys), the claim by the
 * canonical UUID (`core.idempotency_claim`): a retry that changes only its key's spelling runs,
 * meets the claim, finds no record under its own spelling and is answered `409 already_applied`
 * — as the server answers it.
 */
export class Idempotency {
  readonly #records = new ExpiringMap<{ hash: string; answer: Recorded }>(
    MAX_RECORDS,
    RECORD_TTL_MS,
  );
  readonly #claims = new ExpiringMap<string>(MAX_RECORDS, CLAIM_TTL_MS);
  readonly #locks = new Map<string, { token: number; expiresAt: number }>();
  #tokens = 0;

  /** BEGIN: a recorded answer → replay it (or `mismatch`); a live lock → `in_flight`; else lock. */
  begin(scope: string, rawKey: string, canonicalKey: string, hash: string, nowMs: number): Begin {
    const recordKey = `${scope}\n${rawKey}`;
    const recorded = this.#records.get(recordKey, nowMs);
    if (recorded !== undefined) {
      return recorded.hash === hash
        ? { kind: 'replay', answer: recorded.answer }
        : { kind: 'mismatch' };
    }
    const held = this.#locks.get(recordKey);
    if (held !== undefined && held.expiresAt > nowMs) return { kind: 'in_flight' };
    this.#tokens += 1;
    const token = this.#tokens;
    this.#locks.set(recordKey, { token, expiresAt: nowMs + LOCK_TTL_MS });
    return {
      kind: 'locked',
      lock: { token, recordKey, claimKey: `${scope}\n${canonicalKey}`, hash, claimed: false },
    };
  }

  /** The request's first write: take the claim, or answer the conflict as `_answer_conflict`. */
  claim(lock: Lock, nowMs: number): Claim {
    const stored = this.#claims.get(lock.claimKey, nowMs);
    if (stored === undefined) {
      this.#claims.set(lock.claimKey, lock.hash, nowMs);
      lock.claimed = true;
      return { kind: 'claimed' };
    }
    if (stored !== lock.hash) return { kind: 'mismatch' };
    const recorded = this.#records.get(lock.recordKey, nowMs);
    if (recorded?.hash === lock.hash) {
      return { kind: 'replay', answer: recorded.answer };
    }
    return { kind: 'already_applied' };
  }

  /** FINISH: record what `_what_to_record` would, and release the lock if it is still ours. */
  finish(lock: Lock, record: Recorded | null, nowMs: number): void {
    if (record !== null) {
      this.#records.set(lock.recordKey, { hash: lock.hash, answer: record }, nowMs);
    }
    if (this.#locks.get(lock.recordKey)?.token === lock.token) this.#locks.delete(lock.recordKey);
  }
}

/** `idempotency.request_hash`: SHA-256 of `method|path|query|body`. */
export function requestHash(method: string, path: string, query: string, body: Uint8Array): string {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from(`${method}|${path}|${query}|`, 'utf8'), body]))
    .digest('hex');
}
