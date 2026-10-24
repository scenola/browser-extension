/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The mock's bounded stores: every one has a cap and drops its oldest entry past it, and every
// entry expires on the mock's clock (state.ts says why).

const MINUTE_MS = 60_000;

/**
 * A map whose entries expire, in insertion order — every store here gives all its entries one
 * lifetime, so insertion order is expiry order and pruning stops at the first live entry. Past
 * `cap` entries the oldest is dropped.
 */
export class ExpiringMap<V> {
  readonly #entries = new Map<string, { value: V; expiresAt: number }>();
  readonly #cap: number;
  readonly #ttlMs: number;

  constructor(cap: number, ttlMs: number) {
    this.#cap = cap;
    this.#ttlMs = ttlMs;
  }

  get(key: string, nowMs: number): V | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= nowMs) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V, nowMs: number): void {
    this.#prune(nowMs);
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: nowMs + this.#ttlMs });
    while (this.#entries.size > this.#cap) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  #prune(nowMs: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt > nowMs) return;
      this.#entries.delete(key);
    }
  }
}

export type WindowVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly count: number; readonly retryAfterSeconds: number };

/**
 * The server's `check_rate_limit`: a sliding window of one minute
 * over the admitted requests. Full → refused, with the wait until the oldest slides out, rounded
 * up and never below one second; a refused request takes no slot.
 */
export class SlidingWindow {
  readonly #capacity: number;
  #admitted: number[] = [];

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  admit(nowMs: number): WindowVerdict {
    // ZREMRANGEBYSCORE -inf (now - window): an entry exactly a window old is gone.
    const live = this.#admitted.findIndex((at) => at > nowMs - MINUTE_MS);
    this.#admitted = live < 0 ? [] : this.#admitted.slice(live);
    const count = this.#admitted.length;
    if (count >= this.#capacity) {
      const oldest = this.#admitted[0] ?? nowMs;
      const waitMs = Math.max(0, oldest + MINUTE_MS - nowMs);
      return { allowed: false, count, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
    }
    this.#admitted.push(nowMs);
    return { allowed: true };
  }
}

/** Sliding windows by key (a caller's address and a bucket kind), at most `cap` keys. */
export class WindowsByKey {
  readonly #windows = new Map<string, SlidingWindow>();
  readonly #cap: number;

  constructor(cap: number) {
    this.#cap = cap;
  }

  admit(key: string, capacity: number, nowMs: number) {
    let window = this.#windows.get(key);
    if (window === undefined) {
      window = new SlidingWindow(capacity);
      this.#windows.set(key, window);
      while (this.#windows.size > this.#cap) {
        const oldest = this.#windows.keys().next();
        if (oldest.done === true) break;
        this.#windows.delete(oldest.value);
      }
    }
    return window.admit(nowMs);
  }
}
