/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Type tests, run by `tsc -b` (`pnpm typecheck`): each `Expect` that does not hold is a compile
// error. The identity fields are spelled once (`IDENTITY_FIELDS`); these hold the list
// to the reading types, so a field added to `ServiceReading` without the list — or to the list
// without `MergedReading` — fails the build rather than reaching one reader and not another.

import type { Field, IdentityField, MergedReading, ServiceReading } from './reading';

/** Each assignable to the other: for the unions of literals compared here, the same set. */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

/** The keys of `ServiceReading` whose values are `Field`s: the ones a source is stamped on. */
type FieldKeys = {
  [K in keyof ServiceReading]-?: NonNullable<ServiceReading[K]> extends Field<unknown> ? K : never;
}[keyof ServiceReading];

/** What `mergeReadings` makes of each identity field: the `Field`'s value. */
type Unwrapped = { [K in IdentityField]: NonNullable<ServiceReading[K]>['value'] };

export type IdentityFieldsAreOneList = [
  // Every `Field`-wrapped key is an identity field, and every identity field is one.
  Expect<Equal<FieldKeys, IdentityField>>,
  // Merged, each identity field is its `Field`'s value, as `MergedReading` declares it.
  Expect<Equal<Unwrapped, Required<Pick<MergedReading, IdentityField>>>>,
];

// The check can fail: a list without `showIds` is not every `Field`-wrapped key.
export type Fires = [Expect<Equal<Equal<FieldKeys, Exclude<IdentityField, 'showIds'>>, false>>];
