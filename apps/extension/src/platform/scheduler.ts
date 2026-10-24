/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Wake-ups that survive the worker stopping (core's `Scheduler`): `chrome.alarms`, one pending
// alarm per name, earliest wins. Chrome fires no alarm sooner than 30 s ahead, so `when` is
// clamped to that. Calls are serialised: two `at`s for one name read the pending alarm one after
// the other, so a later time can never replace an earlier one between a read and a write.

import type { AlarmName, Clock, EpochMs, Scheduler } from '@mt/core';
import type { Browser } from 'wxt/browser';

import { isInstant } from '../values';
import { Serial } from './serial';

/** Core's alarms, and the app's own: `status`, when a timed pause ends and the icon must change. */
export type AppAlarmName = AlarmName | 'status';

/** Chrome's floor for an alarm: `chrome.alarms` fires no sooner than 30 s ahead. */
const MIN_ALARM_DELAY_MS = 30_000;

type Alarms = Pick<typeof Browser.alarms, 'get' | 'create' | 'clear'>;

export class AlarmScheduler implements Scheduler {
  readonly #alarms: Alarms;
  readonly #clock: Clock;
  readonly #serial = new Serial();

  constructor(alarms: Alarms, clock: Clock) {
    this.#alarms = alarms;
    this.#clock = clock;
  }

  /**
   * An alarm at `when`, or 30 s from now if that is sooner, unless one of this name is already
   * pending no later. Refuses (`RangeError`) a time no `Date` can hold — an indefinite pause is
   * never scheduled.
   */
  at(name: AppAlarmName, when: EpochMs): Promise<void> {
    if (!isInstant(when)) {
      return Promise.reject(new RangeError('an alarm needs a time a Date can hold'));
    }
    return this.#serial.run(async () => {
      const target = Math.max(when, this.#clock.now() + MIN_ALARM_DELAY_MS);
      const pending = await this.#alarms.get(name);
      if (pending !== undefined && pending.scheduledTime <= target) return;
      await this.#alarms.create(name, { when: target });
    });
  }

  clear(name: AppAlarmName): Promise<void> {
    return this.#serial.run(async () => {
      await this.#alarms.clear(name);
    });
  }
}
