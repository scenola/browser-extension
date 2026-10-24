/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Code from a string, direct and indirect. Both type-check; ESLint refuses both.

export function run(code: string): unknown {
  return eval(code);
}

const evaluate = eval;

export const indirect = (code: string): unknown => evaluate(code);
