/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The last connection check in `chrome.storage.session`: which connection asked, when, and what
// the server answered. Kept for the browser session only, so a worker that restarts within the
// minute does not ask again, and the popup it serves still says what the server said. Nothing
// here is a secret (a status, two instants, a connection id); the area is closed to content
// scripts by default. A read is total: anything but a record is none.

import type { Browser } from 'wxt/browser';

import type {
  ConnectionCheckAnswer,
  ConnectionCheckRecord,
  ConnectionCheckStore,
} from '../composition/ports';
import { isInstant, isRecord } from '../values';

const KEY = 'connectionCheck';
const STATUSES: ReadonlySet<unknown> = new Set(['active', 'braked', 'suspended']);
const MAX_ID = 128;

function readAnswer(x: unknown): ConnectionCheckAnswer | null | undefined {
  if (x === null) return null;
  if (!isRecord(x) || !STATUSES.has(x.status) || !isInstant(x.checkedAt)) return undefined;
  if (x.expiresAt !== null && !isInstant(x.expiresAt)) return undefined;
  return {
    status: x.status as ConnectionCheckAnswer['status'],
    expiresAt: x.expiresAt,
    checkedAt: x.checkedAt,
  };
}

/** A stored value as a record, or `null` for anything that is not one. */
export function readCheckRecord(x: unknown): ConnectionCheckRecord | null {
  if (!isRecord(x)) return null;
  const { connectionId, askedAt } = x;
  if (typeof connectionId !== 'string' || connectionId.length === 0) return null;
  if (connectionId.length > MAX_ID || !isInstant(askedAt)) return null;
  const answer = readAnswer(x.answer);
  return answer === undefined ? null : { connectionId, askedAt, answer };
}

export class SessionConnectionCheckStore implements ConnectionCheckStore {
  readonly #area: Pick<Browser.storage.StorageArea, 'get' | 'set' | 'remove'>;

  constructor(area: Pick<Browser.storage.StorageArea, 'get' | 'set' | 'remove'>) {
    this.#area = area;
  }

  async get(): Promise<ConnectionCheckRecord | null> {
    const stored = await this.#area.get(KEY);
    return readCheckRecord(stored[KEY]);
  }

  async set(record: ConnectionCheckRecord | null): Promise<void> {
    if (record === null) await this.#area.remove(KEY);
    else await this.#area.set({ [KEY]: record });
  }
}
