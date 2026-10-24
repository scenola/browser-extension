/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { calculateJwkThumbprint, compactVerify, importJWK } from 'jose';
import { beforeAll, describe, expect, test } from 'vitest';

import { base64urlEncode } from './base64url';
import { ProtocolInputError } from './input-error';
import type { PublicJwk } from './keys';
import { generateDpopKey, isDpopKeyPair, jwkThumbprint, publicJwk, readPublicJwk } from './keys';

// RFC 9449 §4.2 Figure 4 (the example key) and §6.1 Figure 9 (its `jkt`), confirmed against
// the RFC text and recomputed independently (Python hashlib over the RFC 7638 form).
const RFC9449_JWK: PublicJwk = {
  kty: 'EC',
  crv: 'P-256',
  x: 'l8tFrhx-34tV3hRICRDY9zCkDlpBhF42UQUfWVAWBFs',
  y: '9VE4jf_Ok_o64zbTTlcuNJajHmt6v9TDVrU0CdvGRDA',
};
const RFC9449_JKT = '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I';

const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ProtocolInputError) return error.reason;
    throw error;
  }
  throw new Error('expected a refusal');
}

let pair: CryptoKeyPair;
beforeAll(async () => {
  pair = await generateDpopKey();
});

describe('the thumbprint (RFC 7638)', () => {
  test("RFC 9449's example key has the RFC's jkt, and jose agrees", async () => {
    expect(await jwkThumbprint(RFC9449_JWK)).toBe(RFC9449_JKT);
    expect(await calculateJwkThumbprint({ ...RFC9449_JWK }, 'sha256')).toBe(RFC9449_JKT);
  });

  test('a generated key: ours equals jose', async () => {
    const jwk = await publicJwk(pair);
    expect(await jwkThumbprint(jwk)).toBe(await calculateJwkThumbprint({ ...jwk }, 'sha256'));
  });

  test('member order and members RFC 7638 does not hash change nothing', async () => {
    const reordered = { y: RFC9449_JWK.y, x: RFC9449_JWK.x, crv: 'P-256', kty: 'EC' } as const;
    const decorated = { ...RFC9449_JWK, kid: 'k1', ext: true, key_ops: ['verify'] };
    expect(await jwkThumbprint(reordered)).toBe(RFC9449_JKT);
    expect(await jwkThumbprint(decorated)).toBe(RFC9449_JKT);
  });

  test('a JWK that is not a public P-256 key has no thumbprint here', async () => {
    const withD = { ...RFC9449_JWK, d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI' };
    expect(await refusal(jwkThumbprint(withD as PublicJwk))).toBe('bad_jwk');
    const short = { ...RFC9449_JWK, x: RFC9449_JWK.x.slice(1) };
    expect(await refusal(jwkThumbprint(short))).toBe('bad_jwk');
  });

  test('two keys, two thumbprints', async () => {
    const other = await generateDpopKey();
    const a = await jwkThumbprint(await publicJwk(pair));
    const b = await jwkThumbprint(await publicJwk(other));
    expect(a).toMatch(B64URL_32);
    expect(a).not.toBe(b);
  });
});

describe('generateDpopKey', () => {
  test('ECDSA P-256; the private key signs, and only signs', () => {
    expect(pair.privateKey.type).toBe('private');
    expect(pair.privateKey.usages).toEqual(['sign']);
    expect(pair.privateKey.algorithm).toMatchObject({ name: 'ECDSA', namedCurve: 'P-256' });
    expect(pair.publicKey.type).toBe('public');
    expect(pair.publicKey.algorithm).toMatchObject({ name: 'ECDSA', namedCurve: 'P-256' });
  });

  test('the private key is not extractable, in any format', async () => {
    expect(pair.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('jwk', pair.privateKey)).rejects.toThrow();
    await expect(crypto.subtle.exportKey('pkcs8', pair.privateKey)).rejects.toThrow();
  });

  test('what it makes is a DPoP key pair', () => {
    expect(isDpopKeyPair(pair)).toBe(true);
  });
});

describe('publicJwk', () => {
  test('carries exactly kty, crv, x and y — never d, ext or key_ops', async () => {
    const jwk = await publicJwk(pair);
    expect(Object.keys(jwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(jwk.kty).toBe('EC');
    expect(jwk.crv).toBe('P-256');
    expect(jwk.x).toMatch(B64URL_32);
    expect(jwk.y).toMatch(B64URL_32);
  });

  test("is the private key's own public half: what the private key signs, it verifies", async () => {
    const jwk = await publicJwk(pair);
    const header = base64urlEncode(new TextEncoder().encode('{"alg":"ES256"}'));
    const payload = base64urlEncode(new TextEncoder().encode('{}'));
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    const jws = `${header}.${payload}.${base64urlEncode(new Uint8Array(signature))}`;
    const key = await importJWK({ ...jwk }, 'ES256');
    await expect(compactVerify(jws, key)).resolves.toBeDefined();
  });

  test('refuses a pair that is not P-256 ECDSA', async () => {
    const p384 = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, false, [
      'sign',
    ]);
    expect(await refusal(publicJwk(p384))).toBe('bad_key');
  });
});

describe('readPublicJwk is total over whatever storage holds', () => {
  const nonCanonicalX = `${RFC9449_JWK.x.slice(0, 42)}t`; // the last two bits set
  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'EC'],
    ['a number', 42],
    ['an array', [RFC9449_JWK]],
    ['an empty object', {}],
    [
      'a private key (d present)',
      { ...RFC9449_JWK, d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI' },
    ],
    ['an RSA key', { ...RFC9449_JWK, kty: 'RSA' }],
    ['another curve', { ...RFC9449_JWK, crv: 'P-384' }],
    ['a short x', { ...RFC9449_JWK, x: RFC9449_JWK.x.slice(1) }],
    ['a long y', { ...RFC9449_JWK, y: `${RFC9449_JWK.y}A` }],
    ['a numeric x', { ...RFC9449_JWK, x: 42 }],
    ['a missing y', { kty: 'EC', crv: 'P-256', x: RFC9449_JWK.x }],
    ['base64, not base64url', { ...RFC9449_JWK, x: RFC9449_JWK.x.replace('-', '+') }],
    ['a non-canonical coordinate', { ...RFC9449_JWK, x: nonCanonicalX }],
  ])('%s → null', (_name, value) => {
    expect(readPublicJwk(value)).toBeNull();
  });

  test('a JWK as WebCrypto exports it reads as its four members', async () => {
    const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
    expect(exported.ext).toBe(true);
    expect(readPublicJwk(exported)).toEqual(await publicJwk(pair));
  });
});

describe('isDpopKeyPair is total over whatever storage holds', () => {
  test('an extractable pair is not one', async () => {
    const extractable = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    expect(isDpopKeyPair(extractable)).toBe(false);
  });

  test('a P-384 pair is not one', async () => {
    const p384 = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, false, [
      'sign',
    ]);
    expect(isDpopKeyPair(p384)).toBe(false);
  });

  test('a private key that cannot sign is not one', async () => {
    const derive = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
      'deriveBits',
    ]);
    expect(isDpopKeyPair(derive)).toBe(false);
  });

  test('halves swapped, or plain data shaped like keys, are not one', () => {
    expect(isDpopKeyPair({ privateKey: pair.publicKey, publicKey: pair.privateKey })).toBe(false);
    expect(isDpopKeyPair({ privateKey: pair.privateKey })).toBe(false);
    const lookalike = { type: 'private', extractable: false, usages: ['sign'] };
    expect(isDpopKeyPair({ privateKey: lookalike, publicKey: pair.publicKey })).toBe(false);
    for (const value of [null, undefined, 0, 'pair', [], {}]) {
      expect(isDpopKeyPair(value)).toBe(false);
    }
  });
});
