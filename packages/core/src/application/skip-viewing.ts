/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ViewingStore } from './ports';
import type { ViewingLock } from './viewing-lock';

interface Deps {
  readonly viewings: ViewingStore;
  readonly lock: ViewingLock;
}

/**
 * "Don't add this viewing". A skipped viewing stays joinable for its 7 idle
 * days, so a later sitting of it is still skipped and never reported. A viewing already
 * reported is past skipping: its play is the server's, and the app is where it is undone.
 * Inside the viewing lock, so a skip never races the observation that would report it.
 */
export class SkipViewing {
  readonly #deps: Deps;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  execute(viewingId: string): Promise<void> {
    const { viewings, lock } = this.#deps;
    return lock.run(async () => {
      const v = await viewings.byId(viewingId);
      if (v?.state !== 'open') return;
      await viewings.put({ ...v, state: 'skipped' });
    });
  }
}
