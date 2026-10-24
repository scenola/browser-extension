/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The outbox in IndexedDB (core's `Outbox`): a reported viewing is stored here before any
// network call, so a play survives the worker stopping at any instruction.

import type { EpochMs, Outbox, OutboxEntry } from '@mt/core';

import { isFiniteNumber, isRecord } from '../values';
import type { MtDatabase } from './idb';

const STATES: ReadonlySet<unknown> = new Set(['pending', 'paused', 'dead']);

function isEntry(x: unknown): x is OutboxEntry {
  return (
    isRecord(x) &&
    typeof x.playId === 'string' &&
    typeof x.viewingId === 'string' &&
    isRecord(x.body) &&
    isFiniteNumber(x.createdAt) &&
    isFiniteNumber(x.watchedAt) &&
    isFiniteNumber(x.attempts) &&
    isFiniteNumber(x.nextAttemptAt) &&
    STATES.has(x.state) &&
    (x.lastError === null || typeof x.lastError === 'string')
  );
}

const byDue = (a: OutboxEntry, b: OutboxEntry): number =>
  a.nextAttemptAt - b.nextAttemptAt ||
  a.createdAt - b.createdAt ||
  (a.playId < b.playId ? -1 : a.playId > b.playId ? 1 : 0);

export class IdbOutbox implements Outbox {
  readonly #db: () => Promise<MtDatabase>;

  constructor(db: () => Promise<MtDatabase>) {
    this.#db = db;
  }

  /** Inserts the entry unless one with its `playId` is there: read and write in one transaction. */
  async add(e: OutboxEntry): Promise<void> {
    const tx = (await this.#db()).transaction('outbox', 'readwrite');
    if ((await tx.store.getKey(e.playId)) === undefined) await tx.store.add(e);
    await tx.done;
  }

  async due(now: EpochMs): Promise<readonly OutboxEntry[]> {
    const records = await (
      await this.#db()
    ).getAllFromIndex('outbox', 'nextAttemptAt', IDBKeyRange.upperBound(now));
    return records.filter((e) => isEntry(e) && e.state === 'pending').sort(byDue);
  }

  async list(): Promise<readonly OutboxEntry[]> {
    return (await (await this.#db()).getAll('outbox')).filter(isEntry);
  }

  async put(e: OutboxEntry): Promise<void> {
    await (await this.#db()).put('outbox', e);
  }

  async remove(playId: string): Promise<void> {
    await (await this.#db()).delete('outbox', playId);
  }

  async pauseAll(): Promise<void> {
    await this.#rewrite((e) => (e.state === 'pending' ? { ...e, state: 'paused' } : null));
  }

  async resumeAll(now: EpochMs): Promise<void> {
    await this.#rewrite((e) =>
      e.state === 'paused' ? { ...e, state: 'pending', nextAttemptAt: now } : null,
    );
  }

  async nextDueAt(): Promise<EpochMs | null> {
    const tx = (await this.#db()).transaction('outbox', 'readonly');
    const index = tx.store.index('nextAttemptAt');
    let cursor = await index.openCursor();
    while (cursor !== null) {
      const value: unknown = cursor.value;
      if (isEntry(value) && value.state === 'pending') return value.nextAttemptAt;
      cursor = await cursor.continue();
    }
    return null;
  }

  /** Every entry `change` answers for is replaced, in one transaction. */
  async #rewrite(change: (e: OutboxEntry) => OutboxEntry | null): Promise<void> {
    const tx = (await this.#db()).transaction('outbox', 'readwrite');
    let cursor = await tx.store.openCursor();
    while (cursor !== null) {
      const value: unknown = cursor.value;
      const next = isEntry(value) ? change(value) : null;
      if (next !== null) await cursor.update(next);
      cursor = await cursor.continue();
    }
    await tx.done;
  }
}
