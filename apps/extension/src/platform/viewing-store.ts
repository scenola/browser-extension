/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Open viewings and tab states in IndexedDB (core's `ViewingStore`). Every record is read
// through a shape check: a record this version cannot read — written by another version, or
// damaged — is absent, never a throw inside the viewing lock.

import { titleKey } from '@mt/core';
import type { EpochMs, TabState, ViewingKey, ViewingStore, Viewing } from '@mt/core';

import { isFiniteNumber, isRecord } from '../values';
import type { MtDatabase, StoredViewing } from './idb';

const VIEWING_STATES: ReadonlySet<unknown> = new Set(['open', 'reported', 'skipped', 'expired']);
const nullableNumber = (x: unknown): boolean => x === null || isFiniteNumber(x);
const nullableString = (x: unknown): boolean => x === null || typeof x === 'string';

function isPlaybackSample(x: unknown): boolean {
  return (
    isRecord(x) &&
    isFiniteNumber(x.at) &&
    isFiniteNumber(x.position) &&
    nullableNumber(x.duration) &&
    typeof x.paused === 'boolean' &&
    typeof x.ended === 'boolean' &&
    isFiniteNumber(x.rate) &&
    typeof x.adPlaying === 'boolean' &&
    typeof x.muted === 'boolean' &&
    isFiniteNumber(x.visibleArea)
  );
}

const isReading = (x: unknown): boolean => isRecord(x) && Array.isArray(x.sources);

function isViewing(x: unknown): x is StoredViewing {
  return (
    isRecord(x) &&
    typeof x.id === 'string' &&
    typeof x.key === 'string' &&
    nullableString(x.serviceId) &&
    isReading(x.reading) &&
    Array.isArray(x.ranges) &&
    nullableNumber(x.durationSeconds) &&
    nullableNumber(x.statedDurationSeconds) &&
    nullableNumber(x.elementDurationSeconds) &&
    nullableNumber(x.lastElementDuration) &&
    typeof x.contentEnded === 'boolean' &&
    isFiniteNumber(x.firstSeenAt) &&
    isFiniteNumber(x.lastSampleAt) &&
    typeof x.incognito === 'boolean' &&
    typeof x.engaged === 'boolean' &&
    VIEWING_STATES.has(x.state) &&
    nullableString(x.reportedPlayId)
  );
}

/** The fields every tab state has; the three optional ones are read by `readTabState`. */
function isTabState(x: unknown): x is TabState {
  return (
    isRecord(x) &&
    isFiniteNumber(x.tabId) &&
    nullableString(x.viewingId) &&
    (x.lastSample === null || isPlaybackSample(x.lastSample)) &&
    (x.pendingReading === null || isReading(x.pendingReading)) &&
    isFiniteNumber(x.stableCount) &&
    isFiniteNumber(x.observedAt) &&
    nullableNumber(x.addedAt) &&
    nullableString(x.addedLabel)
  );
}

const isFrameId = (x: unknown): x is number =>
  typeof x === 'number' && Number.isInteger(x) && x >= 0;

const isSoundedPlayer = (x: unknown): boolean =>
  isRecord(x) && isFrameId(x.frameId) && isFiniteNumber(x.at);

/** A media length in seconds, as core's `sittingLengthOf` reads one: finite and positive. */
const isLength = (x: unknown): x is number => isFiniteNumber(x) && x > 0;

/**
 * A stored tab state, or `null` when it is not one. `sittingFrameId`, `sound` and `sittingLength`
 * are optional — a state written before they existed has none — and one that is there but is not
 * such a value is read as absent, never as the state being unreadable: core treats an absent one
 * as "no sitting frame", "nothing heard with sound", "no sitting length known".
 */
function readTabState(x: unknown): TabState | null {
  if (!isTabState(x)) return null;
  const { sittingFrameId, sound, sittingLength, ...rest } = x;
  return {
    ...rest,
    ...(sittingFrameId === null || isFrameId(sittingFrameId) ? { sittingFrameId } : {}),
    ...(sound === null || isSoundedPlayer(sound) ? { sound } : {}),
    ...(sittingLength === null || isLength(sittingLength) ? { sittingLength } : {}),
  };
}

/** The stored record without its index field. */
function viewingOf(stored: StoredViewing): Viewing {
  if (stored.titleKey === undefined) return stored;
  return Object.fromEntries(
    Object.entries(stored).filter(([field]) => field !== 'titleKey'),
  ) as unknown as Viewing;
}

const joinable = (v: Viewing): boolean => v.state === 'open' || v.state === 'skipped';

export class IdbViewingStore implements ViewingStore {
  readonly #db: () => Promise<MtDatabase>;

  constructor(db: () => Promise<MtDatabase>) {
    this.#db = db;
  }

  async open(key: ViewingKey): Promise<Viewing | null> {
    const records = await (await this.#db()).getAllFromIndex('viewings', 'key', key);
    let found: Viewing | null = null;
    for (const record of records) {
      if (!isViewing(record)) continue;
      const v = viewingOf(record);
      if (joinable(v) && (found === null || v.lastSampleAt > found.lastSampleAt)) found = v;
    }
    return found;
  }

  async openByTitle(title: string): Promise<readonly Viewing[]> {
    const records = await (await this.#db()).getAllFromIndex('viewings', 'titleKey', title);
    return records
      .filter(isViewing)
      .map(viewingOf)
      .filter(joinable)
      .sort((a, b) => b.lastSampleAt - a.lastSampleAt);
  }

  async byId(id: string): Promise<Viewing | null> {
    const record = await (await this.#db()).get('viewings', id);
    return isViewing(record) ? viewingOf(record) : null;
  }

  async put(v: Viewing): Promise<void> {
    const title = titleKey(v.reading);
    const stored: StoredViewing = title === null ? v : { ...v, titleKey: title };
    await (await this.#db()).put('viewings', stored);
  }

  async idleBefore(t: EpochMs): Promise<readonly Viewing[]> {
    const records = await (
      await this.#db()
    ).getAllFromIndex('viewings', 'lastSampleAt', IDBKeyRange.upperBound(t, true));
    return records.filter(isViewing).map(viewingOf);
  }

  async remove(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const tx = (await this.#db()).transaction('viewings', 'readwrite');
    await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done]);
  }

  async tabState(tabId: number): Promise<TabState | null> {
    const record = await (await this.#db()).get('tabs', tabId);
    return readTabState(record);
  }

  async putTabState(s: TabState): Promise<void> {
    await (await this.#db()).put('tabs', s);
  }

  async dropTab(tabId: number): Promise<void> {
    await (await this.#db()).delete('tabs', tabId);
  }

  async dropTabsIdleBefore(t: EpochMs): Promise<void> {
    const tx = (await this.#db()).transaction('tabs', 'readwrite');
    let cursor = await tx.store.openCursor();
    while (cursor !== null) {
      const value: unknown = cursor.value;
      // A record this version cannot read is dropped too: tab states never outlive a restart.
      if (!isTabState(value) || value.observedAt < t) await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  }
}
