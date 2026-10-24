/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';

import { base64urlEncode } from './base64url';
import { ProtocolInputError } from './input-error';
import { createPkce, pkceChallenge, randomBytes } from './pkce';

// RFC 7636 Appendix B, confirmed against the RFC text.
const RFC_OCTETS = new Uint8Array([
  116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105,
  214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
]);
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;

/** A random source that answers each draw from a script, recording what was asked. */
function scripted(draws: readonly Uint8Array[]): {
  random: (n: number) => Uint8Array;
  asked: number[];
} {
  const asked: number[] = [];
  return {
    asked,
    random: (n) => {
      const draw = draws[asked.length] ?? new Uint8Array(0);
      asked.push(n);
      return draw;
    },
  };
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ProtocolInputError) return error.reason;
    throw error;
  }
  throw new Error('expected a refusal');
}

test('RFC 7636 Appendix B: the example verifier has the example S256 challenge', async () => {
  expect(await pkceChallenge(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
});

test('createPkce: the verifier is 32 random bytes, then the state is 32 more', async () => {
  const stateBytes = new Uint8Array(32).fill(7);
  const { random, asked } = scripted([RFC_OCTETS, stateBytes]);
  const pkce = await createPkce(random);
  expect(asked).toEqual([32, 32]);
  expect(pkce).toEqual({
    verifier: RFC_VERIFIER,
    challenge: RFC_CHALLENGE,
    state: base64urlEncode(stateBytes),
  });
});

test('createPkce with the platform random source: two different 43-character values', async () => {
  const pkce = await createPkce(randomBytes);
  expect(pkce.verifier).toMatch(B64URL_32);
  expect(pkce.state).toMatch(B64URL_32);
  expect(pkce.challenge).toMatch(B64URL_32);
  expect(pkce.state).not.toBe(pkce.verifier);
  expect(pkce.challenge).toBe(await pkceChallenge(pkce.verifier));
});

describe('createPkce refuses a random source that is not one', () => {
  test.each([
    ['too few bytes', [new Uint8Array(31), new Uint8Array(32).fill(1)]],
    ['too many bytes', [new Uint8Array(33), new Uint8Array(32).fill(1)]],
    ['nothing for the state', [new Uint8Array(32).fill(1)]],
    ['the same bytes twice (a stub, not a generator)', [RFC_OCTETS, RFC_OCTETS]],
  ])('%s', async (_name, draws) => {
    expect(await refusal(createPkce(scripted(draws).random))).toBe('bad_random');
  });

  test('a source that answers something other than bytes', async () => {
    const notBytes = (() => Array.from({ length: 32 }, () => 1)) as unknown as (
      n: number,
    ) => Uint8Array;
    expect(await refusal(createPkce(notBytes))).toBe('bad_random');
  });
});

describe('pkceChallenge takes only an RFC 7636 §4.1 verifier', () => {
  test.each([
    ['', 'empty'],
    ['a'.repeat(42), '42 characters'],
    ['a'.repeat(129), '129 characters'],
    [`${'a'.repeat(42)} `, 'a space'],
    [`${'a'.repeat(42)}+`, 'a "+"'],
    [`${'a'.repeat(42)}/`, 'a "/"'],
    [`${'a'.repeat(42)}=`, 'a "="'],
    [`${'a'.repeat(42)}é`, 'a non-ASCII letter'],
  ])('%j (%s) is refused', async (verifier) => {
    expect(await refusal(pkceChallenge(verifier))).toBe('bad_verifier');
  });

  test('43 and 128 characters, and every unreserved character, are verifiers', async () => {
    const unreserved = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    for (const verifier of ['a'.repeat(43), 'a'.repeat(128), unreserved]) {
      expect(await pkceChallenge(verifier)).toMatch(B64URL_32);
    }
  });
});

test('randomBytes draws n bytes from the platform, fresh each time', () => {
  const a = randomBytes(32);
  const b = randomBytes(32);
  expect(a).toBeInstanceOf(Uint8Array);
  expect(a.length).toBe(32);
  expect(a).not.toEqual(b);
});
