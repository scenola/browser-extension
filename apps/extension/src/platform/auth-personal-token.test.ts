/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Personal tokens for self-builds: `mts_pat_` + 43 base62 characters + 6 of checksum. The tokens
// below were minted with the API's own algorithm (43 base62 characters of key, then the base62 of
// `zlib.crc32(prefix + key)` in 6), run in Python's `zlib`, not in this code.

import { FakeClock } from '@mt/core/testing';
import { describe, expect, test, vi } from 'vitest';

import { PersonalTokenAuth, isPersonalToken } from './auth-personal-token';

const VALID = [
  'mts_pat_eYcIpLYFzswLC0Fmj3l9LQRSx4MtPGYVzmamLfH7xrh2X1Z3I',
  'mts_pat_HTWlhiPvxqKH45eAyhr52KsoSIcSKdMpZhfIiRu3XEI1gxOqe',
  'mts_pat_bYUxJhNFNDo7IYjDsRPZKtZ3j4qphKZ3scAsQv00V682P7MEw',
];

const REFUSED: readonly (readonly [string, string])[] = [
  // 42 characters of key, its own checksum correct.
  ['a key one short', 'mts_pat_eYcIpLYFzswLC0Fmj3l9LQRSx4MtPGYVzmamLfH7xr0iDE3B'],
  // 44 characters of key, its own checksum correct.
  ['a key one long', 'mts_pat_eYcIpLYFzswLC0Fmj3l9LQRSx4MtPGYVzmamLfH7xrhQ4Un5Ii'],
  // One character of the key changed: the checksum no longer holds.
  ['a typo', 'mts_pat_eYcIpLYFzswLA0Fmj3l9LQRSx4MtPGYVzmamLfH7xrh2X1Z3I'],
  // A valid extension credential: another kind, whose checksum covers `mts_ext_`.
  ['an extension credential', 'mts_ext_ka7RCcRX83UbUVjedTTl7QxIK0rr56HqGWpj9MbfFw00RgoX0'],
  [
    'the same key under the personal prefix',
    'mts_pat_ka7RCcRX83UbUVjedTTl7QxIK0rr56HqGWpj9MbfFw00RgoX0',
  ],
  // A character outside base62 in the key.
  ['a non-base62 character', 'mts_pat_eYcIpLYFzswLC0Fmj3l9LQRSx4MtPGYVzmamLfH7x-h2X1Z3I'],
  ['the prefix alone', 'mts_pat_'],
  ['nothing', ''],
  ['a token followed by more', `${VALID[0] ?? ''}x`],
  ['a token inside text', `token: ${VALID[0] ?? ''}`],
];

function strategy() {
  const saveCredential = vi.fn(() => Promise.resolve());
  const auth = new PersonalTokenAuth({
    clock: new FakeClock(Date.UTC(2026, 9, 22, 18, 0)),
    credentials: { saveCredential },
    log: () => Promise.resolve(),
  });
  return { auth, saveCredential };
}

describe('PersonalTokenAuth', () => {
  test.each(VALID)('accepts %s and stores it with no key (Bearer, no DPoP)', async (token) => {
    const { auth, saveCredential } = strategy();

    const result = await auth.connect({ token });

    expect(isPersonalToken(token)).toBe(true);
    expect(result.kind).toBe('connected');
    expect(result.kind === 'connected' ? result.state.strategy : null).toBe('personal_token');
    expect(saveCredential).toHaveBeenCalledTimes(1);
    expect(saveCredential).toHaveBeenCalledWith(expect.anything(), token, null);
  });

  test.each(REFUSED)('refuses %s, storing nothing', async (_why, token) => {
    const { auth, saveCredential } = strategy();

    const result = await auth.connect({ token });

    expect(isPersonalToken(token)).toBe(false);
    expect(result.kind).not.toBe('connected');
    expect(saveCredential).not.toHaveBeenCalled();
  });

  test('refuses a connect with no token at all', async () => {
    const { auth, saveCredential } = strategy();
    expect((await auth.connect()).kind).not.toBe('connected');
    expect(saveCredential).not.toHaveBeenCalled();
  });
});
