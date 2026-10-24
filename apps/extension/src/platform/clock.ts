/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Time and ids (core's `Clock`, `Ids`, `Random`): the system clock, the viewer's own time zone,
// UUIDv7s from the platform's cryptographic random source.

import { uuidv7 } from '@mt/core';
import type { Clock, EpochMs, Ids, Random } from '@mt/core';

export const systemClock: Clock = {
  now: () => Date.now(),
  offsetMinutes: (at: EpochMs) => -new Date(at).getTimezoneOffset(),
};

const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

export const cryptoIds: Ids = {
  playId: () => uuidv7(Date.now(), randomBytes),
  viewingId: () => uuidv7(Date.now(), randomBytes),
};

/** The outbox's jitter: not a secret, so `Math.random` is enough. */
export const jitter: Random = () => Math.random();
