/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// In-memory implementations of every port, for core's tests and the app's.
// Exported as `@mt/core/testing`; nothing in production imports them.

import { DEFAULT_RULE } from '../../domain/account-rule';
import type { AccountRule } from '../../domain/account-rule';
import type { ConnectionState } from '../../domain/connection';
import type { OutboxEntry, SendResult } from '../../domain/outbox';
import type { PlayBody } from '../../domain/play';
import { titleKey } from '../../domain/reading';
import type { ServiceReading, ViewingKey } from '../../domain/reading';
import { isReceiptSettled } from '../../domain/receipt-schedule';
import { DEFAULT_SETTINGS } from '../../domain/settings';
import type { SettingsValue } from '../../domain/settings';
import type { Snapshot } from '../../domain/snapshot';
import type { Status } from '../../domain/status';
import type { EpochMs } from '../../domain/time';
import type { Viewing } from '../../domain/viewing';
import type {
  AccountData,
  AccountKey,
  AccountKnown,
  AccountRules,
  AlarmName,
  AuthStrategy,
  Clock,
  ConnectResult,
  ConnectionRepo,
  Diagnostics,
  HistoryEntry,
  Ids,
  Interpreter,
  Outbox,
  PlayHistory,
  PlaysGateway,
  ReceiptResult,
  Scheduler,
  Settings,
  StatusDisplay,
  TabState,
  ViewingStore,
} from '../ports';

export class FakeClock implements Clock {
  #now: EpochMs;
  readonly #offsetMinutes: number;

  constructor(now: EpochMs, offsetMinutes = 0) {
    this.#now = now;
    this.#offsetMinutes = offsetMinutes;
  }

  now(): EpochMs {
    return this.#now;
  }

  offsetMinutes(): number {
    return this.#offsetMinutes;
  }

  set(t: EpochMs): void {
    this.#now = t;
  }

  advance(ms: number): void {
    this.#now += ms;
  }
}

/** `play-1`, `play-2`, … and `viewing-1`, …: predictable in assertions. */
export class SequentialIds implements Ids {
  #plays = 0;
  #viewings = 0;

  playId(): string {
    this.#plays += 1;
    return `play-${String(this.#plays)}`;
  }

  viewingId(): string {
    this.#viewings += 1;
    return `viewing-${String(this.#viewings)}`;
  }
}

export class InMemoryViewingStore implements ViewingStore {
  readonly #viewings = new Map<string, Viewing>();
  readonly #tabs = new Map<number, TabState>();
  /** How many times each write ran, for tests that count storage writes. */
  readonly writes = { put: 0, putTabState: 0, dropTab: 0, remove: 0 };

  all(): readonly Viewing[] {
    return [...this.#viewings.values()];
  }

  /** Every tab's state, for tests. */
  tabs(): readonly TabState[] {
    return [...this.#tabs.values()];
  }

  /** Every viewing and tab state goes (`InMemoryAccountData.remove`). */
  clear(): void {
    this.#viewings.clear();
    this.#tabs.clear();
  }

  open(key: ViewingKey): Promise<Viewing | null> {
    let found: Viewing | null = null;
    for (const v of this.#viewings.values()) {
      if (v.key !== key || (v.state !== 'open' && v.state !== 'skipped')) continue;
      if (found === null || v.lastSampleAt > found.lastSampleAt) found = v;
    }
    return Promise.resolve(found);
  }

  openByTitle(title: string): Promise<readonly Viewing[]> {
    return Promise.resolve(
      this.all()
        .filter(
          (v) => (v.state === 'open' || v.state === 'skipped') && titleKey(v.reading) === title,
        )
        .sort((a, b) => b.lastSampleAt - a.lastSampleAt),
    );
  }

  byId(id: string): Promise<Viewing | null> {
    return Promise.resolve(this.#viewings.get(id) ?? null);
  }

  put(v: Viewing): Promise<void> {
    this.writes.put += 1;
    this.#viewings.set(v.id, v);
    return Promise.resolve();
  }

  idleBefore(t: EpochMs): Promise<readonly Viewing[]> {
    return Promise.resolve(this.all().filter((v) => v.lastSampleAt < t));
  }

  remove(ids: readonly string[]): Promise<void> {
    this.writes.remove += 1;
    for (const id of ids) this.#viewings.delete(id);
    return Promise.resolve();
  }

  tabState(tabId: number): Promise<TabState | null> {
    return Promise.resolve(this.#tabs.get(tabId) ?? null);
  }

  putTabState(s: TabState): Promise<void> {
    this.writes.putTabState += 1;
    this.#tabs.set(s.tabId, s);
    return Promise.resolve();
  }

  dropTab(tabId: number): Promise<void> {
    this.writes.dropTab += 1;
    this.#tabs.delete(tabId);
    return Promise.resolve();
  }

  dropTabsIdleBefore(t: EpochMs): Promise<void> {
    for (const [tabId, s] of [...this.#tabs]) {
      if (s.observedAt < t) this.#tabs.delete(tabId);
    }
    return Promise.resolve();
  }
}

const byDue = (a: OutboxEntry, b: OutboxEntry): number =>
  a.nextAttemptAt - b.nextAttemptAt ||
  a.createdAt - b.createdAt ||
  (a.playId < b.playId ? -1 : a.playId > b.playId ? 1 : 0);

export class InMemoryOutbox implements Outbox {
  readonly #entries = new Map<string, OutboxEntry>();

  entries(): readonly OutboxEntry[] {
    return [...this.#entries.values()];
  }

  clear(): void {
    this.#entries.clear();
  }

  add(e: OutboxEntry): Promise<void> {
    if (!this.#entries.has(e.playId)) this.#entries.set(e.playId, e);
    return Promise.resolve();
  }

  due(now: EpochMs): Promise<readonly OutboxEntry[]> {
    return Promise.resolve(
      this.entries()
        .filter((e) => e.state === 'pending' && e.nextAttemptAt <= now)
        .sort(byDue),
    );
  }

  list(): Promise<readonly OutboxEntry[]> {
    return Promise.resolve(this.entries());
  }

  put(e: OutboxEntry): Promise<void> {
    this.#entries.set(e.playId, e);
    return Promise.resolve();
  }

  remove(playId: string): Promise<void> {
    this.#entries.delete(playId);
    return Promise.resolve();
  }

  pauseAll(): Promise<void> {
    for (const e of this.entries()) {
      if (e.state === 'pending') this.#entries.set(e.playId, { ...e, state: 'paused' });
    }
    return Promise.resolve();
  }

  resumeAll(now: EpochMs): Promise<void> {
    for (const e of this.entries()) {
      if (e.state === 'paused') {
        this.#entries.set(e.playId, { ...e, state: 'pending', nextAttemptAt: now });
      }
    }
    return Promise.resolve();
  }

  nextDueAt(): Promise<EpochMs | null> {
    const times = this.entries()
      .filter((e) => e.state === 'pending')
      .map((e) => e.nextAttemptAt);
    return Promise.resolve(times.length === 0 ? null : Math.min(...times));
  }
}

export class InMemoryPlayHistory implements PlayHistory {
  readonly #entries = new Map<string, HistoryEntry>();

  entries(): readonly HistoryEntry[] {
    return [...this.#entries.values()];
  }

  clear(): void {
    this.#entries.clear();
  }

  put(e: HistoryEntry): Promise<void> {
    this.#entries.set(e.playId, e);
    return Promise.resolve();
  }

  update(id: string, change: (e: HistoryEntry) => HistoryEntry): Promise<void> {
    const entry = this.#entries.get(id);
    if (entry !== undefined) this.#entries.set(id, change(entry));
    return Promise.resolve();
  }

  byPlayId(id: string): Promise<HistoryEntry | null> {
    return Promise.resolve(this.#entries.get(id) ?? null);
  }

  recent(limit: number): Promise<readonly HistoryEntry[]> {
    return Promise.resolve(
      [...this.entries()].sort((a, b) => b.sentAt - a.sentAt).slice(0, Math.max(limit, 0)),
    );
  }

  unsettled(): Promise<readonly HistoryEntry[]> {
    return Promise.resolve(
      this.entries()
        .filter((e) => e.scrobbleId !== null && !isReceiptSettled(e))
        .sort((a, b) => a.sentAt - b.sentAt),
    );
  }

  olderThan(t: EpochMs): Promise<readonly string[]> {
    return Promise.resolve(
      this.entries()
        .filter((e) => e.sentAt < t)
        .map((e) => e.playId),
    );
  }

  remove(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.#entries.delete(id);
    return Promise.resolve();
  }

  removeAll(): Promise<void> {
    this.#entries.clear();
    return Promise.resolve();
  }
}

export class InMemoryConnectionRepo implements ConnectionRepo {
  #state: ConnectionState;
  /** How many times the credential and key were forgotten. */
  forgets = 0;
  /** The mark `forget` leaves: what the connection left here is leaving (`InMemoryAccountData`). */
  leaving = false;
  /** What the stored connection is known to act for; a new connection's is `unread`. */
  known: AccountKnown;

  constructor(initial: ConnectionState = { kind: 'none' }, known?: AccountKnown) {
    this.#state = initial;
    this.known = known ?? (initial.kind === 'none' ? { kind: 'none' } : { kind: 'inherited' });
  }

  get current(): ConnectionState {
    return this.#state;
  }

  get(): Promise<ConnectionState> {
    return Promise.resolve(this.#state);
  }

  /** A connected state of another connection is a new one, as a sign-in stores it. */
  set(s: ConnectionState): Promise<void> {
    const before = this.#state;
    if (s.kind === 'none') this.known = { kind: 'none' };
    else if (s.kind === 'connected' && (before.kind !== 'connected' || before.id !== s.id)) {
      this.known = { kind: 'unread' };
    }
    this.#state = s;
    return Promise.resolve();
  }

  forget(): Promise<void> {
    this.forgets += 1;
    this.#state = { kind: 'none' };
    this.known = { kind: 'none' };
    this.leaving = true;
    return Promise.resolve();
  }

  account(): Promise<AccountKnown> {
    return Promise.resolve(this.known);
  }

  keepAccountKey(connectionId: string, key: AccountKey): Promise<void> {
    if (this.#state.kind === 'connected' && this.#state.id === connectionId) {
      this.known = { kind: 'read', key };
    }
    return Promise.resolve();
  }
}

const carries = (record: { readonly accountKey?: string | null }, key: AccountKey): boolean =>
  record.accountKey === key;

interface AccountStores {
  readonly connection: InMemoryConnectionRepo;
  readonly outbox: InMemoryOutbox;
  readonly history: InMemoryPlayHistory;
  readonly viewings: InMemoryViewingStore;
}

/**
 * What a connection leaves, over the in-memory stores. `stopBeforeRemove` makes the next
 * `remove` throw before it removes anything, as a worker stopped between the two steps would.
 */
export class InMemoryAccountData implements AccountData {
  readonly #stores: AccountStores;
  stopBeforeRemove = false;
  /** How many times it was removed. */
  removals = 0;

  constructor(stores: AccountStores) {
    this.#stores = stores;
  }

  leaving(): Promise<boolean> {
    return Promise.resolve(this.#stores.connection.leaving);
  }

  remove(): Promise<void> {
    if (this.stopBeforeRemove) {
      this.stopBeforeRemove = false;
      return Promise.reject(new Error('stopped'));
    }
    const { connection, outbox, history, viewings } = this.#stores;
    outbox.clear();
    history.clear();
    viewings.clear();
    connection.leaving = false;
    this.removals += 1;
    return Promise.resolve();
  }

  async adopt(key: AccountKey): Promise<void> {
    const { outbox, history, viewings } = this.#stores;
    for (const e of outbox.entries())
      if (e.accountKey == null) await outbox.put({ ...e, accountKey: key });
    for (const e of history.entries()) {
      if (e.accountKey == null) await history.put({ ...e, accountKey: key });
    }
    for (const v of viewings.all())
      if (v.accountKey == null) await viewings.put({ ...v, accountKey: key });
  }

  async keepOnly(key: AccountKey): Promise<number> {
    const { outbox, history, viewings } = this.#stores;
    const unsent = outbox.entries().filter((e) => !carries(e, key));
    for (const e of unsent) await outbox.remove(e.playId);
    await history.remove(
      history
        .entries()
        .filter((e) => !carries(e, key))
        .map((e) => e.playId),
    );
    await viewings.remove(
      viewings
        .all()
        .filter((v) => !carries(v, key))
        .map((v) => v.id),
    );
    return unsent.length;
  }
}

/**
 * Records what was sent and read. By default every play is accepted (`s-<playId>`,
 * `received`) and every receipt reads `received`; tests replace `onSend` / `onReceipt`.
 */
export class FakePlaysGateway implements PlaysGateway {
  readonly sends: { readonly playId: string; readonly body: PlayBody }[] = [];
  readonly reads: string[] = [];
  onSend: (playId: string, body: PlayBody) => SendResult | Promise<SendResult> = (playId) => ({
    kind: 'accepted',
    scrobbleId: `s-${playId}`,
    state: 'received',
    reason: null,
  });
  onReceipt: (scrobbleId: string) => ReceiptResult | Promise<ReceiptResult> = () => ({
    kind: 'ok',
    state: 'received',
    reason: null,
    titleId: null,
    questionKey: null,
  });

  async send(playId: string, body: PlayBody): Promise<SendResult> {
    this.sends.push({ playId, body });
    return this.onSend(playId, body);
  }

  async receipt(scrobbleId: string): Promise<ReceiptResult> {
    this.reads.push(scrobbleId);
    return this.onReceipt(scrobbleId);
  }
}

/**
 * Earliest wins for a pending alarm (the port's contract). With a clock, an alarm whose time
 * has passed counts as fired, so it no longer holds a later `at` back.
 */
export class FakeScheduler implements Scheduler {
  readonly #alarms = new Map<AlarmName, EpochMs>();
  readonly #clock: Clock | null;

  constructor(clock: Clock | null = null) {
    this.#clock = clock;
  }

  /** The pending alarm of this name, if any. */
  when(name: AlarmName): EpochMs | undefined {
    const t = this.#alarms.get(name);
    if (t !== undefined && this.#clock !== null && t < this.#clock.now()) {
      this.#alarms.delete(name);
      return undefined;
    }
    return t;
  }

  at(name: AlarmName, when: EpochMs): Promise<void> {
    const pending = this.when(name);
    if (pending === undefined || when < pending) this.#alarms.set(name, when);
    return Promise.resolve();
  }

  clear(name: AlarmName): Promise<void> {
    this.#alarms.delete(name);
    return Promise.resolve();
  }
}

export class RecordingStatusDisplay implements StatusDisplay {
  readonly shown: { readonly tabId: number | null; readonly status: Status }[] = [];

  show(tabId: number | null, status: Status): Promise<void> {
    this.shown.push({ tabId, status });
    return Promise.resolve();
  }
}

export class InMemorySettings implements Settings {
  #value: SettingsValue;

  constructor(initial: Partial<SettingsValue> = {}) {
    this.#value = { ...DEFAULT_SETTINGS, ...initial };
  }

  get value(): SettingsValue {
    return this.#value;
  }

  get(): Promise<SettingsValue> {
    return Promise.resolve(this.#value);
  }

  patch(p: Partial<SettingsValue>): Promise<void> {
    this.#value = { ...this.#value, ...p };
    return Promise.resolve();
  }
}

/** The account's rule as a test sets it: the never-read rule until it does. */
export class InMemoryAccountRules implements AccountRules {
  value: AccountRule;
  /** How many times the rule was read. */
  reads = 0;

  constructor(initial: Partial<AccountRule> = {}) {
    this.value = { ...DEFAULT_RULE, ...initial };
  }

  get(): Promise<AccountRule> {
    this.reads += 1;
    return Promise.resolve(this.value);
  }
}

export class FakeInterpreter implements Interpreter {
  readonly calls: { readonly serviceId: string; readonly snapshot: Snapshot }[] = [];
  readonly #answer: (serviceId: string, snapshot: Snapshot) => ServiceReading | null;

  constructor(answer: (serviceId: string, snapshot: Snapshot) => ServiceReading | null) {
    this.#answer = answer;
  }

  interpret(serviceId: string, snapshot: Snapshot): Promise<ServiceReading | null> {
    this.calls.push({ serviceId, snapshot });
    return Promise.resolve(this.#answer(serviceId, snapshot));
  }
}

export class InMemoryDiagnostics implements Diagnostics {
  entries: readonly { readonly at: EpochMs }[] = [];

  record(at: EpochMs): void {
    this.entries = [...this.entries, { at }];
  }

  prune(before: EpochMs, keep: number): Promise<void> {
    const recent = this.entries.filter((e) => e.at >= before).sort((a, b) => a.at - b.at);
    this.entries = keep > 0 ? recent.slice(-keep) : [];
    return Promise.resolve();
  }
}

/** A strategy that answers what it was given, recording each call's input. */
export class FakeAuthStrategy implements AuthStrategy {
  readonly id: AuthStrategy['id'];
  readonly inputs: ({ readonly token?: string } | undefined)[] = [];
  readonly #result: ConnectResult;

  constructor(id: AuthStrategy['id'], result: ConnectResult) {
    this.id = id;
    this.#result = result;
  }

  connect(input?: { readonly token?: string }): Promise<ConnectResult> {
    this.inputs.push(input);
    return Promise.resolve(this.#result);
  }
}
