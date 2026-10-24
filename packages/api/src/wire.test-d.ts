/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Type tests, run by `tsc -b` (`pnpm typecheck`): each `Expect` that does not hold is a
// compile error. The `Fires` cases prove the checks can fail.

import type { PlayBody, ProviderEntry, ReceiptState } from '@mt/core';

import type { components } from './generated/schema';
import type { WIRE_ERROR_FIELDS, WireAccepted, WireError, WirePlay, WireReceipt } from './wire';

/** Each assignable to the other: for the unions of literals compared here, the same set. */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;
/** Assignable: what the domain builds, the wire takes. */
type Fits<Domain, Wire> = [Domain] extends [Wire] ? true : false;
/**
 * The keys of `Domain` that `Wire` lacks, member by member when `Domain` is a union: `keyof`
 * of a union is only the keys every member shares, so an extra field on one member would
 * otherwise go unseen.
 */
type ExtraKeys<Domain, Wire> = Domain extends unknown ? Exclude<keyof Domain, keyof Wire> : never;
/** No key the wire lacks: structural typing alone would let an extra field through. */
type NoExtraKeys<Domain, Wire> = [ExtraKeys<Domain, Wire>] extends [never] ? true : false;

type Body = PlayBody;
type BodyIds = NonNullable<Body['ids']>;
type BodyShow = NonNullable<Body['show']>;
type WireIds = NonNullable<WirePlay['ids']>;
type WireShow = NonNullable<WirePlay['show']>;

export type PlayBodyIsAWirePlay = [
  Expect<Fits<Body, WirePlay>>,
  Expect<NoExtraKeys<Body, WirePlay>>,
  Expect<NoExtraKeys<BodyIds, WireIds>>,
  Expect<NoExtraKeys<BodyShow, WireShow>>,
  Expect<NoExtraKeys<NonNullable<BodyShow['ids']>, NonNullable<WireShow['ids']>>>,
  Expect<NoExtraKeys<ProviderEntry, components['schemas']['ProviderEvidence']>>,
];

/** Every state the server answers is one the domain maps, and no other. */
export type EveryStateIsMapped = [
  Expect<Equal<WireAccepted['state'], ReceiptState>>,
  Expect<Equal<WireReceipt['state'], ReceiptState>>,
];

export type TheEnvelopeIsItsFields = [
  Expect<Equal<keyof WireError['error'], (typeof WIRE_ERROR_FIELDS)[number]>>,
];

export type Fires = [
  // @ts-expect-error — a field the wire refuses (additionalProperties: false) fails the proof
  Expect<NoExtraKeys<Body & { readonly url: string }, WirePlay>>,
  // @ts-expect-error — one level down, too
  Expect<NoExtraKeys<BodyIds & { readonly justwatch: string }, WireIds>>,
  // @ts-expect-error — on one member of a union: `keyof` of the union alone would not see it
  Expect<NoExtraKeys<Body | (Body & { readonly url: string }), WirePlay>>,
  // @ts-expect-error — a kind the wire does not take is not a wire play
  Expect<Fits<Omit<Body, 'kind'> & { readonly kind: 'show' }, WirePlay>>,
  // @ts-expect-error — a year as text is not a wire play
  Expect<Fits<Omit<Body, 'year'> & { readonly year: string }, WirePlay>>,
  // @ts-expect-error — a state the server added and the domain does not map
  Expect<Equal<WireReceipt['state'] | 'archived', ReceiptState>>,
  // @ts-expect-error — an envelope field the list does not name
  Expect<Equal<keyof WireError['error'] | 'trace_id', (typeof WIRE_ERROR_FIELDS)[number]>>,
];
