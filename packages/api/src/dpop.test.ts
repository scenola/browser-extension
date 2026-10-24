/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EmbeddedJWK, base64url, calculateJwkThumbprint, jwtVerify } from 'jose';
import { beforeAll, describe, expect, test } from 'vitest';

import type { DpopProofInput } from './dpop';
import { createDpopProof, dpopHtu } from './dpop';
import { ProtocolInputError } from './input-error';
import type { PublicJwk } from './keys';
import { generateDpopKey, jwkThumbprint, publicJwk } from './keys';
import { MAX_NONCE_LENGTH } from './nonce';

const PLAYS = 'https://api.example/v1/integrations/plays';
const JTI = '0192f1a2-7b3c-7d4e-8f5a-6b7c8d9e0f10';
const NOW = 1_700_000_000_999;

// The server's own bound on a proof (its proof size limit).
const SERVER_PROOF_MAX_BYTES = 4096;

let pair: CryptoKeyPair;
let jwk: PublicJwk;
beforeAll(async () => {
  pair = await generateDpopKey();
  jwk = await publicJwk(pair);
});

function input(over: Partial<DpopProofInput> = {}): DpopProofInput {
  return {
    pair,
    jwk,
    method: 'POST',
    url: `${PLAYS}?x=1#y`,
    nonce: null,
    accessToken: null,
    now: NOW,
    jti: JTI,
    ...over,
  };
}

/** Verify as a DPoP server would begin to: the header's own key, ES256, `typ: dpop+jwt`. */
async function verified(proof: string) {
  return jwtVerify(proof, EmbeddedJWK, { typ: 'dpop+jwt', algorithms: ['ES256'] });
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

async function sha256Base64url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return base64url.encode(new Uint8Array(digest));
}

describe('a proof', () => {
  test('verifies against its own header key, typed dpop+jwt, ES256 — and names the request', async () => {
    const { protectedHeader, payload } = await verified(await createDpopProof(input()));
    expect(protectedHeader).toEqual({
      typ: 'dpop+jwt',
      alg: 'ES256',
      jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    });
    // No query, no fragment; iat in whole seconds; nothing else without a nonce or a token.
    expect(payload).toEqual({ jti: JTI, htm: 'POST', htu: PLAYS, iat: 1_700_000_000 });
  });

  test("the header's key is the key the connection is bound to (its RFC 7638 thumbprint)", async () => {
    const { protectedHeader } = await verified(await createDpopProof(input()));
    const headerJwk = protectedHeader.jwk;
    expect(headerJwk).toBeDefined();
    expect(await calculateJwkThumbprint({ ...headerJwk }, 'sha256')).toBe(await jwkThumbprint(jwk));
  });

  test('the signature is JWS r‖s (64 bytes), not DER', async () => {
    const signature = (await createDpopProof(input())).split('.')[2] ?? '';
    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(base64url.decode(signature).length).toBe(64);
  });

  test('carries the nonce only when one is given', async () => {
    const withNonce = await verified(await createDpopProof(input({ nonce: 'n-1' })));
    expect(withNonce.payload.nonce).toBe('n-1');
    const without = await verified(await createDpopProof(input({ nonce: null })));
    expect('nonce' in without.payload).toBe(false);
  });

  test('carries ath = BASE64URL(SHA-256(ASCII(token))) (RFC 9449 §4.2), only with a token', async () => {
    const token = 'mts_ext_test';
    const { payload } = await verified(await createDpopProof(input({ accessToken: token })));
    // Pinned from an independent computation (Python hashlib), and recomputed here.
    expect(payload.ath).toBe('PcYAVAMY7ovtcPF4UYCdqtuGwtYh0OAXSG8xHftmuRQ');
    expect(payload.ath).toBe(await sha256Base64url(token));
    const without = await verified(await createDpopProof(input({ accessToken: null })));
    expect('ath' in without.payload).toBe(false);
  });

  test("RFC 9449 §7.1 (Figures 13–14): the RFC's access token has the RFC's ath", async () => {
    const token = 'Kz~8mXK1EalYznwH-LC-1fBAo.4Ljp~zsPE_NeO.gxU';
    const { payload } = await verified(
      await createDpopProof(input({ method: 'GET', accessToken: token })),
    );
    expect(payload.ath).toBe('fUHyO2r2Z3DZ53EsNrWBb0xWXoaNy59IiKCAqksmQEo');
  });

  test('the method is sent upper-case, as the server compares it', async () => {
    const { payload } = await verified(await createDpopProof(input({ method: 'post' })));
    expect(payload.htm).toBe('POST');
  });

  test('every proof carries the jti it is given, and iat from its own now', async () => {
    const a = await verified(await createDpopProof(input({ jti: 'proof-one-aaaa', now: 1_000 })));
    const b = await verified(await createDpopProof(input({ jti: 'proof-two-bbbb', now: 61_999 })));
    expect([a.payload.jti, a.payload.iat]).toEqual(['proof-one-aaaa', 1]);
    expect([b.payload.jti, b.payload.iat]).toEqual(['proof-two-bbbb', 61]);
  });

  test('the header names only kty, crv, x and y, whatever else the stored JWK carries', async () => {
    const decorated = { ...jwk, kid: 'k1', ext: true, key_ops: ['verify'], alg: 'ES256' };
    const { protectedHeader } = await verified(await createDpopProof(input({ jwk: decorated })));
    expect(Object.keys(protectedHeader.jwk ?? {}).sort()).toEqual(['crv', 'kty', 'x', 'y']);
  });

  test("at every input's bound the proof stays inside the server's 4096-byte limit", async () => {
    const url = `https://api.example/${'a'.repeat(2048 - 'https://api.example/'.length)}`;
    expect(url.length).toBe(2048);
    const proof = await createDpopProof(
      input({
        url,
        method: 'A'.repeat(16),
        jti: 'j'.repeat(128),
        nonce: '~'.repeat(MAX_NONCE_LENGTH),
        accessToken: 't'.repeat(1024),
        now: 8_640_000_000_000_000,
      }),
    );
    expect(proof.length).toBeLessThanOrEqual(SERVER_PROOF_MAX_BYTES);
    const { payload } = await verified(proof);
    expect(payload.htu).toBe(url);
    expect(payload.nonce).toBe('~'.repeat(MAX_NONCE_LENGTH));
  });
});

describe('a nonce that is not one is left out, never sent — the server answers with a fresh one', () => {
  test.each([
    ['a space', 'abc def'],
    ['two headers joined', 'n1, n2'],
    ['a double quote', 'ab"c'],
    ['a backslash', 'ab\\c'],
    ['a newline', 'ab\nc'],
    ['a non-ASCII letter', 'abcé'],
    ['empty', ''],
    ['past the bound', 'n'.repeat(MAX_NONCE_LENGTH + 1)],
  ])('%s', async (_name, nonce) => {
    const { payload } = await verified(await createDpopProof(input({ nonce })));
    expect('nonce' in payload).toBe(false);
  });

  test('every NQCHAR is carried verbatim', async () => {
    const nonce = "!#$%&'()*+,-./09:;<=>?@AZ[]^_`az{|}~";
    const { payload } = await verified(await createDpopProof(input({ nonce })));
    expect(payload.nonce).toBe(nonce);
  });
});

describe('htu: what the server rebuilds from its public base URL and the path', () => {
  // The server's URL normalisation lowercases the scheme and
  // host, drops the default port, keeps the path as it is and drops query and fragment. Each
  // accepted value below was also run through that function: it is its own normal form.
  test.each([
    [`${PLAYS}?x=1#y`, PLAYS],
    [`${PLAYS}#fragment`, PLAYS],
    ['HTTPS://API.Example/v1/Integrations/Plays', 'https://api.example/v1/Integrations/Plays'],
    ['https://api.example:443/v1/x', 'https://api.example/v1/x'],
    ['http://api.example:80/v1/x', 'http://api.example/v1/x'],
    ['https://api.example:8443/v1/x', 'https://api.example:8443/v1/x'],
    ['http://api.example:443/v1/x', 'http://api.example:443/v1/x'],
    ['https://api.example:/v1/x', 'https://api.example/v1/x'],
    ['http://localhost:8787/v1/integrations/plays', 'http://localhost:8787/v1/integrations/plays'],
    ['http://127.0.0.1:8787/v1/x', 'http://127.0.0.1:8787/v1/x'],
    ['http://[::1]:8787/v1/x', 'http://[::1]:8787/v1/x'],
    ['https://[2001:DB8::1]/v1/x', 'https://[2001:db8::1]/v1/x'],
    ['https://xn--bcher-kva.example/v1/x', 'https://xn--bcher-kva.example/v1/x'],
    ['https://api.example', 'https://api.example/'],
    ['https://api.example?x=1', 'https://api.example/'],
    ['https://api.example./v1/x', 'https://api.example./v1/x'],
    ['https://api.example/v1/x/', 'https://api.example/v1/x/'],
    // Dot segments are resolved: that is the path `fetch` sends, so the path the server sees.
    [
      'https://api.example/v1/./a/../integrations/plays',
      'https://api.example/v1/integrations/plays',
    ],
  ])('%s → %s', (url, htu) => {
    expect(dpopHtu(url)).toBe(htu);
  });

  // Each of these either is not a URL a request should go to, or is one whose host or path
  // the server would spell differently from the browser — a proof that cannot verify, and on
  // a resource route a 401 that sends the person to reconnect.
  test.each([
    ['https://user:pass@api.example/v1/x', 'userinfo'],
    ['https://user@api.example/v1/x', 'a user name'],
    ['https://@api.example/v1/x', 'an empty userinfo'],
    ['http://[0:0:0:0:0:0:0:1]/v1/x', 'an IPv6 host the browser would compress'],
    ['http://[::FFFF:127.0.0.1]/v1/x', 'an IPv4-mapped IPv6 host the browser would rewrite'],
    ['http://[fe80::1%25eth0]/v1/x', 'an IPv6 zone'],
    ['http://127.1/v1/x', 'a short IPv4 host the browser would expand'],
    ['http://0x7f.0.0.1/v1/x', 'a hexadecimal IPv4 host'],
    ['https://bücher.example/v1/x', 'an internationalised host (sent as punycode)'],
    ['https://api%2Eexample/v1/x', 'a percent-encoded host'],
    ['https://api.example/v1/a%20b', 'a percent-encoded path (the server compares it decoded)'],
    ['https://api.example/v1/"x"', 'a path the browser would percent-encode'],
    ['https://api.example/v1/{x}', 'braces the browser would percent-encode'],
    ['https://api.example/v1/a b', 'a space'],
    [' https://api.example/v1/x', 'leading whitespace'],
    ['https://api.example/v1/x\n', 'a trailing newline'],
    ['https://api.ex\tample/v1/x', 'a tab the browser would strip'],
    ['https:\\\\api.example\\v1\\x', 'backslashes'],
    ['https://api.example\\v1\\x', 'a backslash ending the host'],
    ['https:api.example/v1/x', 'no "//"'],
    ['//api.example/v1/x', 'a scheme-relative reference'],
    ['/v1/integrations/plays', 'a path alone'],
    ['api.example/v1/x', 'no scheme'],
    ['ftp://api.example/v1/x', 'another scheme'],
    ['wss://api.example/v1/x', 'a WebSocket scheme'],
    ['file:///etc/passwd', 'a file URL'],
    ['javascript:alert(1)', 'a script URL'],
    ['data:,x', 'a data URL'],
    ['https://api.example:65536/v1/x', 'a port out of range'],
    ['https://api.example:44a/v1/x', 'a port that is not a number'],
    [`https://api.example/${'a'.repeat(2048)}`, 'past 2048 characters'],
    ['', 'empty'],
  ])('%j (%s) has none', (url) => {
    expect(dpopHtu(url)).toBeNull();
  });
});

describe('createDpopProof refuses to sign what the server would refuse', () => {
  test.each([
    ['userinfo', { url: 'https://user:pass@api.example/v1/integrations/plays' }],
    ['a relative URL', { url: '/v1/integrations/plays' }],
  ])('a URL with %s: bad_url', async (_name, over) => {
    expect(await refusal(createDpopProof(input(over)))).toBe('bad_url');
  });

  test.each(['', 'PO ST', 'PÓST', 'GET\n', 'G'.repeat(17), 'GET/1'])(
    'method %j: bad_method',
    async (method) => {
      expect(await refusal(createDpopProof(input({ method })))).toBe('bad_method');
    },
  );

  test.each([
    ['empty', ''],
    ['seven characters', 'abcdefg'],
    ['129 characters', 'j'.repeat(129)],
    ['a space', 'abcd efgh'],
    ['a slash', 'abcd/efgh'],
    ['base64 padding', 'abcdefgh=='],
    ['non-ASCII', 'jtí-0001-aaaa'],
  ])('a jti with %s: bad_jti', async (_name, jti) => {
    expect(await refusal(createDpopProof(input({ jti })))).toBe('bad_jti');
  });

  test.each([
    ['empty', ''],
    ['a non-ASCII letter', 'mts_ext_tëst'],
    ['an astral character', 'mts_ext_\u{1F600}'],
    ['a space', 'mts_ext test'],
    ['a double quote', 'mts_ext_"x"'],
    ['padding inside', 'abc==def'],
    ['past 1024 characters', 't'.repeat(1025)],
  ])('an access token with %s: bad_access_token', async (_name, accessToken) => {
    expect(await refusal(createDpopProof(input({ accessToken })))).toBe('bad_access_token');
  });

  test.each([NaN, Infinity, -Infinity, -1, 8_640_000_000_000_001])(
    'now = %s: bad_time',
    async (now) => {
      expect(await refusal(createDpopProof(input({ now })))).toBe('bad_time');
    },
  );

  test('a JWK that is not a public P-256 key: bad_jwk', async () => {
    const withD = { ...jwk, d: 'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI' };
    expect(await refusal(createDpopProof(input({ jwk: withD })))).toBe('bad_jwk');
    const rsa = { ...jwk, kty: 'RSA' } as unknown as PublicJwk;
    expect(await refusal(createDpopProof(input({ jwk: rsa })))).toBe('bad_jwk');
  });

  test("another key's JWK: bad_key (the header would name a key that did not sign)", async () => {
    const other = await publicJwk(await generateDpopKey());
    expect(await refusal(createDpopProof(input({ jwk: other })))).toBe('bad_key');
  });

  test('an extractable key: bad_key (a DPoP key never leaves the browser)', async () => {
    const extractable = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const ownJwk = await publicJwk(extractable);
    expect(await refusal(createDpopProof(input({ pair: extractable, jwk: ownJwk })))).toBe(
      'bad_key',
    );
  });

  test('a P-384 key, or a pair whose halves are swapped: bad_key', async () => {
    const p384 = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, false, [
      'sign',
    ]);
    expect(await refusal(createDpopProof(input({ pair: p384 })))).toBe('bad_key');
    const swapped = { privateKey: pair.publicKey, publicKey: pair.privateKey };
    expect(await refusal(createDpopProof(input({ pair: swapped })))).toBe('bad_key');
  });

  test('whatever storage held instead of a pair (null, {}, a lone private key): bad_key', async () => {
    for (const held of [null, {}, { privateKey: pair.privateKey }]) {
      const notAPair = held as unknown as CryptoKeyPair;
      expect(await refusal(createDpopProof(input({ pair: notAPair })))).toBe('bad_key');
    }
  });

  test('a refusal says why, and never what it was given', async () => {
    const token = 'mts_ext_tëst-secret';
    const url = 'https://user:secret@api.example/v1/integrations/plays';
    const inputs: readonly Partial<DpopProofInput>[] = [{ accessToken: token }, { url }];
    for (const over of inputs) {
      const error = await createDpopProof(input(over)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ProtocolInputError);
      expect(String(error)).not.toMatch(/secret|tëst|api\.example/);
    }
  });
});
