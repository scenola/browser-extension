/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// One task at a time: each starts once the one before it settled, however it ended, so two
// read-then-write tasks never read the same value and lose one another's write.

export class Serial {
  #tail: Promise<unknown>;

  /** `first` runs before any task (a migration); it must not reject. */
  constructor(first: Promise<unknown> = Promise.resolve()) {
    this.#tail = first;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(task);
    this.#tail = run.catch(() => undefined);
    return run;
  }
}
