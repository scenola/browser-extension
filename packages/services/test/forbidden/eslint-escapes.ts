/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Three ways around the compiler that type-check under tsconfig.modules.json; ESLint
// refuses each in src/services/**.

export const realm: unknown = globalThis;

export function compile(body: string): unknown {
  return new Function(body);
}

export function loosen(value: unknown): unknown {
  return (value as any).title;
}
