/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The ports: what the use cases need from the browser, the network and storage. Each has a Chrome implementation in apps/extension and an in-memory one in
// ./testing/in-memory.ts. Small and role-specific, never one "BrowserApi".

import type { AccountRule, AccountRuleField } from '../domain/account-rule';
import type { ConnectionState } from '../domain/connection';
import type { PlaybackSample } from '../domain/coverage';
import type { Ignored } from '../domain/ignored';
import type { OutboxEntry, SendResult } from '../domain/outbox';
import type { PlayBody } from '../domain/play';
import type { MergedReading, ServiceReading, ViewingKey } from '../domain/reading';
import type { ReceiptTrack } from '../domain/receipt-schedule';
import type { ReceiptState } from '../domain/receipts';
import type { SettingsValue } from '../domain/settings';
import type { Snapshot } from '../domain/snapshot';
import type { Status } from '../domain/status';
import type { EpochMs } from '../domain/time';
import type { Viewing } from '../domain/viewing';

export interface Clock {
  now(): EpochMs;
  /** The viewer's UTC offset at that moment, in minutes east of UTC. */
  offsetMinutes(at: EpochMs): number;
}

export interface Ids {
  /** A fresh UUIDv7 for a play: its `Idempotency-Key`. */
  playId(): string;
  viewingId(): string;
}

/** A source of `[0, 1)`, for the outbox's jitter. */
export type Random = () => number;

/** A player heard with sound: its frame, and the last time it played since. */
export interface SoundedPlayer {
  readonly frameId: number;
  readonly at: EpochMs;
}

/** One tab's sitting: what it is bound to and what it saw last. */
export interface TabState {
  readonly tabId: number;
  /** The viewing this tab's samples go to; `null` until a reading has held still. */
  readonly viewingId: string | null;
  /**
   * The last sample that went to the tab's viewing (or bound it): the start of the next
   * one's coverage, and the timeline a later sample must continue to be that media's.
   * A sample that went nowhere does not replace it.
   */
  readonly lastSample: PlaybackSample | null;
  /**
   * The frame whose sample last went to the tab's viewing (or bound it): the open sitting's
   * player, which wins the election over every muted frame, playing or paused. Absent in a
   * state written before it existed, which reads as `null`.
   */
  readonly sittingFrameId?: number | null;
  /**
   * The element length of the media the tab's sitting plays, as its taken samples showed it
   * while no ad was showing (at least `MIN_CONTENT_SECONDS`); `null` while none did. A sample
   * of another length inside the sitting is from other media and adds nothing.
   * Absent in a state written before it existed, which reads as `null`.
   */
  readonly sittingLength?: number | null;
  /**
   * The player that played with sound in the tab's current stretch of playback, and when
   * that frame last played since. A muted sample of that frame may open the next
   * episode while the stretch lasts; `null` or absent, nothing muted opens. Persisted, since
   * the worker may stop between two episodes.
   */
  readonly sound?: SoundedPlayer | null;
  /**
   * Why the tab's playing media last went nowhere, and when: set by an observation
   * whose sample was playing and reached no viewing, cleared when a sample binds or reaches one.
   * Absent in a state written before it existed, which reads as `null` (`ignoredOf`).
   */
  readonly ignored?: Ignored | null;
  /** The latest reading that named something, and how many observations in a row named it. */
  readonly pendingReading: MergedReading | null;
  readonly stableCount: number;
  /** When the tab was last observed, whatever the observation did (retention). */
  readonly observedAt: EpochMs;
  /** When this tab's viewing was last reported, and the words it was reported as. */
  readonly addedAt: EpochMs | null;
  readonly addedLabel: string | null;
}

export interface ViewingStore {
  /**
   * The viewing a new sitting of this key joins: one `open` or `skipped`, the latest. A
   * viewing's key can change (a finer reading re-keys it), so this looks at the key it has now.
   */
  open(key: ViewingKey): Promise<Viewing | null>;
  /**
   * The `open` or `skipped` viewings whose reading names this title — `titleKey(v.reading)`,
   * which the platform indexes — latest first. Core decides which of them a reading joins.
   */
  openByTitle(titleKey: string): Promise<readonly Viewing[]>;
  byId(id: string): Promise<Viewing | null>;
  put(v: Viewing): Promise<void>;
  /** Every viewing, whatever its state, with no sample since before `t`. */
  idleBefore(t: EpochMs): Promise<readonly Viewing[]>;
  /** Removes viewings (retention: readings are kept ≤ 7 days idle). */
  remove(ids: readonly string[]): Promise<void>;
  tabState(tabId: number): Promise<TabState | null>;
  putTabState(s: TabState): Promise<void>;
  dropTab(tabId: number): Promise<void>;
  /**
   * Drops tab states not observed since before `t`: retention passes 7 days ago (their
   * readings are kept ≤ 7 days); the worker passes `now` at browser start, before any
   * observation, because tab ids do not survive a restart.
   */
  dropTabsIdleBefore(t: EpochMs): Promise<void>;
}

export interface Outbox {
  /** Inserts the entry; an entry with the same `playId` already there is kept as it is. */
  add(e: OutboxEntry): Promise<void>;
  /** `pending` entries with `nextAttemptAt ≤ now`, by `nextAttemptAt`, then `createdAt`, then id. */
  due(now: EpochMs): Promise<readonly OutboxEntry[]>;
  /** Every entry, in any state (the popup's "Couldn't send", retention). */
  list(): Promise<readonly OutboxEntry[]>;
  /** Replaces the entry with this `playId`. */
  put(e: OutboxEntry): Promise<void>;
  remove(playId: string): Promise<void>;
  /** Every `pending` entry becomes `paused`. */
  pauseAll(): Promise<void>;
  /** Every `paused` entry becomes `pending`, due at `now`. */
  resumeAll(now: EpochMs): Promise<void>;
  /** The earliest `nextAttemptAt` of a `pending` entry. */
  nextDueAt(): Promise<EpochMs | null>;
}

/** A play that was answered: what was sent, and what the server said (kept 30 days). */
export interface HistoryEntry extends ReceiptTrack {
  readonly playId: string;
  readonly body: PlayBody;
  readonly receipt: {
    readonly state: ReceiptState;
    readonly reason: string | null;
    readonly titleId: string | null;
    /**
     * The question this play waits on, shared by the plays one answer settles; `null` when it
     * waits on none. Opaque. Absent on an entry kept before the field existed: read that as `null`.
     */
    readonly questionKey?: string | null;
  } | null;
  /** The words it is shown by; empty when the play names nothing in words. */
  readonly label: string;
  /** The account it was sent for (`OutboxEntry.accountKey`). */
  readonly accountKey?: AccountKey | null;
}

export interface PlayHistory {
  /** Inserts or replaces by `playId`. */
  put(e: HistoryEntry): Promise<void>;
  /**
   * Replaces the entry with `change` of it, read and written in one step: an entry removed
   * meanwhile (*Clear history*, retention) stays removed, and nothing is written for it.
   */
  update(id: string, change: (e: HistoryEntry) => HistoryEntry): Promise<void>;
  byPlayId(id: string): Promise<HistoryEntry | null>;
  /** The latest `limit` entries, newest first. */
  recent(limit: number): Promise<readonly HistoryEntry[]>;
  /** Entries with a scrobble id whose answer is not settled (`isReceiptSettled`), oldest first. */
  unsettled(): Promise<readonly HistoryEntry[]>;
  /** The play ids of entries sent before `t`. */
  olderThan(t: EpochMs): Promise<readonly string[]>;
  remove(ids: readonly string[]): Promise<void>;
  /** Removes every entry, whenever it was sent (*Clear history*). */
  removeAll(): Promise<void>;
}

export type ReceiptResult =
  | {
      readonly kind: 'ok';
      readonly state: ReceiptState;
      readonly reason: string | null;
      readonly titleId: string | null;
      readonly questionKey: string | null;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'credential_invalid' }
  /**
   * A read to make again. `detail` says why (`http_404`, `timeout`, `network:TypeError`), for
   * the local diagnostics log only: nothing decides from it, and no page shows it.
   */
  | { readonly kind: 'unavailable'; readonly detail?: string };

/**
 * `POST /v1/integrations/plays` and `GET /v1/integrations/plays/{scrobble_id}`. It answers
 * every HTTP outcome as a result, retrying a DPoP nonce once itself; a throw is
 * a fault, which the outbox treats as `unavailable`.
 */
export interface PlaysGateway {
  send(playId: string, body: PlayBody): Promise<SendResult>;
  receipt(scrobbleId: string): Promise<ReceiptResult>;
}

/** A connection's status as the plays route applies it. */
export type ConnectionStatus = 'active' | 'braked' | 'suspended';

/** What `GET /v1/integrations/connection` answered. */
export type ConnectionCheckResult =
  | {
      readonly kind: 'ok';
      readonly status: ConnectionStatus;
      /** When the presented credential stops working unless a stored play moves it; `null`: never. */
      readonly expiresAt: EpochMs | null;
      /** The account's rule, off where the answer did not state it in bounds. */
      readonly rule: AccountRule;
      /** The account this connection acts for. */
      readonly accountKey: AccountKey;
      /** The rule's fields that were missing or out of bounds, for the diagnostics log. */
      readonly ruleInvalid?: readonly AccountRuleField[];
    }
  /** `401 scrobbling.credential_invalid`: revoked, expired or rotated out — reconnect. */
  | { readonly kind: 'credential_invalid' }
  /** Anything else: nothing is known. `detail` is for the diagnostics log only. */
  | { readonly kind: 'unavailable'; readonly detail: string };

/**
 * `GET /v1/integrations/connection` with the stored credential: whether the
 * connection still works, and until when. Reading it slides nothing and writes nothing on the
 * server. Total over every answer; a throw is a fault, read as `unavailable`.
 */
export interface ConnectionGateway {
  check(): Promise<ConnectionCheckResult>;
}

/**
 * The account's rule for the current connection, as its last connection check read it. Read only
 * from what is kept, never by asking the server before a play; off while none was read.
 */
export interface AccountRules {
  get(): Promise<AccountRule>;
}

export type ConnectResult =
  | { readonly kind: 'connected'; readonly state: Extract<ConnectionState, { kind: 'connected' }> }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'code_invalid' }
  | { readonly kind: 'proof_invalid' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'limit_reached' }
  | { readonly kind: 'feature_closed' }
  /**
   * Try again. `detail` says why (`http_503`, `timeout`), for the local diagnostics log only:
   * the worker logs it and leaves it out of what a page receives.
   */
  | { readonly kind: 'unavailable'; readonly detail?: string };

/** How a connection is made; it stores its own credential and key. */
export interface AuthStrategy {
  readonly id: 'pkce_dpop' | 'personal_token' | 'test';
  connect(input?: { readonly token?: string }): Promise<ConnectResult>;
}

export interface ConnectionRepo {
  get(): Promise<ConnectionState>;
  set(s: ConnectionState): Promise<void>;
  /**
   * Deletes the credential **and** the key, so the credential is unusable forever, and in the
   * same write marks what the connection left in this browser as leaving (`AccountData`): a stop
   * before that is removed cannot hand it to the next connection.
   */
  forget(): Promise<void>;
  /** Which account the stored connection acts for, as far as this browser knows. */
  account(): Promise<AccountKnown>;
  /**
   * Keeps the key a connection check read for `connectionId`; nothing when another connection
   * (or none) is stored by then.
   */
  keepAccountKey(connectionId: string, key: AccountKey): Promise<void>;
}

/**
 * The account a connection acts for, as `GET /v1/integrations/connection` names it
 * (`account_key`): opaque — compared whole, never read into, never logged or shown.
 */
export type AccountKey = string;

/** What the stored connection is known to act for. */
export type AccountKnown =
  /** No connection is stored. */
  | { readonly kind: 'none' }
  /** A sign-in made it and no check has named its account yet: what is kept may be another's. */
  | { readonly kind: 'unread' }
  /** Stored before connections named their account: what is kept was recorded under it. */
  | { readonly kind: 'inherited' }
  | { readonly kind: 'read'; readonly key: AccountKey };

/**
 * What a connection leaves in this browser: the plays and starts not sent yet, the history of
 * what was sent, the viewings and every tab's state. It belongs to the account it was recorded
 * for, so it goes when the person disconnects, and nothing of it is sent once it is leaving.
 */
export interface AccountData {
  /** A disconnect forgot the credential and has not removed what it left yet. */
  leaving(): Promise<boolean>;
  /** Removes all of it, and the mark `ConnectionRepo.forget` left, in one write. */
  remove(): Promise<void>;
  /**
   * Every play, start, history entry and viewing that carries no account key gets `key`, in one
   * write: they were recorded under the connection that has just named its account.
   */
  adopt(key: AccountKey): Promise<void>;
  /**
   * Removes every play, start, history entry and viewing that carries another key or none, in
   * one write; how many plays and starts not sent yet went with them.
   */
  keepOnly(key: AccountKey): Promise<number>;
}

export type AlarmName = 'outbox' | 'receipts' | 'expire';

/** Wake-ups that survive the worker stopping; one pending alarm per name. */
export interface Scheduler {
  /**
   * Earliest wins: while an alarm of this name is pending at an earlier time, a later `at`
   * leaves it as it is (a 6-hourly read never pushes back a +10 s one). To move an alarm
   * later, `clear` it first. An alarm that fired is no longer pending.
   */
  at(name: AlarmName, when: EpochMs): Promise<void>;
  clear(name: AlarmName): Promise<void>;
}

export interface StatusDisplay {
  /** `null` is the default for every tab. */
  show(tabId: number | null, s: Status): Promise<void>;
}

export interface Settings {
  get(): Promise<SettingsValue>;
  patch(p: Partial<SettingsValue>): Promise<void>;
}

/** Runs a service module's `interpret(snapshot)` in the sandbox. */
export interface Interpreter {
  interpret(serviceId: string, snapshot: Snapshot): Promise<ServiceReading | null>;
}

/** The local diagnostics log: only its retention is core's. */
export interface Diagnostics {
  /** Removes entries from before `before`, then all but the newest `keep`. */
  prune(before: EpochMs, keep: number): Promise<void>;
}
