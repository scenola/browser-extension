/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Globals the ES2023 library does declare. They type-check; ESLint allows a module
// only Math, Number, String, JSON, RegExp, Array, Object and Date.

export const later = (): Promise<number> => Promise.resolve(1);

export const keys = (value: object): readonly PropertyKey[] => Reflect.ownKeys(value);
