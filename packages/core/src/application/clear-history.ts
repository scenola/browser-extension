/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PlayHistory } from './ports';
import type { ReportViewing } from './report-viewing';
import type { ViewingLock } from './viewing-lock';

interface Deps {
  readonly history: PlayHistory;
  readonly report: ReportViewing;
  readonly lock: ViewingLock;
}

/**
 * *Clear history*: every play already sent and what MediaTracker answered about it leave this
 * browser, those still waiting for an answer included; the diary in MediaTracker keeps them.
 * Plays not sent yet, open viewings, the settings and the connection stay.
 *
 * Inside the viewing lock, so no report runs between the two steps: a viewing that knew its play
 * went only from the history records it first (`recordDeliveredHeld`), then the history goes.
 */
export class ClearHistory {
  readonly #deps: Deps;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  execute(): Promise<void> {
    const { history, report, lock } = this.#deps;
    return lock.run(async (held) => {
      await report.recordDeliveredHeld(held);
      await history.removeAll();
    });
  }
}
