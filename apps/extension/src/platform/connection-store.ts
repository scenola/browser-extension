/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The connection in IndexedDB (core's `ConnectionRepo`): its state, the credential, and the DPoP
// key pair stored as the `CryptoKeyPair` itself — non-extractable, in the extension origin's
// database, which pages and content scripts cannot open. Nothing here is ever written to
// `chrome.storage`, logged or exported.

import { isDpopKeyPair } from '@mt/api';
import type { AccountKey, AccountKnown, ConnectionRepo, ConnectionState } from '@mt/core';

import { isFiniteNumber, isRecord } from '../values';
import { LEAVING_KEY } from './idb';
import type { ConnectionRecord, LeavingMark, MtDatabase } from './idb';

const KEY = 'current';
const NONE: ConnectionState = { kind: 'none' };
/**
 * The strategies a stored connection may name. A store build makes `pkce_dpop` connections
 * alone; the test folds at build time, so the other name is not in its bundle, and a record
 * naming it — which no store build can write — reads as no connection.
 */
const STRATEGIES: ReadonlySet<unknown> = new Set(
  import.meta.env.MT_BUILD_MODE === 'store' ? ['pkce_dpop'] : ['pkce_dpop', 'personal_token'],
);
const BROKEN_REASONS: ReadonlySet<unknown> = new Set(['credential_invalid', 'key_missing']);

function readState(x: unknown): ConnectionState | null {
  if (!isRecord(x)) return null;
  if (x.kind === 'none') return NONE;
  if (x.kind === 'broken' && BROKEN_REASONS.has(x.reason)) {
    return { kind: 'broken', reason: x.reason as 'credential_invalid' | 'key_missing' };
  }
  if (
    x.kind === 'connected' &&
    typeof x.id === 'string' &&
    STRATEGIES.has(x.strategy) &&
    isFiniteNumber(x.connectedAt) &&
    isFiniteNumber(x.expiresAt)
  ) {
    return {
      kind: 'connected',
      id: x.id,
      strategy: x.strategy as 'pkce_dpop' | 'personal_token',
      connectedAt: x.connectedAt,
      expiresAt: x.expiresAt,
    };
  }
  return null;
}

/** The credential a request presents, as storage holds it. */
export interface StoredCredential {
  readonly strategy: 'pkce_dpop' | 'personal_token';
  readonly accessToken: string;
  /** `null` for a personal token, which is presented without a proof. */
  readonly pair: CryptoKeyPair | null;
}

export class IdbConnectionRepo implements ConnectionRepo {
  readonly #db: () => Promise<MtDatabase>;

  constructor(db: () => Promise<MtDatabase>) {
    this.#db = db;
  }

  async #record(): Promise<ConnectionRecord | null> {
    const record: unknown = await (await this.#db()).get('connection', KEY);
    return isRecord(record) ? (record as unknown as ConnectionRecord) : null;
  }

  /**
   * The state. A connection whose credential is gone, or a DPoP connection whose key pair is
   * gone or is not a usable non-extractable key (profile data cleared, another version wrote it),
   * is `broken`: it must be made again.
   */
  async get(): Promise<ConnectionState> {
    const record = await this.#record();
    if (record === null) return NONE;
    const state = readState(record.state);
    if (state === null) return NONE;
    if (state.kind !== 'connected') return state;
    if (record.connectionId !== state.id || typeof record.accessToken !== 'string') {
      return { kind: 'broken', reason: 'credential_invalid' };
    }
    if (state.strategy === 'pkce_dpop' && !isDpopKeyPair(record.keyPair)) {
      return { kind: 'broken', reason: 'key_missing' };
    }
    return state;
  }

  /**
   * Replaces the state, keeping the credential. A `connected` state is written only over the
   * connection its credential belongs to: a late write for a connection that was forgotten or
   * replaced since (an expiry slid after a disconnect) changes nothing. `none` drops the
   * credential and the key, as `forget` does.
   */
  async set(s: ConnectionState): Promise<void> {
    const tx = (await this.#db()).transaction('connection', 'readwrite');
    const current: unknown = await tx.store.get(KEY);
    const record = isRecord(current) ? (current as unknown as ConnectionRecord) : null;
    if (s.kind === 'none') {
      await tx.store.delete(KEY);
    } else if (s.kind === 'connected') {
      if (record?.connectionId === s.id) await tx.store.put({ ...record, state: s }, KEY);
    } else {
      // A broken connection still names its account: what is recorded meanwhile is that
      // account's, and the reconnect's check decides whether it is still the one here.
      const kept: ConnectionRecord = {
        state: s,
        connectionId: record?.connectionId ?? null,
        accessToken: record?.accessToken ?? null,
        keyPair: record?.keyPair ?? null,
      };
      await tx.store.put(
        record !== null && 'accountKey' in record
          ? { ...kept, accountKey: record.accountKey ?? null }
          : kept,
        KEY,
      );
    }
    await tx.done;
  }

  /**
   * Deletes the credential **and** the key, so the credential is unusable forever, and marks
   * what the connection left as leaving (`IdbAccountData`) — in one transaction, so no stop
   * between the two can leave the plays without a credential and without the mark.
   */
  async forget(): Promise<void> {
    const tx = (await this.#db()).transaction('connection', 'readwrite');
    const leaving: LeavingMark = { leaving: true };
    await Promise.all([tx.store.delete(KEY), tx.store.put(leaving, LEAVING_KEY), tx.done]);
  }

  /**
   * A new connection, with the credential and key it was made with — what a sign-in strategy
   * stores on success, before `Connect` sets the state again. Its account is not known until a
   * connection check names it.
   */
  async saveCredential(
    state: Extract<ConnectionState, { kind: 'connected' }>,
    accessToken: string,
    keyPair: CryptoKeyPair | null,
  ): Promise<void> {
    const record: ConnectionRecord = {
      state,
      connectionId: state.id,
      accessToken,
      keyPair,
      accountKey: null,
    };
    await (await this.#db()).put('connection', record, KEY);
  }

  /**
   * Which account the stored connection acts for. A record without the field was stored before
   * connections named their account (`inherited`); `null` is a sign-in's, not read yet.
   */
  async account(): Promise<AccountKnown> {
    const record = await this.#record();
    const state = record === null ? null : readState(record.state);
    if (record === null || state === null || state.kind === 'none') return { kind: 'none' };
    // Storage is read as hostile: the field is checked, not trusted to have its type.
    const key: unknown = (record as { readonly accountKey?: unknown }).accountKey;
    if (key === undefined) return { kind: 'inherited' };
    return typeof key === 'string' && key !== '' ? { kind: 'read', key } : { kind: 'unread' };
  }

  /** Keeps the key over the connection it was read for, in one transaction; else nothing. */
  async keepAccountKey(connectionId: string, key: AccountKey): Promise<void> {
    const tx = (await this.#db()).transaction('connection', 'readwrite');
    const current: unknown = await tx.store.get(KEY);
    const record = isRecord(current) ? (current as unknown as ConnectionRecord) : null;
    if (record?.connectionId === connectionId) {
      await tx.store.put({ ...record, accountKey: key }, KEY);
    }
    await tx.done;
  }

  /** The credential to present (the signer's input), or `null` without a connected one. */
  async credential(): Promise<StoredCredential | null> {
    const record = await this.#record();
    const state = record === null ? null : readState(record.state);
    if (record === null || state?.kind !== 'connected') return null;
    if (record.connectionId !== state.id || typeof record.accessToken !== 'string') return null;
    // A store build reads no personal-token connection (`STRATEGIES`); the fold drops the name.
    if (import.meta.env.MT_BUILD_MODE !== 'store' && state.strategy === 'personal_token') {
      return { strategy: state.strategy, accessToken: record.accessToken, pair: null };
    }
    return isDpopKeyPair(record.keyPair)
      ? { strategy: state.strategy, accessToken: record.accessToken, pair: record.keyPair }
      : null;
  }
}
