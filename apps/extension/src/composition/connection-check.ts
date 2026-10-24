/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The connection check: `GET /v1/integrations/connection`, asked when a page opens its `ui` port
// and when the worker starts, at most once a minute. Its `401` is the plays route's — the
// connection is over (revoked, expired, rotated out) — so it does what that `401` does (core's
// `credentialRefused`). Its `200` replaces the local expiry estimate and states the
// connection's status. Every other answer changes nothing. An answer belongs to the connection
// that asked: one that lands after a disconnect or a reconnect changes nothing.
//
// The `200` carries the account's rule too: when a film begun is saved in progress. It is kept
// for the connection that asked, beyond the browser session, and read from there before a start
// — never asked for then.
//
// And it names the account the connection acts for (`account_key`), which decides what the
// browser keeps (core's `ConfirmAccount`): nothing is sent under a connection before this.

import { DEFAULT_RULE, credentialRefused } from '@mt/core';
import type {
  AccountRule,
  Clock,
  ConfirmAccount,
  ConnectionCheckResult,
  ConnectionGateway,
  ConnectionRepo,
  ConnectionState,
  Outbox,
} from '@mt/core';

import type { ConnectionCheckView } from '../messaging/protocol';
import type { AccountRuleStore, ConnectionCheckStore } from './ports';
import { errorName } from './support';

/** The connection is asked about at most this often. */
const CONNECTION_CHECK_INTERVAL_MS = 60_000;

interface Deps {
  readonly connection: ConnectionRepo;
  readonly outbox: Outbox;
  readonly gateway: ConnectionGateway;
  readonly store: ConnectionCheckStore;
  /** The account's rule each answer carries, kept beyond the browser session. */
  readonly rules: AccountRuleStore;
  readonly clock: Clock;
  readonly log: (event: string, detail: Readonly<Record<string, unknown>>) => Promise<void>;
  /** What a `200`'s `account_key` decides: the account the browser keeps records for. */
  readonly confirm: ConfirmAccount;
  /** Called when an answer kept a key the connection did not have: plays may go now. */
  readonly onAccountKept?: () => void;
}

type Connected = Extract<ConnectionState, { kind: 'connected' }>;

/** `started` is still the stored connection: not disconnected, cleared or replaced since. */
const isCurrent = (current: ConnectionState, started: Connected): current is Connected =>
  current.kind === 'connected' && current.id === started.id;

export class ConnectionCheck {
  readonly #deps: Deps;
  #running: Promise<boolean> | null = null;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  /**
   * Asks about the stored connection, unless there is none or it was asked within the minute;
   * one ask at a time. `force` asks within the minute too: the server refused a start by a rule
   * that changed since it was read. `true` when what the pages and the icon show may have
   * changed. Never rejects: a fault is no answer.
   */
  run(force = false): Promise<boolean> {
    if (this.#running !== null) return this.#running;
    const run = this.#run(force)
      .catch(async (error: unknown) => {
        await this.#deps.log('connection.check_failed', { error: errorName(error) });
        return false;
      })
      .finally(() => {
        this.#running = null;
      });
    this.#running = run;
    return run;
  }

  /** What the server last said of `state`'s connection; `null` until it answered for that one. */
  async view(state: ConnectionState): Promise<ConnectionCheckView | null> {
    if (state.kind !== 'connected') return null;
    const record = await this.#deps.store.get();
    return record?.connectionId === state.id ? record.answer : null;
  }

  /**
   * The account's rule for the current connection (`state`, when the caller has just read it), as
   * its last answer stated it. The never-read rule without a connection, and until a check
   * answered for this one: a reconnect forgets the old rule.
   */
  async rule(state?: ConnectionState): Promise<AccountRule> {
    const [current, kept] = await Promise.all([
      state ?? this.#deps.connection.get(),
      this.#deps.rules.get(),
    ]);
    return current.kind === 'connected' && kept?.connectionId === current.id
      ? kept.rule
      : DEFAULT_RULE;
  }

  /** A disconnect, *Clear all local data*: what the server said of that connection goes. */
  async forget(): Promise<void> {
    await this.#deps.store.set(null);
    await this.#deps.rules.set(null);
  }

  async #run(force: boolean): Promise<boolean> {
    const { connection, store, clock } = this.#deps;
    const started = await connection.get();
    if (started.kind !== 'connected') return false;
    const askedAt = clock.now();
    const last = await store.get();
    const kept = last?.connectionId === started.id ? last : null;
    // A clock that went back is no reason to wait: the bound counts forward only.
    if (!force && kept !== null && askedAt >= kept.askedAt) {
      if (askedAt - kept.askedAt < CONNECTION_CHECK_INTERVAL_MS) return false;
    }
    // The ask is recorded before it is sent, so a worker that stops mid-ask does not ask again
    // within the minute either.
    await store.set({ connectionId: started.id, askedAt, answer: kept?.answer ?? null });
    let result: ConnectionCheckResult;
    try {
      result = await this.#deps.gateway.check();
    } catch (error: unknown) {
      result = { kind: 'unavailable', detail: `threw:${errorName(error)}` };
    }
    return this.#apply(result, started, askedAt);
  }

  async #apply(
    result: ConnectionCheckResult,
    started: Connected,
    askedAt: number,
  ): Promise<boolean> {
    const { connection, outbox, store, clock, log } = this.#deps;
    switch (result.kind) {
      case 'unavailable':
        await log('connection.check_unavailable', { detail: result.detail });
        return false;
      case 'credential_invalid':
        // The plays route's own 401: pause, then mark broken — each only while `started` is
        // still the stored connection (a reconnect since keeps its new one).
        await credentialRefused(connection, outbox, started);
        return true;
      case 'ok': {
        if (!isCurrent(await connection.get(), started)) return false;
        // The account first: until it is kept nothing is sent, and once it is, only its plays.
        const confirmed = await this.#deps.confirm.execute(started, result.accountKey);
        if (confirmed.kind === 'stale') return false;
        if (confirmed.kind === 'kept') {
          // How many plays were another account's, or nobody's, and went unsent: never the key.
          await log('connection.account_kept', { deleted: confirmed.deleted });
          this.#deps.onAccountKept?.();
        }
        const current = await connection.get();
        if (!isCurrent(current, started)) return true;
        const answer = {
          status: result.status,
          expiresAt: result.expiresAt,
          checkedAt: clock.now(),
        };
        await store.set({ connectionId: started.id, askedAt, answer });
        // Each later write asks again: a disconnect or *Clear all local data* while the answer
        // was being kept has deleted what it would write, and it stays deleted.
        if (!isCurrent(await connection.get(), started)) return true;
        // `null`: the credential has no end, and the estimate stands.
        if (result.expiresAt !== null && result.expiresAt !== current.expiresAt) {
          await connection.set({ ...current, expiresAt: result.expiresAt });
        }
        await this.#keepRule(started, result.rule, result.ruleInvalid);
        return true;
      }
    }
  }

  /** The rule an answer carried, kept for its connection; a change of it, logged without a title. */
  async #keepRule(
    started: Connected,
    rule: AccountRule,
    invalid: readonly string[] | undefined,
  ): Promise<void> {
    const { connection, rules, log } = this.#deps;
    if (invalid !== undefined) await log('connection.rule_invalid', { fields: invalid.join(',') });
    const before = await rules.get();
    const same =
      before?.connectionId === started.id &&
      before.rule.startThresholdPercent === rule.startThresholdPercent &&
      before.rule.startFloorSeconds === rule.startFloorSeconds &&
      before.rule.finishThresholdPercent === rule.finishThresholdPercent;
    if (same || !isCurrent(await connection.get(), started)) return;
    await rules.set({ connectionId: started.id, rule });
    await log('connection.rule', {
      startThresholdPercent: rule.startThresholdPercent ?? 'off',
      startFloorSeconds: rule.startFloorSeconds,
      finishThresholdPercent: rule.finishThresholdPercent,
    });
  }
}
