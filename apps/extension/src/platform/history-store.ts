/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What was sent and what the server answered, in IndexedDB (core's `PlayHistory`): kept as long
// as the settings say (`historyDays`), read by *What was sent* and the popup's lists.

import { isReceiptSettled } from '@mt/core';
import type { EpochMs, HistoryEntry, PlayHistory } from '@mt/core';

import { isFiniteNumber, isRecord } from '../values';
import type { MtDatabase } from './idb';

const nullableNumber = (x: unknown): boolean => x === null || isFiniteNumber(x);

function isEntry(x: unknown): x is HistoryEntry {
  return (
    isRecord(x) &&
    typeof x.playId === 'string' &&
    (x.scrobbleId === null || typeof x.scrobbleId === 'string') &&
    isRecord(x.body) &&
    isFiniteNumber(x.sentAt) &&
    (x.receipt === null || (isRecord(x.receipt) && typeof x.receipt.state === 'string')) &&
    nullableNumber(x.receiptReadAt) &&
    nullableNumber(x.receiptGoneAt) &&
    typeof x.label === 'string'
  );
}

export class IdbPlayHistory implements PlayHistory {
  readonly #db: () => Promise<MtDatabase>;

  constructor(db: () => Promise<MtDatabase>) {
    this.#db = db;
  }

  async put(e: HistoryEntry): Promise<void> {
    await (await this.#db()).put('history', e);
  }

  /** One transaction: a removal cannot fall between the read and the write. */
  async update(id: string, change: (e: HistoryEntry) => HistoryEntry): Promise<void> {
    const tx = (await this.#db()).transaction('history', 'readwrite');
    const record: unknown = await tx.store.get(id);
    if (isEntry(record)) await tx.store.put(change(record));
    await tx.done;
  }

  async byPlayId(id: string): Promise<HistoryEntry | null> {
    const record = await (await this.#db()).get('history', id);
    return isEntry(record) ? record : null;
  }

  /** Newest first, reading no more records than it returns (plus unreadable ones). */
  async recent(limit: number): Promise<readonly HistoryEntry[]> {
    const wanted = Number.isFinite(limit) ? Math.max(Math.floor(limit), 0) : 0;
    const out: HistoryEntry[] = [];
    if (wanted === 0) return out;
    const tx = (await this.#db()).transaction('history', 'readonly');
    const index = tx.store.index('sentAt');
    for (
      let cursor = await index.openCursor(null, 'prev');
      cursor !== null && out.length < wanted;
      cursor = await cursor.continue()
    ) {
      const value: unknown = cursor.value;
      if (isEntry(value)) out.push(value);
    }
    return out;
  }

  async unsettled(): Promise<readonly HistoryEntry[]> {
    return (await (await this.#db()).getAllFromIndex('history', 'sentAt'))
      .filter((e) => isEntry(e) && e.scrobbleId !== null && !isReceiptSettled(e))
      .sort((a, b) => a.sentAt - b.sentAt);
  }

  async olderThan(t: EpochMs): Promise<readonly string[]> {
    const keys = await (
      await this.#db()
    ).getAllKeysFromIndex('history', 'sentAt', IDBKeyRange.upperBound(t, true));
    return keys;
  }

  async remove(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const tx = (await this.#db()).transaction('history', 'readwrite');
    await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
  }

  async removeAll(): Promise<void> {
    await (await this.#db()).clear('history');
  }
}
