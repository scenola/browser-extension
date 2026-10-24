/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the capture sanitiser says it removed. Each removal counts once, by the kind that removed
// it: query values, entries named for an account or a profile, e-mail addresses, tokens, links
// with a query, and strings too long to read through. A string that is several of these is
// counted as the first of: too long, an e-mail address, a token, a link with a query.

import { describe, expect, test } from 'vitest';

import { REMOVED_KINDS, sanitizeCapture } from './sanitize';
import type { Removed } from './sanitize';
import type { Snapshot } from './snapshot';

const JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJqdGkiOiIxIn0.c2lnbmF0dXJl';
const NONE: Removed = {
  query_values: 0,
  named_entries: 0,
  emails: 0,
  tokens: 0,
  links_with_query: 0,
  overlong: 0,
};

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

const removedFrom = (o: Partial<Snapshot>): Removed => sanitizeCapture(page(o)).removed;
const counts = (over: Partial<Removed>): Removed => ({ ...NONE, ...over });

describe('the counts', () => {
  test('are one number per kind, in the order a capture lists them, all zero for a clean page', () => {
    const { removed } = sanitizeCapture(page());
    expect(Object.keys(removed)).toEqual([...REMOVED_KINDS]);
    expect(REMOVED_KINDS).toEqual([
      'query_values',
      'named_entries',
      'emails',
      'tokens',
      'links_with_query',
      'overlong',
    ]);
    expect(removed).toEqual(NONE);
  });

  test('the page is returned with what was removed, and the input is not changed', () => {
    const input = page({
      url: { hostname: 'a.example', pathname: '/x', query: { t: 'secret' }, hash: '' },
    });
    const before = JSON.stringify(input);
    const out = sanitizeCapture(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(out.snapshot.url.query).toEqual({ t: '<redacted>' });
  });
});

describe('query values', () => {
  test('are counted one per parameter, and their names are kept', () => {
    const out = sanitizeCapture(
      page({
        url: {
          hostname: 'a.example',
          pathname: '/x',
          query: { s: '5', e: '1', token: 'abc' },
          hash: '',
        },
      }),
    );
    expect(out.removed).toEqual(counts({ query_values: 3 }));
    expect(out.snapshot.url.query).toEqual({
      s: '<redacted>',
      e: '<redacted>',
      token: '<redacted>',
    });
  });

  test('a page with no query counts none', () => {
    expect(removedFrom({}).query_values).toBe(0);
  });
});

describe('entries named for the person', () => {
  test.each(['profile', 'userProfile', 'Account', 'EMAIL', 'sessionToken', 'userId', 'token'])(
    'a top-level page-state entry named %s is one',
    (name) => {
      expect(removedFrom({ pageState: { [name]: 'x', video: 1 } })).toEqual(
        counts({ named_entries: 1 }),
      );
    },
  );

  test('at any depth, one per name, and the value under a named entry is not walked', () => {
    const removed = removedFrom({
      pageState: {
        video: { id: 1, profileName: 'a', nested: { accountId: 3, ok: true } },
        // Everything below a named entry goes with it, uncounted: an e-mail address in there
        // is not a second removal.
        userData: { contact: 'jane@example.com', link: 'https://x.example/?q=1' },
      },
    });
    expect(removed).toEqual(counts({ named_entries: 3 }));
  });

  test('in JSON-LD too', () => {
    expect(
      removedFrom({
        jsonLd: [{ '@type': 'Movie', name: 'X', author: { email: 'a@b.co', name: 'N' } }],
      }),
    ).toEqual(counts({ named_entries: 1 }));
  });

  test('a name that is itself an e-mail address is a named entry, not an e-mail', () => {
    expect(removedFrom({ pageState: { 'jane@example.com': 1 } })).toEqual(
      counts({ named_entries: 1 }),
    );
  });

  test('a name that does not name the person is kept and counts nothing', () => {
    expect(removedFrom({ pageState: { video: { id: 1, title: 'Dune' } } })).toEqual(NONE);
  });
});

describe('strings that look like the person', () => {
  test.each([
    ['an e-mail address', 'jane.doe@example.com', counts({ emails: 1 })],
    ['an internationalised e-mail address', 'josé@example.com', counts({ emails: 1 })],
    ['a JWT', JWT, counts({ tokens: 1 })],
    ['a MediaTracker access token', 'mts_pat_abcdef', counts({ tokens: 1 })],
    ['a MediaTracker refresh token', 'mt_rt_abcdef', counts({ tokens: 1 })],
    ['a link with a query', 'https://x.example/a?b=1', counts({ links_with_query: 1 })],
    [
      'a link with a query after text',
      'see https://x.example/a?b=1 now',
      counts({ links_with_query: 1 }),
    ],
    ['a string over 2000 characters', 'a'.repeat(2001), counts({ overlong: 1 })],
  ])('%s in a selector value is counted by its kind', (_name, value, expected) => {
    expect(removedFrom({ selectors: { s: [value, 'fine'] } })).toEqual(expected);
  });

  test.each([
    ['a link without a query', 'https://x.example/a/b'],
    ['a link whose ? is in its fragment', 'https://x.example/a#b?c'],
    ['a plain title', 'Breaking Bad'],
    ['an @ with no address around it', 'meet @ 8'],
    ['a string of 2000 characters', 'a'.repeat(2000)],
  ])('%s counts nothing', (_name, value) => {
    expect(removedFrom({ selectors: { s: [value] } })).toEqual(NONE);
  });

  test('one removal per string, however many values a selector holds', () => {
    expect(removedFrom({ selectors: { a: ['x@y.zz', 'ok', 'u@v.ww'], b: [JWT] } })).toEqual(
      counts({ emails: 2, tokens: 1 }),
    );
  });

  test('a string that is several things is counted as the first of them', () => {
    // Too long wins over everything: the string is not searched.
    expect(removedFrom({ selectors: { s: [`${'a'.repeat(2001)} jane@example.com`] } })).toEqual(
      counts({ overlong: 1 }),
    );
    // An e-mail address wins over a link with a query that holds one.
    expect(removedFrom({ selectors: { s: ['https://x.example/?mail=jane@example.com'] } })).toEqual(
      counts({ emails: 1 }),
    );
    // A token wins over the link with a query that holds it.
    expect(removedFrom({ selectors: { s: ['https://x.example/?k=mts_pat_abc'] } })).toEqual(
      counts({ tokens: 1 }),
    );
  });

  test.each([
    ['Open Graph', { openGraph: { 'og:title': 'jane@example.com' } }],
    ['the document title', { documentTitle: 'jane@example.com' }],
    ['the Media Session', { mediaSession: { title: 'jane@example.com' } }],
    [
      'the URL’s hash',
      { url: { hostname: 'a.example', pathname: '/x', query: {}, hash: '#jane@example.com' } },
    ],
    ['JSON-LD', { jsonLd: [{ '@type': 'Movie', name: 'jane@example.com' }] }],
    ['page state, deep', { pageState: { a: [{ b: { c: 'jane@example.com' } }] } }],
  ] as const)('in %s', (_name, over) => {
    expect(removedFrom(over as Partial<Snapshot>)).toEqual(counts({ emails: 1 }));
  });
});

describe('the URL’s path', () => {
  test('a segment that looks personal is counted by its kind, percent-decoded or not', () => {
    expect(
      removedFrom({
        url: {
          hostname: 'a.example',
          pathname: '/u/jane.doe%40example.com/s/mts_pat_abc/watch/1',
          query: {},
          hash: '',
        },
      }),
    ).toEqual(counts({ emails: 1, tokens: 1 }));
  });

  test('a path too long to read through is one overlong, and nothing else is counted in it', () => {
    expect(
      removedFrom({
        url: {
          hostname: 'a.example',
          pathname: `/${'a@b.co/'.repeat(500)}`,
          query: {},
          hash: '',
        },
      }),
    ).toEqual(counts({ overlong: 1 }));
  });

  test('a clean path counts nothing', () => {
    expect(removedFrom({})).toEqual(NONE);
  });
});

describe('the URL’s hash', () => {
  const withHash = (hash: string) =>
    sanitizeCapture(page({ url: { hostname: 'a.example', pathname: '/x', query: {}, hash } }));

  test.each([
    ['a token a sign-in handed the page', '#access_token=0f3a9c2b7d&token_type=bearer'],
    ['an account path', '#/account/12345'],
  ])('%s is emptied, as a named entry', (_name, hash) => {
    const { snapshot, removed } = withHash(hash);
    expect(snapshot.url.hash).toBe('');
    expect(removed).toEqual(counts({ named_entries: 1 }));
  });

  test('a hash a module reads is kept, and counts nothing', () => {
    const { snapshot, removed } = withHash('#season=5&episode=1');
    expect(snapshot.url.hash).toBe('#season=5&episode=1');
    expect(removed).toEqual(NONE);
  });
});

describe('depth', () => {
  test('a structure deeper than the walk is dropped, never counted', () => {
    let deep: unknown = 'jane@example.com';
    for (let i = 0; i < 100; i += 1) deep = { next: deep };
    const out = sanitizeCapture(page({ pageState: { deep } }));
    // The e-mail address is below the walk's reach: dropped with its branch, not counted.
    expect(out.removed.emails).toBe(0);
    expect(JSON.stringify(out.snapshot.pageState)).not.toContain('jane@example.com');
  });
});

describe('all of it at once', () => {
  test('a page with one of everything counts one of each kind', () => {
    const out = sanitizeCapture(
      page({
        url: { hostname: 'a.example', pathname: '/x', query: { a: '1' }, hash: '' },
        pageState: { profile: { name: 'x' }, ok: 1 },
        selectors: {
          mail: ['jane@example.com'],
          tok: [JWT],
          link: ['https://x.example/p?q=1'],
          long: ['z'.repeat(2500)],
        },
      }),
    );
    expect(out.removed).toEqual({
      query_values: 1,
      named_entries: 1,
      emails: 1,
      tokens: 1,
      links_with_query: 1,
      overlong: 1,
    });
    expect(out.snapshot.selectors).toEqual({ mail: [], tok: [], link: [], long: [] });
    expect(out.snapshot.pageState).toEqual({ ok: 1 });
  });
});
