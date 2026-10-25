/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';

import { buildApprovalUrl } from './approval-url';
import { ProtocolInputError } from './input-error';

const PARAMS = {
  redirectUri: 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/',
  // RFC 7636 Appendix B's challenge; RFC 7638 §3.1's thumbprint.
  challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  jkt: 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs',
  state: 'af0ifjsldkj',
};

const PINNED =
  'https://app.scenola.example/connect/extension' +
  '?client=chrome_extension' +
  '&redirect_uri=https%3A%2F%2Fabcdefghijklmnopabcdefghijklmnop.chromiumapp.org%2F' +
  '&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM' +
  '&code_challenge_method=S256' +
  '&dpop_jkt=NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs' +
  '&state=af0ifjsldkj';

describe('buildApprovalUrl', () => {
  test('is exactly the pinned URL for fixed inputs', () => {
    expect(buildApprovalUrl('https://app.scenola.example', PARAMS)).toBe(PINNED);
  });

  test('a trailing slash on the web base changes nothing', () => {
    expect(buildApprovalUrl('https://app.scenola.example/', PARAMS)).toBe(PINNED);
  });

  test('a web base with a path keeps it', () => {
    const url = new URL(buildApprovalUrl('http://localhost:3000/app', PARAMS));
    expect(url.pathname).toBe('/app/connect/extension');
  });

  test('every value reads back as given, and none can add or replace a parameter', () => {
    const hostile = {
      redirectUri: 'https://x.chromiumapp.org/?a=1&client=evil#frag',
      challenge: 'c&code_challenge_method=plain',
      jkt: 'j=k+l %2F',
      state: 's&client=evil&state=other',
    };
    const url = new URL(buildApprovalUrl('https://app.scenola.example', hostile));
    const q = url.searchParams;
    expect([...q.keys()]).toEqual([
      'client',
      'redirect_uri',
      'code_challenge',
      'code_challenge_method',
      'dpop_jkt',
      'state',
    ]);
    expect(q.get('client')).toBe('chrome_extension');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('redirect_uri')).toBe(hostile.redirectUri);
    expect(q.get('code_challenge')).toBe(hostile.challenge);
    expect(q.get('dpop_jkt')).toBe(hostile.jkt);
    expect(q.get('state')).toBe(hostile.state);
    expect(url.hash).toBe('');
  });

  test.each([
    ['not a URL', 'app.scenola.example'],
    ['not http(s)', 'javascript:alert(1)'],
    ['ftp', 'ftp://app.scenola.example'],
    ['userinfo', 'https://user:pass@app.scenola.example'],
    ['a query', 'https://app.scenola.example/?next=/x'],
    ['a fragment', 'https://app.scenola.example/#x'],
  ])('refuses a web base that is %s (bad_url) — a configuration error, loudly', (_name, base) => {
    expect(() => buildApprovalUrl(base, PARAMS)).toThrow(ProtocolInputError);
    try {
      buildApprovalUrl(base, PARAMS);
    } catch (error) {
      expect(error instanceof ProtocolInputError ? error.reason : null).toBe('bad_url');
    }
  });
});
