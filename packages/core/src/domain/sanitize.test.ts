/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The capture sanitiser's edge cases: a top-level page-state name that names the person goes
// with its value, and nothing that looks like the person stays in the URL's path. Expected values
// come from the sanitiser's rule (it "drops any value that looks like an account, profile,
// e-mail, token or URL query"), never from running the code.

import { describe, expect, test } from 'vitest';

import { sanitizeSnapshot } from './sanitize';
import type { Snapshot } from './snapshot';

const JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJqdGkiOiIxIn0.c2lnbmF0dXJl';

function page(o: Partial<Snapshot> = {}): Snapshot {
  return {
    url: { hostname: 'www.example.com', pathname: '/watch/70196253', query: {}, hash: '' },
    lang: 'en',
    documentTitle: 'Example',
    selectors: {},
    jsonLd: [],
    mediaSession: null,
    openGraph: {},
    pageState: {},
    signals: { endOfContent: false, adPlaying: false },
    ...o,
  };
}

const withPath = (pathname: string): Snapshot =>
  page({ url: { hostname: 'www.example.com', pathname, query: {}, hash: '' } });

describe('a top-level page-state name that names the person goes with its value', () => {
  test.each(['profile', 'userProfile', 'Account', 'EMAIL', 'sessionToken', 'userId', 'token'])(
    '%s is dropped at the top level as it is below it',
    (name) => {
      const out = sanitizeSnapshot(page({ pageState: { [name]: 'x', video: { id: 1 } } }));
      expect(Object.keys(out.pageState)).toEqual(['video']);
    },
  );

  test('a top-level name that is itself an e-mail address is dropped', () => {
    const out = sanitizeSnapshot(page({ pageState: { 'jane@example.com': 1, video: 2 } }));
    expect(out.pageState).toEqual({ video: 2 });
  });

  test('every other top-level name and its value stay', () => {
    const state = { video: { id: 1, title: 'Dune' }, falcor: { runtime: { value: 9300 } } };
    expect(sanitizeSnapshot(page({ pageState: state })).pageState).toEqual(state);
  });
});

describe("nothing that looks like the person stays in the URL's path", () => {
  test.each([
    ['an e-mail address', '/profiles/jane.doe@example.com/watch/1', '/profiles/<redacted>/watch/1'],
    ['a percent-encoded one', '/u/jane.doe%40example.com/watch/1', '/u/<redacted>/watch/1'],
    ['a JWT', `/s/${JWT}/watch/1`, '/s/<redacted>/watch/1'],
    ['a MediaTracker token', '/t/mts_pat_abcdef/watch', '/t/<redacted>/watch'],
  ])('%s in a segment becomes "<redacted>", the rest of the path kept', (_what, path, clean) => {
    expect(sanitizeSnapshot(withPath(path)).url.pathname).toBe(clean);
  });

  test('a path that holds nothing personal is kept as it is', () => {
    for (const path of ['/', '/watch/70196253', '/gb/watch/1?', '/@channel/videos', '']) {
      expect(sanitizeSnapshot(withPath(path)).url.pathname).toBe(path);
    }
  });

  test('a path too long to read through is redacted whole', () => {
    expect(sanitizeSnapshot(withPath(`/${'a'.repeat(5000)}`)).url.pathname).toBe('/<redacted>');
  });

  test('a segment that does not decode is judged as it is, never a throw', () => {
    expect(sanitizeSnapshot(withPath('/%E0%A4%A/watch')).url.pathname).toBe('/%E0%A4%A/watch');
    expect(sanitizeSnapshot(withPath('/%E0%A4%A@example.com/x')).url.pathname).toBe(
      '/<redacted>/x',
    );
  });
});

describe('an internationalised e-mail address is an e-mail address (RFC 6531)', () => {
  test.each(['josé@example.com', 'jane@exämple.de', '用户@例子.广告', 'ünal.çelik@şirket.com.tr'])(
    '%s is dropped wherever it is',
    (address) => {
      const out = sanitizeSnapshot(
        page({
          selectors: { parts: ['Dune', address] },
          pageState: { video: { note: address, title: 'Dune' } },
        }),
      );
      expect(out.selectors).toEqual({ parts: ['Dune'] });
      expect(out.pageState).toEqual({ video: { title: 'Dune' } });
    },
  );

  test('an "@" with no address around it is kept', () => {
    const out = sanitizeSnapshot(page({ selectors: { parts: ['@home', 'a @ b', 'x@y'] } }));
    expect(out.selectors).toEqual({ parts: ['@home', 'a @ b', 'x@y'] });
  });
});
