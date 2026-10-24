/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* eslint-disable */
// A module switching the rules off. Inline configuration has no effect in
// src/services/**, so the line below is still refused.

export const realm: unknown = globalThis; // eslint-disable-line no-restricted-globals
