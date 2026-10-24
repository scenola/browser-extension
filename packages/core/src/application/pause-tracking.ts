/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isPaused } from '../domain/settings';
import type { EpochMs } from '../domain/time';
import type { Clock, Settings } from './ports';

interface Deps {
  readonly settings: Settings;
  readonly clock: Clock;
}

/** Pauses tracking until a moment; `null`, or a moment already past, resumes it. */
export class PauseTracking {
  readonly #deps: Deps;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  async execute(until: EpochMs | null): Promise<void> {
    if (until !== null && !Number.isFinite(until)) {
      throw new RangeError('PauseTracking: until must be a finite time or null');
    }
    const { settings, clock } = this.#deps;
    await settings.patch({ pausedUntil: isPaused(until, clock.now()) ? until : null });
  }
}
