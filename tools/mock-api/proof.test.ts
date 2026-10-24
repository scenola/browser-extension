/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { CompactSign, base64url } from 'jose';
import { describe, expect, test } from 'vitest';

import { normalizedUrl, verifyProof } from './proof.ts';
import type { ProofCheck } from './proof.ts';

describe('normalizedUrl is the backend’s _normalized_url', () => {
  // Each expectation is what `app.scrobbling.dpop._normalized_url` answered for the input
  // (backend `.venv`, CPython 3.14, 2026-10-21). `null` is its `None`.
  test.each([
    ['http://127.0.0.1:8787/v1/integrations/plays', 'http://127.0.0.1:8787/v1/integrations/plays'],
    [
      'HTTP://127.0.0.1:8787/v1/integrations/plays?x=1#f',
      'http://127.0.0.1:8787/v1/integrations/plays',
    ],
    [
      'http://u:p@127.0.0.1:8787/v1/integrations/plays',
      'http://127.0.0.1:8787/v1/integrations/plays',
    ],
    ['http://127.0.0.1:80/a', 'http://127.0.0.1/a'],
    ['https://API.example:443/a', 'https://api.example/a'],
    ['https://api.example:0443/a', 'https://api.example/a'],
    ['http://[::1]:8787/a', 'http://[::1]:8787/a'],
    ['http://[::1/a', null],
    ['http://host:99999/a', null],
    ['http://host:+80/a', null],
    ['http://host:/a', 'http://host/a'],
    ['http://host', 'http://host/'],
    ['http:/a', null],
    ['//host/a', null],
    ['http://host/a%2Fb', 'http://host/a%2Fb'],
    ['http://host/./a', 'http://host/./a'],
    ['  http://host/a  ', 'http://host/a  '],
    ['ht\ttp://ho\nst/a', 'http://host/a'],
    ['http://h%41st/a', 'http://h%41st/a'],
    ['http://HöST/a', 'http://höst/a'],
    ['http://host:８０/a', null],
    ['http://[::FFFF:1.2.3.4]/a', 'http://[::ffff:1.2.3.4]/a'],
    ['http://[v1.x]/a', 'http://v1.x/a'],
    ['http://host/a?', 'http://host/a'],
    ['mailto://host/a', 'mailto://host/a'],
    ['http://host:80@other/a', 'http://other/a'],
    ['http://a@b@host/a', 'http://host/a'],
  ])('%j → %j', (input, expected) => {
    expect(normalizedUrl(input)).toBe(expected);
  });
});

describe('verifyProof', () => {
  const check = (over: Partial<ProofCheck> = {}): ProofCheck => ({
    method: 'POST',
    url: 'http://127.0.0.1:8787/v1/integrations/oauth/token',
    credential: null,
    expectedJkt: null,
    nonceIsCurrent: (nonce) => nonce === 'n-current',
    ...over,
  });

  async function proof(header: Record<string, unknown>, claims: Record<string, unknown>) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const signed = await new CompactSign(new TextEncoder().encode(JSON.stringify(claims)))
      .setProtectedHeader({
        typ: 'dpop+jwt',
        alg: 'ES256',
        jwk: { kty: 'EC', crv: 'P-256', x: jwk.x ?? '', y: jwk.y ?? '' },
        ...header,
      })
      .sign(pair.privateKey);
    return { signed, jwk };
  }

  const claims = {
    jti: 'abcdefgh-1234',
    htm: 'POST',
    htu: 'http://127.0.0.1:8787/v1/integrations/oauth/token',
    iat: 1,
    nonce: 'n-current',
  };

  test('a good proof verifies and names its key; a stale nonce is the nonce answer', async () => {
    const { signed } = await proof({}, claims);
    expect(await verifyProof(signed, check())).toMatchObject({ kind: 'ok', jti: claims.jti });
    const stale = await proof({}, { ...claims, nonce: 'n-old' });
    expect(await verifyProof(stale.signed, check())).toEqual({ kind: 'nonce' });
  });

  test('a point off the curve is bad_jwk, before any key comparison', async () => {
    const { jwk } = await proof({}, claims);
    const y = base64url.decode(jwk.y ?? '');
    y[31] = (y[31] ?? 0) ^ 1;
    const header = { jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: base64url.encode(y) } };
    const { signed } = await proof(header, claims);
    expect(await verifyProof(signed, check({ expectedJkt: 'x'.repeat(43) }))).toEqual({
      kind: 'invalid',
      reason: 'bad_jwk',
    });
  });

  test('the checks run in the server’s order: the key before the nonce, the nonce before jti', async () => {
    const { signed } = await proof({}, { ...claims, nonce: undefined, jti: 'x' });
    expect(await verifyProof(signed, check({ expectedJkt: 'y'.repeat(43) }))).toEqual({
      kind: 'invalid',
      reason: 'wrong_key',
    });
    expect(await verifyProof(signed, check())).toEqual({ kind: 'nonce' });
  });

  test('hostile strings are refusals, never throws', async () => {
    for (const text of ['', '.', '..', 'a.b.c', 'x'.repeat(5000), '\u0000.\u0000.\u0000']) {
      const verdict = await verifyProof(text, check());
      expect(verdict.kind).toBe('invalid');
    }
  });
});
