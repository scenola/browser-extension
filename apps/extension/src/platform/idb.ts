/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The extension's IndexedDB: open viewings and tab states, the outbox, the history of what was
// sent, the connection — its credential and its non-extractable key pair, which only the
// extension origin can open — and the diagnostics log. Settings live in `chrome.storage.local`
// (settings.ts), never here; this database is never synced.

import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';

import type {
  AccountData,
  AccountKey,
  ConnectionState,
  HistoryEntry,
  OutboxEntry,
  TabState,
  Viewing,
} from '@mt/core';

const DATABASE_NAME = 'mediatracker';
const DATABASE_VERSION = 1;

/** A viewing as stored: the viewing, with its title key alongside for the `titleKey` index. */
export type StoredViewing = Viewing & { readonly titleKey?: string };

/** The one connection: its state, and the credential and key it was made with. */
export interface ConnectionRecord {
  readonly state: ConnectionState;
  /** The connection the credential below belongs to (`ConnectionState.id`). */
  readonly connectionId: string | null;
  readonly accessToken: string | null;
  /** Stored as the `CryptoKeyPair` itself: a structured clone keeps it non-extractable. */
  readonly keyPair: CryptoKeyPair | null;
  /**
   * The account the connection acts for, as its check last read it (`account_key`); `null`
   * until one did. Absent from a record stored before connections named their account.
   */
  readonly accountKey?: string | null;
}

/**
 * Beside the connection, under `LEAVING_KEY`: a disconnect forgot the credential and has not
 * removed what the account left here yet. Written with the forgetting, deleted with the removal.
 */
export interface LeavingMark {
  readonly leaving: true;
}

export const LEAVING_KEY = 'leaving';

export type DiagnosticsDetail = Readonly<Record<string, string | number | boolean | null>>;

export interface DiagnosticsEntry {
  readonly at: number;
  readonly event: string;
  readonly detail: DiagnosticsDetail;
}

interface MtSchema extends DBSchema {
  viewings: {
    key: string;
    value: StoredViewing;
    indexes: { key: string; lastSampleAt: number; titleKey: string };
  };
  tabs: { key: number; value: TabState };
  outbox: { key: string; value: OutboxEntry; indexes: { nextAttemptAt: number } };
  history: { key: string; value: HistoryEntry; indexes: { sentAt: number } };
  connection: { key: string; value: ConnectionRecord | LeavingMark };
  diagnostics: { key: number; value: DiagnosticsEntry; indexes: { at: number } };
}

export type MtDatabase = IDBPDatabase<MtSchema>;

/** Every store, for a wipe (*Clear all local data*). */
const STORE_NAMES = ['viewings', 'tabs', 'outbox', 'history', 'connection', 'diagnostics'] as const;

/**
 * The stores whose records belong to the account they were recorded for, which a disconnect
 * removes; the diagnostics log too, since it tells what happened while that account was here.
 */
const ACCOUNT_STORES = ['viewings', 'tabs', 'outbox', 'history', 'diagnostics'] as const;

/**
 * Opens (and on first use creates) the database. A connection another context asks to close for
 * an upgrade is closed; the next `openDatabase` reopens it. A test opens it afresh to see what a
 * restarted worker would.
 *
 * @public
 */
export function openDatabase(): Promise<MtDatabase> {
  return openDB<MtSchema>(DATABASE_NAME, DATABASE_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const viewings = db.createObjectStore('viewings', { keyPath: 'id' });
        viewings.createIndex('key', 'key');
        viewings.createIndex('lastSampleAt', 'lastSampleAt');
        viewings.createIndex('titleKey', 'titleKey');
        db.createObjectStore('tabs', { keyPath: 'tabId' });
        const outbox = db.createObjectStore('outbox', { keyPath: 'playId' });
        outbox.createIndex('nextAttemptAt', 'nextAttemptAt');
        const history = db.createObjectStore('history', { keyPath: 'playId' });
        history.createIndex('sentAt', 'sentAt');
        db.createObjectStore('connection');
        const diagnostics = db.createObjectStore('diagnostics', { autoIncrement: true });
        diagnostics.createIndex('at', 'at');
      }
    },
    blocking(_current, _blocked, event) {
      (event.target as IDBDatabase | null)?.close();
    },
  });
}

/**
 * One open database shared by every store of a worker, reopened after it was closed or failed.
 * Stores take this function, not a database, so a test can hand each a fresh open.
 */
export function sharedDatabase(
  open: () => Promise<MtDatabase> = openDatabase,
): () => Promise<MtDatabase> {
  let current: Promise<MtDatabase> | null = null;
  return () => {
    if (current === null) {
      const opening = open().then((db) => {
        const forget = (): void => {
          if (current === opening) current = null;
        };
        db.addEventListener('close', forget);
        db.addEventListener('versionchange', forget);
        return db;
      });
      opening.catch(() => {
        if (current === opening) current = null;
      });
      current = opening;
    }
    return current;
  };
}

/** Removes every record of every store in one transaction (the connection included). */
export async function wipeDatabase(db: () => Promise<MtDatabase>): Promise<void> {
  const tx = (await db()).transaction([...STORE_NAMES], 'readwrite');
  await Promise.all([...STORE_NAMES.map((name) => tx.objectStore(name).clear()), tx.done]);
}

/**
 * What a connection leaves in this browser (core's `AccountData`): every record of the account's
 * stores, and the mark `IdbConnectionRepo.forget` wrote, removed in one transaction — so a worker
 * stopped mid-way leaves either all of it, still marked, or none of it.
 */
export class IdbAccountData implements AccountData {
  readonly #db: () => Promise<MtDatabase>;

  constructor(db: () => Promise<MtDatabase>) {
    this.#db = db;
  }

  async leaving(): Promise<boolean> {
    return (await (await this.#db()).getKey('connection', LEAVING_KEY)) !== undefined;
  }

  async remove(): Promise<void> {
    const tx = (await this.#db()).transaction([...ACCOUNT_STORES, 'connection'], 'readwrite');
    await Promise.all([
      ...ACCOUNT_STORES.map((name) => tx.objectStore(name).clear()),
      tx.objectStore('connection').delete(LEAVING_KEY),
      tx.done,
    ]);
  }

  async adopt(key: AccountKey): Promise<void> {
    await this.#each(key, (carried) => (carried === null ? 'tag' : 'keep'));
  }

  async keepOnly(key: AccountKey): Promise<number> {
    const removed = await this.#each(key, (carried) => (carried === key ? 'keep' : 'delete'));
    return removed.outbox;
  }

  /**
   * Every record of the stores that carry an account key, in one transaction: `decide` says, from
   * the key it carries, whether it takes `key`, goes, or stays. A stop leaves all of them as they
   * were, or none. Answers how many went from each store.
   */
  async #each(
    key: AccountKey,
    decide: (carried: AccountKey | null) => 'tag' | 'delete' | 'keep',
  ): Promise<Record<(typeof KEYED_STORES)[number], number>> {
    const removed = { outbox: 0, history: 0, viewings: 0 };
    const tx = (await this.#db()).transaction([...KEYED_STORES], 'readwrite');
    await Promise.all([
      ...KEYED_STORES.map(async (name) => {
        let cursor = await tx.objectStore(name).openCursor();
        while (cursor !== null) {
          const value: unknown = cursor.value;
          const carried = isObject(value) ? keyOfRecord(value) : null;
          const action = decide(carried);
          if (action === 'delete') {
            await cursor.delete();
            removed[name] += 1;
          } else if (action === 'tag' && isObject(value)) {
            // The record as it was, with the key added: its own store's shape.
            await cursor.update({ ...value, accountKey: key } as never);
          }
          cursor = await cursor.continue();
        }
      }),
      tx.done,
    ]);
    return removed;
  }
}

/** The stores whose records say which account they were recorded for. */
const KEYED_STORES = ['outbox', 'history', 'viewings'] as const;

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/** A record's account key; `null` when it carries none (or one that is not a key). */
function keyOfRecord(record: Record<string, unknown>): AccountKey | null {
  const key = record.accountKey;
  return typeof key === 'string' && key !== '' ? key : null;
}
