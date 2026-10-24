/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DAY_MS } from './time';
import type { EpochMs } from './time';

export type ConnectionState =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'connected';
      readonly id: string;
      readonly strategy: 'pkce_dpop' | 'personal_token';
      readonly connectedAt: EpochMs;
      readonly expiresAt: EpochMs;
    }
  | { readonly kind: 'broken'; readonly reason: 'credential_invalid' | 'key_missing' };

const SLIDE_MS = 90 * DAY_MS;
const LIFETIME_MS = 365 * DAY_MS;
const WARNING_MS = 14 * DAY_MS;

/** The estimate after a successful use: `min(now + 90 d, connectedAt + 365 d)`. */
export function slideExpiry(state: ConnectionState, now: EpochMs): ConnectionState {
  if (state.kind !== 'connected') return state;
  return { ...state, expiresAt: Math.min(now + SLIDE_MS, state.connectedAt + LIFETIME_MS) };
}

/** Within 14 days of the estimated expiry (or past it). */
export function expiringSoon(state: ConnectionState, now: EpochMs): boolean {
  return state.kind === 'connected' && state.expiresAt - now <= WARNING_MS;
}
