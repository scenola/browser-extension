/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A key the code computes can name anything an object holds, its prototype's members
// included. Each of these type-checks; ESLint refuses each in src/services/**.

export function pick(record: Readonly<Record<string, string>>, key: string): string | undefined {
  return record[key];
}

export function unpack(record: Readonly<Record<string, string>>, key: string): unknown {
  const { [key]: value } = record;
  return value;
}

// An array is indexed by a number only: a string key reaches `constructor` just the same.
export const reach = (list: readonly string[], key: 'constructor'): unknown => list[key];
