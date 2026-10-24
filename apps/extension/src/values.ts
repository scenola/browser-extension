/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The first checks on a value this code did not build — a stored record, a worker's answer, a
// catalog — before any of its fields is read. Every reader in the extension is total, so each
// starts here.

import { MAX_DATE_MS } from '@mt/core';

export { MAX_DATE_MS };

/** A plain object: not `null`, not an array. */
export const isRecord = (x: unknown): x is Readonly<Record<string, unknown>> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

export const isFiniteNumber = (x: unknown): x is number =>
  typeof x === 'number' && Number.isFinite(x);

/** An instant a `Date` can hold. */
export const isInstant = (x: unknown): x is number =>
  isFiniteNumber(x) && Math.abs(x) <= MAX_DATE_MS;
