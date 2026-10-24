/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { OutboxEntry } from '../domain/outbox';
import type { AccountData, ConnectionRepo, Outbox, Scheduler } from './ports';
import type { ViewingLock } from './viewing-lock';

/** How long *Send first* waits for what is left to go before it disconnects anyway. */
export const SEND_FIRST_WAIT_MS = 10_000;

interface Deps {
  readonly connection: ConnectionRepo;
  readonly account: AccountData;
  readonly outbox: Outbox;
  readonly scheduler: Scheduler;
  readonly lock: ViewingLock;
  /** One pass of the outbox that tries every pending entry now (`DrainOutbox`, `early`). */
  readonly drainAll: () => Promise<void>;
  /** Settles once every send and read started before it has ended. */
  readonly settled: () => Promise<void>;
  /** Settles once no sign-in runs: a disconnect never races the connection it would remove. */
  readonly connecting: () => Promise<void>;
  readonly delay: (ms: number) => Promise<void>;
}

/** What a disconnect did: plays that went before it, and plays it deleted unsent. */
export interface Disconnected {
  readonly sent: number;
  readonly deleted: number;
}

/** An entry that can still go: one the server has not refused for good. */
const sendable = (e: OutboxEntry): boolean => e.state === 'pending' || e.state === 'paused';

/**
 * *Disconnect from this browser*: the account leaves the browser, with everything recorded for
 * it — the credential and its key, the plays and starts not sent yet, the history, the viewings
 * and the tabs' states. With `sendFirst`, what is left is sent first, for at most
 * `SEND_FIRST_WAIT_MS`.
 *
 * The order is what makes it safe. The credential goes first, in the same write that marks the
 * rest as leaving, so nothing is sent after the person chose to go (the send they asked for has
 * had its time by then). Then every send in flight ends — its answer would write the history
 * or the outbox again — and only then is the rest removed, in one write. A stop between the two
 * leaves the mark: `finish` removes the rest at the next start of the worker, and before any
 * connection is made, so a later connection never receives it.
 */
export class Disconnect {
  readonly #deps: Deps;
  #running: Promise<Disconnected> | null = null;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  /** One disconnect at a time: a second request while one runs gets the first one's answer. */
  execute(o: { readonly sendFirst: boolean }): Promise<Disconnected> {
    if (this.#running !== null) return this.#running;
    const running = this.#disconnect(o.sendFirst).finally(() => {
      this.#running = null;
    });
    this.#running = running;
    return running;
  }

  /**
   * Removes what a disconnect left, once no send that began before it runs any more; nothing
   * when no disconnect is unfinished. `true` when something was removed.
   */
  async finish(): Promise<boolean> {
    return (await this.#remove()) !== null;
  }

  async #disconnect(sendFirst: boolean): Promise<Disconnected> {
    const { connection, outbox, scheduler } = this.#deps;
    await this.#deps.connecting();
    const unsent = (await outbox.list()).filter(sendable).map((e) => e.playId);
    let pass: Promise<void> | null = null;
    if (sendFirst && unsent.length > 0 && (await connection.get()).kind === 'connected') {
      pass = this.#deps.drainAll().catch(() => undefined);
      await Promise.race([pass, this.#deps.delay(SEND_FIRST_WAIT_MS)]);
    }
    await connection.forget();
    await scheduler.clear('outbox');
    await scheduler.clear('receipts');
    // The pass stops before its next entry, the connection being gone; the send in flight ends.
    if (pass !== null) await pass;
    const left = (await this.#remove()) ?? [];
    const kept = new Set(left.map((e) => e.playId));
    return { sent: unsent.filter((id) => !kept.has(id)).length, deleted: left.length };
  }

  /** The outbox as it was removed; `null` when nothing was leaving. */
  async #remove(): Promise<readonly OutboxEntry[] | null> {
    const { account, outbox, lock } = this.#deps;
    if (!(await account.leaving())) return null;
    await this.#deps.settled();
    // Inside the lock: an observation queued meanwhile has written its play, which goes too.
    return lock.run(async () => {
      if (!(await account.leaving())) return null;
      const left = await outbox.list();
      await account.remove();
      return left;
    });
  }
}
