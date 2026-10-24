/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Milliseconds since the Unix epoch. */
export type EpochMs = number;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** The last instant a `Date` can hold (ECMA-262: ±8.64 × 10¹⁵ ms); past it nothing is a time. */
export const MAX_DATE_MS = 8.64e15;
