/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The capture tool's sanitiser and the diagnostics log's scrubber. A captured sample drops what
// looks like an account, profile, e-mail, token or URL query; the diagnostics log is
// credential-scrubbed and keeps 7 days and 500 entries.

import 'fake-indexeddb/auto';

import { sanitizeSnapshot } from '@mt/core';
import type { Snapshot } from '@mt/core';
import { FakeClock } from '@mt/core/testing';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { IdbDiagnostics, scrubText } from '../src/platform/diagnostics';
import { openDatabase } from '../src/platform/idb';

const JWT = 'eyJhbGciOiJFUzI1NiIsInR5cCI6ImRwb3Arand0In0.eyJqdGkiOiIxIn0.c2lnbmF0dXJl';

describe('sanitizeSnapshot', () => {
  /** The fixture: an e-mail in a selector value, a JWT in page state, a
   *  `profileName` key and `url.query.token`; the rest is what a module reads. */
  const fixture: Snapshot = {
    url: {
      hostname: 'www.netflix.com',
      pathname: '/watch/70196253',
      query: { token: 'abc123', trackId: '14277281' },
      hash: '',
    },
    lang: 'en',
    documentTitle: 'Netflix',
    selectors: {
      titleHeading: ['Breaking Bad'],
      titleParts: ['S1:E2', "Cat's in the Bag...", 'walter@example.com'],
    },
    jsonLd: [],
    mediaSession: { title: "Cat's in the Bag...", artist: 'Breaking Bad' },
    openGraph: { 'og:type': 'video.episode' },
    pageState: {
      video: { id: 70196253, title: 'Breaking Bad', type: 'show', proof: JWT },
      account: { profileName: 'Walter', avatar: 'blue' },
      playback: { profileName: 'Walter', position: 1500 },
    },
    signals: { endOfContent: false, adPlaying: false },
  };

  test('removes or redacts the e-mail, the JWT, the profile name and the query token, and keeps the rest', () => {
    const clean = sanitizeSnapshot(fixture);
    // An e-mail is dropped from a selector value.
    expect(clean.selectors).toEqual({
      titleHeading: ['Breaking Bad'],
      titleParts: ['S1:E2', "Cat's in the Bag..."],
    });
    // url.query values become "<redacted>"; their names stay.
    expect(clean.url).toEqual({
      hostname: 'www.netflix.com',
      pathname: '/watch/70196253',
      query: { token: '<redacted>', trackId: '<redacted>' },
      hash: '',
    });
    const state = JSON.stringify(clean.pageState);
    expect(state).not.toContain(JWT);
    expect(state).not.toContain('profileName');
    expect(state).not.toContain('Walter');
    // A key named profile, account, … (case-insensitive) is dropped at any depth in pageState.
    expect(clean.pageState).not.toHaveProperty('account');
    // Everything else is intact.
    expect(clean.pageState.video).toEqual({ id: 70196253, title: 'Breaking Bad', type: 'show' });
    expect(clean.pageState.playback).toEqual({ position: 1500 });
    expect(clean.mediaSession).toEqual(fixture.mediaSession);
    expect(clean.openGraph).toEqual(fixture.openGraph);
    expect(clean.documentTitle).toBe('Netflix');
    expect(clean.lang).toBe('en');
    expect(clean.signals).toEqual(fixture.signals);
  });

  // An `mts_`/`mt_rt_` token and a URL with a query are dropped wherever they are.
  test.each([
    ['a personal token', `mts_pat_${'A'.repeat(43)}abcdef`],
    ['an extension credential', `mts_ext_${'b'.repeat(49)}`],
    ['a refresh-style token', 'mt_rt_0123456789abcdef'],
    ['a URL with a query', 'https://www.netflix.com/browse?jbv=80057281&profile=me'],
    ['a JWT', JWT],
    ['an e-mail', 'someone@example.org'],
  ])('%s in a selector value or the page state is dropped', (_what, value) => {
    const clean = sanitizeSnapshot({
      ...fixture,
      selectors: { titleParts: ['Breaking Bad', value] },
      pageState: { video: { title: 'Breaking Bad', note: value } },
    });
    expect(JSON.stringify(clean)).not.toContain(value);
    expect(clean.selectors.titleParts).toEqual(['Breaking Bad']);
  });

  // The keys that look like an account, profile, e-mail or token, case-insensitive.
  test.each(['profile', 'Account', 'EMAIL', 'userId', 'sessionToken', 'Token'])(
    'a key named %s is dropped at any depth of the page state',
    (key) => {
      const clean = sanitizeSnapshot({
        ...fixture,
        pageState: { video: { title: 'Breaking Bad', nested: { deeper: { [key]: 'x', ok: 1 } } } },
      });
      expect(JSON.stringify(clean.pageState)).not.toContain(`"${key}"`);
      expect(clean.pageState.video).toEqual({
        title: 'Breaking Bad',
        nested: { deeper: { ok: 1 } },
      });
    },
  );
});

describe('the diagnostics scrubber', () => {
  // The scrubber removes mts_ext_ + 49 characters.
  test('an extension credential is removed', () => {
    const token = `mts_ext_${'Z9_'.repeat(16)}x`;
    expect(token).toHaveLength(8 + 49);
    const out = scrubText(`send failed for ${token} now`);
    expect(out).not.toContain(token);
    expect(out).not.toContain('Z9_Z9_');
  });

  // … and an Authorization: DPoP … string.
  test('an Authorization: DPoP value is removed', () => {
    const value = `mts_ext_${'q'.repeat(49)}`;
    const out = scrubText(`Authorization: DPoP ${value}`);
    expect(out).not.toContain(value);
    expect(out).not.toContain('q'.repeat(10));
  });

  // Whatever the credential looks like.
  test('an Authorization: DPoP value of any shape is removed', () => {
    const out = scrubText('Authorization: DPoP opaque-credential-0123456789');
    expect(out).not.toContain('opaque-credential-0123456789');
  });

  // It removes mts_… tokens, DPoP …/Bearer … headers and JWTs.
  test.each([
    ['a Bearer header', `Authorization: Bearer mts_pat_${'k'.repeat(49)}`, 'k'.repeat(10)],
    ['a DPoP proof (a JWT)', `DPoP: ${JWT}`, JWT.slice(0, 30)],
    ['a bare JWT', JWT, JWT.slice(0, 30)],
  ])('%s is removed', (_what, input, secret) => {
    expect(scrubText(input)).not.toContain(secret);
  });
});

describe('IdbDiagnostics retention (7 days, 500 entries)', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
  });

  test('the log keeps at most 500 entries, the newest', async () => {
    const db = await openDatabase();
    const clock = new FakeClock(Date.UTC(2026, 9, 20));
    const log = new IdbDiagnostics(
      () => Promise.resolve(db),
      clock,
      () => Promise.resolve(true),
    );
    for (let i = 0; i < 510; i += 1) {
      clock.advance(1000);
      await log.log('step.failed', { n: i });
    }
    const entries = await log.list();
    expect(entries).toHaveLength(500);
    expect(entries.map((e) => e.detail.n)).not.toContain(9);
    expect(entries.map((e) => e.detail.n)).toContain(10);
    expect(entries.map((e) => e.detail.n)).toContain(509);
    db.close();
  });

  // Diagnostics are off by default, and off, nothing is written.
  test('off, it writes nothing', async () => {
    const db = await openDatabase();
    const log = new IdbDiagnostics(
      () => Promise.resolve(db),
      new FakeClock(0),
      () => Promise.resolve(false),
    );
    await log.log('step.failed', { n: 1 });
    expect(await log.list()).toEqual([]);
    db.close();
  });

  // The log is credential-scrubbed: a careless caller cannot write a secret.
  test('what is written is scrubbed', async () => {
    const db = await openDatabase();
    const log = new IdbDiagnostics(
      () => Promise.resolve(db),
      new FakeClock(0),
      () => Promise.resolve(true),
    );
    const token = `mts_ext_${'s'.repeat(49)}`;
    await log.log('send.failed', { header: `Authorization: DPoP ${token}`, error: token });
    expect(JSON.stringify(await log.list())).not.toContain('s'.repeat(10));
    db.close();
  });
});
