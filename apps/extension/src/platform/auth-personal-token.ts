/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Sign-in for self-builds and forks (`personal_token`): the server redirects its approval only to
// allowlisted extension ids, so a build of this code under any other id pastes a personal token
// from the web app's settings instead. It is presented as `Authorization: Bearer` (the signer is
// `bearerSigner`), with no proof and no key. Compiled in only when `MT_AUTH_STRATEGIES` names it,
// and never into a store build (background.ts; the build refuses the configuration,
// config-rules.ts).
//
// The token is checked here as the server checks it before any lookup: `mts_pat_`, 43 base62
// characters of key, then the 6-character base62 CRC32 of everything before them. A typo is
// refused on the page, not by a later play's `401`.

import { randomBytes } from '@mt/api';
import { DAY_MS, uuidv7 } from '@mt/core';
import type { AuthStrategy, Clock, ConnectResult, ConnectionState } from '@mt/core';

import type { CredentialStore, SignInLog } from './auth-chrome';

const PREFIX = 'mts_pat_';
const KEY_LENGTH = 43;
const CHECKSUM_LENGTH = 6;
const SHAPE = /^mts_pat_[0-9A-Za-z]{49}$/u;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * A personal token's expiry is the one the person chose when they made it in the web app, which
 * the extension cannot read; the connection is estimated at the server's longest, a year, and
 * the server's `401` remains the truth.
 */
const ESTIMATED_LIFETIME_MS = 365 * DAY_MS;

export interface PersonalTokenDeps {
  readonly clock: Clock;
  readonly credentials: CredentialStore;
  readonly log: SignInLog;
}

export class PersonalTokenAuth implements AuthStrategy {
  readonly id = 'personal_token';
  readonly #deps: PersonalTokenDeps;

  constructor(deps: PersonalTokenDeps) {
    this.#deps = deps;
  }

  /** `code_invalid` for anything that is not a personal token, before anything is stored. */
  async connect(input?: { readonly token?: string }): Promise<ConnectResult> {
    const { clock, credentials, log } = this.#deps;
    const token = input?.token?.trim() ?? '';
    if (!isPersonalToken(token)) {
      void log('signin.refused', { strategy: this.id, kind: 'not_a_personal_token' });
      return { kind: 'code_invalid' };
    }
    const connectedAt = clock.now();
    const state: Extract<ConnectionState, { kind: 'connected' }> = {
      kind: 'connected',
      id: uuidv7(connectedAt, randomBytes),
      strategy: 'personal_token',
      connectedAt,
      expiresAt: connectedAt + ESTIMATED_LIFETIME_MS,
    };
    await credentials.saveCredential(state, token, null);
    void log('signin.connected', { strategy: this.id, connectionId: state.id });
    return { kind: 'connected', state };
  }
}

/**
 * The server's own check of a personal token: shape, then checksum.
 *
 * @public
 */
export function isPersonalToken(value: string): boolean {
  if (!SHAPE.test(value)) return false;
  const body = value.slice(0, PREFIX.length + KEY_LENGTH);
  return base62(crc32(body), CHECKSUM_LENGTH) === value.slice(PREFIX.length + KEY_LENGTH);
}

/** CRC-32 (IEEE 802.3, zlib's) of an ASCII string, bit by bit: 51 characters, no table. */
function crc32(ascii: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < ascii.length; i += 1) {
    crc ^= ascii.charCodeAt(i) & 0xff;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** `value` in base62, zero-padded to `length`, as the server encodes it. */
function base62(value: number, length: number): string {
  let out = '';
  let rest = value;
  while (rest > 0) {
    out = `${ALPHABET.charAt(rest % 62)}${out}`;
    rest = Math.floor(rest / 62);
  }
  return out.padStart(length, ALPHABET.charAt(0));
}
