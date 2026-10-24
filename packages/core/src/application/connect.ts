/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  AuthStrategy,
  Clock,
  ConnectResult,
  ConnectionRepo,
  Outbox,
  Scheduler,
} from './ports';

interface Deps {
  readonly connection: ConnectionRepo;
  readonly outbox: Outbox;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  /** What an unfinished disconnect left (`Disconnect.finish`): removed before any sign-in. */
  readonly leftovers: { finish(): Promise<boolean> };
}

/**
 * Makes a connection with a strategy. On `connected` the state is stored and a
 * paused outbox resumes, its entries under their own keys. One flow at a time: a second
 * request while one runs gets the first one's answer.
 *
 * What a disconnect left behind (a worker stopped before it removed it) goes before the
 * strategy runs: a strategy stores its credential itself, and from that moment a pass of the
 * outbox could send what belonged to the account that left.
 */
export class Connect {
  readonly #deps: Deps;
  #flow: Promise<ConnectResult> | null = null;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  execute(strategy: AuthStrategy, input?: { readonly token?: string }): Promise<ConnectResult> {
    if (this.#flow !== null) return this.#flow;
    const flow = this.#connect(strategy, input).finally(() => {
      this.#flow = null;
    });
    this.#flow = flow;
    return flow;
  }

  /** Settles once no flow runs, however the one running ends. */
  async idle(): Promise<void> {
    await this.#flow?.catch(() => undefined);
  }

  async #connect(
    strategy: AuthStrategy,
    input: { readonly token?: string } | undefined,
  ): Promise<ConnectResult> {
    const { connection, outbox, clock, scheduler, leftovers } = this.#deps;
    await leftovers.finish();
    const result = await strategy.connect(input);
    if (result.kind !== 'connected') return result;
    await connection.set(result.state);
    const now = clock.now();
    await outbox.resumeAll(now);
    await scheduler.at('outbox', now);
    return result;
  }
}
