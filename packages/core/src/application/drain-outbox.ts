/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { slideExpiry } from '../domain/connection';
import { describeSendResult, isTooOld, notCounted, outboxStep } from '../domain/outbox';
import type { OutboxEntry, OutboxStep, SendResult } from '../domain/outbox';
import { playLabel } from '../domain/play';
import { nextReceiptRead } from '../domain/receipt-schedule';
import { MINUTE_MS } from '../domain/time';
import type { EpochMs } from '../domain/time';
import { credentialRefused, sameConnection } from './credential-refused';
import type { Connected } from './credential-refused';
import type {
  Clock,
  ConnectionRepo,
  HistoryEntry,
  Outbox,
  PlayHistory,
  PlaysGateway,
  Random,
  Scheduler,
} from './ports';
import { SingleFlight } from './single-flight';

/**
 * Set before the first send of a pass and replaced when the pass ends: if the worker is
 * stopped mid-send, this alarm (a minute, while the outbox is not empty) wakes the next one.
 */
const OUTBOX_WATCHDOG_MS = MINUTE_MS;

interface Deps {
  readonly outbox: Outbox;
  readonly history: PlayHistory;
  readonly connection: ConnectionRepo;
  readonly gateway: PlaysGateway;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly random: Random;
  /**
   * Called once at the end of a pass in which the account's lines did not count what was sent
   * (`notCounted`): they changed since they were read, and should be read again now.
   */
  readonly onNotCounted?: () => void;
  /** Called when a pass sent nothing because no check has named the connection's account yet. */
  readonly onAccountUnread?: () => void;
}

/** What one pass met along the way. */
interface Pass {
  /** A play or a start the account's lines did not count. */
  notCounted: boolean;
}

/**
 * Sends what is due, one play at a time, each under its own `playId` as the
 * `Idempotency-Key`, and records each answer as `outboxStep` decides. Nothing is
 * changed before an answer, so a pass stopped anywhere leaves the entry to be sent again
 * with the same key. Skipped entirely without a connection, and before a connection check has
 * named the connection's account; only entries recorded for that account are sent.
 */
export class DrainOutbox {
  readonly #deps: Deps;
  readonly #flight = new SingleFlight();
  /** A pass that tries every pending entry was asked for and has not started yet. */
  #early = false;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  /**
   * `early`: every pending entry is tried now, those waiting for a retry too — the person asked
   * to send what is left before disconnecting. Kept for the next pass, so a plain pass asked for
   * after it does not take its place.
   */
  execute(o: { readonly early?: boolean } = {}): Promise<void> {
    if (o.early === true) this.#early = true;
    return this.#flight.run(() => this.#drain());
  }

  async #drain(): Promise<void> {
    const { outbox, clock, scheduler, connection } = this.#deps;
    const early = this.#early;
    this.#early = false;
    const started = await connection.get();
    if (started.kind !== 'connected') return;
    // Nothing is sent before a check has named the connection's account: until then what waits
    // here may be another person's. The check is asked for, and the watchdog tries again.
    const known = await connection.account();
    if (known.kind !== 'read') {
      if ((await outbox.list()).length > 0) {
        await scheduler.at('outbox', clock.now() + OUTBOX_WATCHDOG_MS);
      }
      this.#deps.onAccountUnread?.();
      return;
    }
    // Paused entries under a good connection are a refusal that a reconnect overtook.
    await outbox.resumeAll(clock.now());

    // An entry of another account, or of none, is never sent: the next check deletes it.
    const due = (await outbox.due(early ? Number.MAX_SAFE_INTEGER : clock.now())).filter(
      (entry) => entry.accountKey === known.key,
    );
    if (due.length > 0) await scheduler.at('outbox', clock.now() + OUTBOX_WATCHDOG_MS);
    const pass: Pass = { notCounted: false };
    for (const entry of due) {
      if (!(await this.#stillConnected(started))) break;
      if (!(await this.#attempt(entry, started, pass))) break;
    }
    if (pass.notCounted) this.#deps.onNotCounted?.();

    // The pass knows when the next entry is due: it replaces the watchdog with that time.
    // Clear first, then read, then set: an entry queued meanwhile is either read here or
    // asked for its own alarm after the clear, which earliest-wins then keeps.
    await scheduler.clear('outbox');
    const next = await outbox.nextDueAt();
    if (next !== null) await scheduler.at('outbox', next);
  }

  /** One entry; `false` when the pass must stop (the credential was refused). */
  async #attempt(entry: OutboxEntry, started: Connected, pass: Pass): Promise<boolean> {
    const { outbox, history, connection, clock, scheduler, random } = this.#deps;
    if (isTooOld(entry, clock.now())) {
      await outbox.put({ ...entry, state: 'dead', lastError: 'too_old' });
      return true;
    }
    const result = await this.#send(entry);
    const now = clock.now();
    if (notCounted(result)) pass.notCounted = true;
    const step = outboxStep(entry, result, now, random);
    const tried: OutboxEntry = {
      ...entry,
      attempts: entry.attempts + 1,
      lastError: describeSendResult(result),
    };

    switch (step.kind) {
      case 'done': {
        const sent = answered(entry, step, now, await history.byPlayId(entry.playId));
        // History first: an entry still in the outbox is sent again under its key, whereas
        // one gone from both would be a play nobody can see.
        await history.put(sent);
        await outbox.remove(entry.playId);
        if (result.kind === 'accepted') {
          const current = await connection.get();
          if (sameConnection(current, started)) await connection.set(slideExpiry(current, now));
        }
        const read = nextReceiptRead(sent, 'scheduled', now);
        if (read !== null) await scheduler.at('receipts', read);
        return true;
      }
      case 'retry':
        await outbox.put({ ...tried, nextAttemptAt: step.at });
        return true;
      case 'dead':
        await outbox.put({ ...tried, state: 'dead', lastError: step.reason });
        return true;
      case 'pause_all':
        await outbox.put(tried);
        await credentialRefused(connection, outbox, started);
        return false;
    }
  }

  /** A throw is a fault, not an answer: the play may have been stored, so it is retried. */
  async #send(entry: OutboxEntry): Promise<SendResult> {
    try {
      return await this.#deps.gateway.send(entry.playId, entry.body);
    } catch (error: unknown) {
      const name = error instanceof Error ? error.name : typeof error;
      return { kind: 'unavailable', detail: `threw:${name}` };
    }
  }

  async #stillConnected(started: Connected): Promise<boolean> {
    return sameConnection(await this.#deps.connection.get(), started);
  }
}

/**
 * The history entry for a play that is done. A resend of a play the history already holds
 * (stopped after writing it, before removing the entry) keeps what the history knows — its
 * scrobble id and later answers — unless it had no id and this answer brings one.
 */
function answered(
  entry: OutboxEntry,
  step: Extract<OutboxStep, { kind: 'done' }>,
  now: EpochMs,
  known: HistoryEntry | null,
): HistoryEntry {
  const receipt = step.receipt === null ? null : { ...step.receipt, titleId: null };
  if (known !== null) {
    if (known.scrobbleId !== null || step.scrobbleId === null) return known;
    return { ...known, scrobbleId: step.scrobbleId, receipt, receiptReadAt: null };
  }
  return {
    playId: entry.playId,
    scrobbleId: step.scrobbleId,
    body: entry.body,
    sentAt: now,
    receipt,
    receiptReadAt: null,
    receiptGoneAt: null,
    label: playLabel(entry.body) ?? '',
    accountKey: entry.accountKey ?? null,
  };
}
