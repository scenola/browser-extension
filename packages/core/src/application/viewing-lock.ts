/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

declare const proof: unique symbol;

/** Proof that the holder runs inside `ViewingLock.run`. Checked by `holds`, never trusted. */
export interface LockHeld {
  readonly [proof]: true;
}

/**
 * The one lock over the viewings and tab states. Every use case that reads a
 * viewing and writes it back — `IngestObservation`, `ReportViewing`, `SkipViewing`,
 * `ExpireStale` — runs inside it, so two observations of one viewing (two tabs, or a
 * periodic sample and an `ended` one in flight) never read the same version and write two
 * plays or lose a range. One lock for all viewings: a use case cannot name its viewing
 * before it reads the tab, and nothing inside waits on the network.
 *
 * FIFO and non-collapsing: each task runs, in the order it asked. Not re-entrant — a task
 * hands its `LockHeld` to the use case it calls instead of asking again.
 */
export class ViewingLock {
  #tail: Promise<unknown> = Promise.resolve();
  #holder: LockHeld | null = null;

  run<T>(task: (held: LockHeld) => Promise<T>): Promise<T> {
    const result = this.#tail.then(async () => {
      const held = Object.freeze({}) as LockHeld;
      this.#holder = held;
      try {
        return await task(held);
      } finally {
        this.#holder = null;
      }
    });
    this.#tail = result.catch(() => undefined);
    return result;
  }

  /** `held` is the proof of the task running now, not one that ended. */
  holds(held: LockHeld): boolean {
    return this.#holder === held;
  }
}
