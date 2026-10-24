/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `Function` without naming it: every value's prototype chain leads there. Each line
// type-checks; ESLint refuses each in src/services/**.

export const viaConstructor = (): unknown => [].map.constructor;

export const viaProto = (value: { readonly __proto__: unknown }): unknown => value.__proto__;

export const viaPrototypeOf = (value: object): unknown => Object.getPrototypeOf(value);

export const viaDescriptor = (value: object): unknown =>
  Object.getOwnPropertyDescriptor(value, 'constructor');
