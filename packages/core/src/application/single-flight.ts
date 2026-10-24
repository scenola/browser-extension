/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One pass at a time inside the worker. A call made while a pass runs does not start a
 * second, concurrent one (that would send a play twice in parallel); it asks for one more
 * pass after the current one, with its own task, and resolves when that pass has run.
 */
export class SingleFlight {
  #running: Promise<void> | null = null;
  #next: (() => Promise<void>) | null = null;

  run(task: () => Promise<void>): Promise<void> {
    if (this.#running !== null) {
      this.#next = task;
      return this.#running;
    }
    const running = this.#loop(task);
    this.#running = running;
    return running;
  }

  async #loop(first: () => Promise<void>): Promise<void> {
    let task: (() => Promise<void>) | null = first;
    try {
      while (task !== null) {
        this.#next = null;
        await task();
        task = this.#next;
      }
    } finally {
      this.#running = null;
      this.#next = null;
    }
  }
}
