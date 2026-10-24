/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The message protocol: a versioned discriminated union, validated with valibot on arrival. Each
// message round-trips; an extra field or v: 2 is rejected. The property-based half: arbitrary
// input parses to a message of the protocol or to `null`, never throws, and never carries a
// field the protocol does not name — messages from content scripts are hostile, so every reader
// is total.

import type { PlaybackSample, Snapshot } from '@mt/core';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { parseMessage, parseUiRequest } from './protocol';

/** A fixed seed, so CI runs the same cases. */
const RUNS = { seed: 20261022, numRuns: 400 } as const;

/** A sample's fields. */
const sample: PlaybackSample = {
  at: Date.UTC(2026, 9, 20, 19, 40),
  position: 1_500,
  duration: 2_880,
  paused: false,
  ended: false,
  rate: 1,
  adPlaying: false,
  muted: false,
  visibleArea: 0.8,
};

/** A snapshot's fields, for a Netflix episode. */
const snapshot: Snapshot = {
  url: { hostname: 'www.netflix.com', pathname: '/watch/70196253', query: {}, hash: '' },
  lang: 'en',
  documentTitle: 'Netflix',
  selectors: { title: ['Breaking Bad', 'S1:E2 “Cat’s in the Bag...”'] },
  jsonLd: [],
  mediaSession: { title: "Cat's in the Bag..." },
  openGraph: {},
  pageState: {},
  signals: { endOfContent: false, adPlaying: false },
};

/** The three content → worker messages, `v: 1` on every one. */
const CONTENT_MESSAGES = [
  { v: 1, type: 'bootstrap/play' },
  { v: 1, type: 'collector/report', isTop: true, sample, snapshot },
  { v: 1, type: 'collector/report', isTop: false, sample, snapshot: null },
  { v: 1, type: 'collector/report', isTop: true, sample: null, snapshot },
  { v: 1, type: 'collector/gone' },
] as const;

/**
 * The `ui` port's requests — skip, pause, track-site, what-was-sent, connect,
 * disconnect, settings, export, clear, capture. (`id` correlates an answer with its request.)
 */
const UI_REQUESTS = [
  { v: 1, id: 1, type: 'ui/skip', viewingId: 'viewing-1' },
  { v: 1, id: 2, type: 'ui/pause', until: Date.UTC(2026, 9, 20, 20, 40) },
  { v: 1, id: 3, type: 'ui/pause', until: null },
  { v: 1, id: 4, type: 'ui/track-site', origin: 'https://films.example' },
  { v: 1, id: 5, type: 'ui/what-was-sent', playId: 'play-1' },
  { v: 1, id: 6, type: 'ui/connect', strategy: 'pkce_dpop' },
  { v: 1, id: 7, type: 'ui/connect', strategy: 'personal_token', token: 'mts_pat_x' },
  { v: 1, id: 8, type: 'ui/disconnect', sendFirst: true },
  { v: 1, id: 9, type: 'ui/settings', patch: { trackIncognito: true } },
  { v: 1, id: 10, type: 'ui/export' },
  { v: 1, id: 11, type: 'ui/clear' },
  { v: 1, id: 12, type: 'ui/capture' },
  { v: 1, id: 13, type: 'ui/clear-history' },
] as const;

describe('content messages', () => {
  // Each message round-trips.
  test.each(CONTENT_MESSAGES.map((m) => [m.type, m] as const))(
    '%s round-trips',
    (_type, message) => {
      expect(parseMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
    },
  );

  // An extra field is rejected.
  test.each(CONTENT_MESSAGES.map((m) => [m.type, m] as const))(
    '%s with an extra field is rejected',
    (_type, message) => {
      expect(parseMessage({ ...message, site: 'www.netflix.com' })).toBeNull();
    },
  );

  // So is a message at v: 2 or with no version.
  test.each(CONTENT_MESSAGES.map((m) => [m.type, m] as const))(
    '%s at v: 2 is rejected',
    (_type, message) => {
      expect(parseMessage({ ...message, v: 2 })).toBeNull();
      const unversioned: Record<string, unknown> = { ...message };
      Reflect.deleteProperty(unversioned, 'v');
      expect(parseMessage(unversioned)).toBeNull();
    },
  );

  // The site comes from sender.url, never from the message: a report's own fields name nothing
  // beyond the protocol — an extra field inside the sample or snapshot is refused too.
  test('an extra field nested in the sample or the snapshot is rejected', () => {
    const report = CONTENT_MESSAGES[1];
    expect(parseMessage({ ...report, sample: { ...sample, tabId: 3 } })).toBeNull();
    const claimed = { ...snapshot, origin: 'evil.example' };
    expect(parseMessage({ ...report, snapshot: claimed })).toBeNull();
  });

  // A sample's duration is null unless finite and > 0.
  test('a sample with a non-finite position or rate is rejected', () => {
    const report = CONTENT_MESSAGES[1];
    expect(parseMessage({ ...report, sample: { ...sample, position: Number.NaN } })).toBeNull();
    const endless = { ...sample, duration: Number.POSITIVE_INFINITY };
    expect(parseMessage({ ...report, sample: endless })).toBeNull();
  });
});

describe('ui requests', () => {
  // Every `ui/*` request of the port parses.
  test.each(UI_REQUESTS.map((r) => [r.type, r] as const))('%s round-trips', (_type, request) => {
    expect(parseUiRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
  });

  // An extra field or v: 2 is rejected on the ui port too.
  test.each(UI_REQUESTS.map((r) => [r.type, r] as const))(
    '%s with an extra field or v: 2 is rejected',
    (_t, request) => {
      expect(parseUiRequest({ ...request, extra: true })).toBeNull();
      expect(parseUiRequest({ ...request, v: 2 })).toBeNull();
    },
  );

  // A strategy outside the three is not one.
  test('an unknown strategy is rejected', () => {
    expect(parseUiRequest({ v: 1, id: 1, type: 'ui/connect', strategy: 'oauth' })).toBeNull();
  });

  // Each strategy takes the token it can use and no other: the browser sign-in takes none; a
  // personal token is `mts_pat_` + 49 characters, 57 in all; the e2e session is RFC 9110 token68,
  // up to 4096.
  describe('ui/connect, one shape per strategy', () => {
    const connect = (extra: Record<string, unknown>) =>
      parseUiRequest({ v: 1, id: 1, type: 'ui/connect', ...extra });
    const PAT = `mts_pat_${'a'.repeat(49)}`;

    test('the browser sign-in takes no token', () => {
      expect(connect({ strategy: 'pkce_dpop' })).not.toBeNull();
      expect(connect({ strategy: 'pkce_dpop', token: PAT })).toBeNull();
    });

    test('a personal token is required, and bounded near its own length', () => {
      expect(connect({ strategy: 'personal_token', token: PAT })).not.toBeNull();
      // A paste's whitespace around it is the strategy's to trim.
      expect(connect({ strategy: 'personal_token', token: `  ${PAT}\n` })).not.toBeNull();
      expect(connect({ strategy: 'personal_token', token: 'x'.repeat(128) })).not.toBeNull();
      expect(connect({ strategy: 'personal_token', token: 'x'.repeat(129) })).toBeNull();
      expect(connect({ strategy: 'personal_token' })).toBeNull();
    });

    test('the e2e session is optional, and bounded by token68’s 4096', () => {
      expect(connect({ strategy: 'test' })).not.toBeNull();
      expect(connect({ strategy: 'test', token: 'a'.repeat(4096) })).not.toBeNull();
      expect(connect({ strategy: 'test', token: 'a'.repeat(4097) })).toBeNull();
    });

    test('a token that is not a string is refused', () => {
      expect(connect({ strategy: 'personal_token', token: 57 })).toBeNull();
      expect(connect({ strategy: 'test', token: null })).toBeNull();
    });
  });

  test('a settings patch naming an unknown field is rejected', () => {
    const request = { v: 1, id: 1, type: 'ui/settings', patch: { countAt: 0.7 } };
    expect(parseUiRequest(request)).toBeNull();
  });

  // The history is kept for one of the lengths the page offers, and no other.
  test('a settings patch keeps the history 1, 7 or 30 days only', () => {
    const patch = (historyDays: unknown) =>
      parseUiRequest({ v: 1, id: 1, type: 'ui/settings', patch: { historyDays } });
    for (const days of [1, 7, 30]) expect(patch(days)).not.toBeNull();
    for (const other of [0, 2, 365, '7', null]) expect(patch(other)).toBeNull();
  });
});

/** Every field name of a parsed content message, at its top level and in sample/snapshot/url. */
const FIELDS = {
  'bootstrap/play': ['v', 'type'],
  'collector/gone': ['v', 'type'],
  'collector/report': ['v', 'type', 'isTop', 'sample', 'snapshot'],
} as const;

/** Every name the protocol gives a content message's fields, at any level. */
const NAMED: readonly string[] = [
  ...FIELDS['collector/report'],
  ...Object.keys(sample),
  ...Object.keys(snapshot),
];

const SCALARS = [1, 2, 0, -1, true, false, null] as const;
const TYPES = ['bootstrap/play', 'collector/report', 'collector/gone'] as const;
const KEYS = [...FIELDS['collector/report'], 'extra', '__proto__', 'constructor'] as const;

/** JSON-like values with the protocol's own keys over-represented, so some inputs are close. */
const nearMessage = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.constantFrom(...SCALARS, ...TYPES),
    fc.string({ maxLength: 12 }),
    fc.double(),
    fc.array(tie('value'), { maxLength: 4 }),
    tie('object'),
  ),
  object: fc.dictionary(fc.constantFrom(...KEYS), tie('value'), { maxKeys: 6 }),
}));

type Level = 'top' | 'sample' | 'snapshot' | 'url' | 'signals';

/** The object at `level` of a message copy, or `null` where the message has none. */
function levelOf(copy: Record<string, unknown>, level: Level): Record<string, unknown> | null {
  const asRecord = (x: unknown): Record<string, unknown> | null =>
    typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : null;
  const shot = asRecord(copy.snapshot);
  switch (level) {
    case 'top':
      return copy;
    case 'sample':
      return asRecord(copy.sample);
    case 'snapshot':
      return shot;
    case 'url':
      return asRecord(shot?.url);
    case 'signals':
      return asRecord(shot?.signals);
  }
}

describe('parseMessage on arbitrary input (property-based)', () => {
  // Arbitrary JSON parses to a valid message or `null`, never throws.
  test('arbitrary JSON values never throw and are either null or a message of the protocol', () => {
    fc.assert(
      fc.property(fc.oneof(fc.jsonValue(), nearMessage.value), (raw) => {
        const parsed = parseMessage(raw);
        if (parsed === null) return;
        const allowed: readonly string[] = FIELDS[parsed.type];
        expect(Object.keys(parsed).sort()).toEqual([...allowed].sort());
        expect(parsed.v).toBe(1);
      }),
      RUNS,
    );
  });

  // An extra field is never accepted, anywhere in a valid report.
  test('a valid message with any extra field, at any level, is null', () => {
    const extraKey = fc.string({ minLength: 1, maxLength: 16 }).filter((k) => !NAMED.includes(k));
    const levels = fc.constantFrom<Level>('top', 'sample', 'snapshot', 'url', 'signals');
    fc.assert(
      fc.property(
        fc.constantFrom(...CONTENT_MESSAGES),
        levels,
        extraKey,
        fc.jsonValue(),
        (message, where, key, value) => {
          const copy = JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
          const target = levelOf(copy, where);
          fc.pre(target !== null);
          const field = { value, enumerable: true, configurable: true, writable: true };
          Object.defineProperty(target, key, field);
          expect(parseMessage(copy)).toBeNull();
        },
      ),
      RUNS,
    );
  });

  // A message that parses comes back as it was sent — no field added, none dropped (the worker
  // reads exactly what the protocol names).
  test('a valid report survives parsing unchanged', () => {
    const finite = (min: number, max: number) =>
      fc.double({ min, max, noNaN: true, noDefaultInfinity: true });
    const anySample = fc.record({
      at: finite(0, 8.64e15),
      position: finite(0, 8_640_000),
      duration: fc.option(finite(0.001, 8_640_000), { nil: null }),
      paused: fc.boolean(),
      ended: fc.boolean(),
      rate: finite(0, 16),
      adPlaying: fc.boolean(),
      muted: fc.boolean(),
      visibleArea: finite(0, 1),
    });
    fc.assert(
      fc.property(fc.boolean(), fc.option(anySample, { nil: null }), (isTop, s) => {
        const message = { v: 1, type: 'collector/report', isTop, sample: s, snapshot };
        expect(parseMessage(message)).toEqual(message);
      }),
      RUNS,
    );
  });
});
