/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What talks to MediaTracker in the background: the outbox drained, the receipts read and the
// connection checked. Each pass refreshes the toolbar and the open pages after it, and is
// remembered until it settles, so a disconnect and *Clear all local data* can wait for it.

import type { DrainOutbox, RefreshReceipts } from '@mt/core';

import type { ConnectionCheck } from './connection-check';
import type { StatusPresenter } from './status-presenter';
import type { Listeners, Steps } from './support';

type ReceiptReason = 'scheduled' | 'popup';

interface Deps {
  readonly drain: DrainOutbox;
  readonly receipts: RefreshReceipts;
  readonly check: ConnectionCheck;
  readonly status: StatusPresenter;
  readonly changes: Listeners;
  readonly steps: Steps;
}

export class SyncLoop {
  readonly #deps: Deps;
  readonly #inflight = new Set<Promise<unknown>>();

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  /** Sends what is due, in the background of whatever asked. */
  runDrain(): void {
    void this.drain();
  }

  runReceipts(reason: ReceiptReason): void {
    void this.receipts(reason);
  }

  /**
   * Whether the connection still works, and until when, in the background. `force` asks within
   * the minute too, for the account's rule after a start it refused.
   */
  runCheck(force = false): void {
    void this.check(force);
  }

  /** `early`: every play not sent yet is tried now, a retry not due yet too (*Send first*). */
  drain(o: { readonly early?: boolean } = {}): Promise<void> {
    return this.#track(this.#drainAndRefresh(o.early === true));
  }

  receipts(reason: ReceiptReason): Promise<void> {
    return this.#track(this.#receiptsAndRefresh(reason));
  }

  check(force = false): Promise<void> {
    return this.#track(this.#checkAndRefresh(force));
  }

  /** Every pass started so far has settled. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.#inflight]);
  }

  async #drainAndRefresh(early: boolean): Promise<void> {
    await this.#deps.steps.guard('drain', () => this.#deps.drain.execute({ early }));
    await this.#refresh();
  }

  async #receiptsAndRefresh(reason: ReceiptReason): Promise<void> {
    await this.#deps.steps.guard('receipts', () => this.#deps.receipts.execute({ reason }));
    await this.#refresh();
  }

  /** The connection check; what it changed reaches the icon and the pages. */
  async #checkAndRefresh(force: boolean): Promise<void> {
    if (!(await this.#deps.check.run(force))) return;
    await this.#refresh();
  }

  async #refresh(): Promise<void> {
    this.#deps.status.invalidate();
    await this.#deps.status.refreshAll();
    this.#deps.changes.changed();
  }

  /** Remembers a background task until it settles, so a disconnect can wait for it. */
  #track(task: Promise<void>): Promise<void> {
    const tracked = task.catch(() => undefined);
    this.#inflight.add(tracked);
    void tracked.finally(() => this.#inflight.delete(tracked));
    return tracked;
  }
}
