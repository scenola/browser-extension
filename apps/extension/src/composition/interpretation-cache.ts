/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What a module answered for a snapshot, so it is not asked again. A module's `interpret` is
// pure, so the same snapshot — page state included — gives the same reading, and asking the
// offscreen sandbox again is a round trip for nothing. The collector sends a snapshot
// when it changed or every 15 s, so a viewing would otherwise be interpreted four times a minute.
//
// Keyed by the service and a SHA-256 of the snapshot as JSON; in memory only (a restarted
// worker asks again), bounded, the least recently used going first. Only a reading is kept: a
// `null` is also what a failed or timed-out interpretation answers, which must be asked again.

import type { ServiceReading, Snapshot } from '@mt/core';

/** Snapshots remembered; a tab plays one thing at a time, so a few per open tab is plenty. */
const MAX_ENTRIES = 64;

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

export class InterpretationCache {
  readonly #entries = new Map<string, ServiceReading>();

  /** The cache key of a service's snapshot. */
  async keyOf(serviceId: string, snapshot: Snapshot): Promise<string> {
    const json = new TextEncoder().encode(JSON.stringify(snapshot));
    return `${serviceId}:${hex(await crypto.subtle.digest('SHA-256', json))}`;
  }

  /** The reading kept for `key`, now the most recently used; `undefined` when none is. */
  get(key: string): ServiceReading | undefined {
    const reading = this.#entries.get(key);
    if (reading === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, reading);
    return reading;
  }

  set(key: string, reading: ServiceReading): void {
    this.#entries.delete(key);
    this.#entries.set(key, reading);
    while (this.#entries.size > MAX_ENTRIES) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  /** *Clear all local data*: nothing of what was played stays, in memory either. */
  clear(): void {
    this.#entries.clear();
  }
}
