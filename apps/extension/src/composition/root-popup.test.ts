/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The composition root, as the pages reach it: every `ui` request and its answer, the export and
// the page sample (what they never carry), the popup's site line, why a video that plays is not
// tracked, the diagnostics of it, and *Recently*. Through the harness (test-harness.ts).

import { PAUSE_INDEFINITELY } from '@mt/core';
import type { HistoryEntry, PlayBody, ServiceReading, SettingsValue, Snapshot } from '@mt/core';
import { FakeAuthStrategy, FakeClock, FakeScheduler } from '@mt/core/testing';
import { describe, expect, test } from 'vitest';

import type { PopupState } from '../messaging/protocol';
import { IdbConnectionRepo } from '../platform/connection-store';
import { IdbDiagnostics } from '../platform/diagnostics';
import { IdbPlayHistory } from '../platform/history-store';
import { openDatabase } from '../platform/idb';
import { IdbOutbox } from '../platform/outbox-store';
import { IdbViewingStore } from '../platform/viewing-store';
import { WEB_ROUTES } from '../web-routes';
import {
  COURSES,
  COURSES_SETTINGS,
  DAY,
  NETFLIX_WATCH,
  PRIME_FILM,
  T0,
  WHOLE_FILM,
  askUi,
  drainMicrotasks,
  everyFifteen,
  filmSnapshot,
  harness,
  lectureSnapshot,
  loggedAs,
  playFilm,
  report,
  sampleAt,
  sender,
  settle,
  snapshotOf,
  tabFacts,
  useRootTestEnvironment,
} from './test-harness';
import type { Facts, Harness } from './test-harness';

useRootTestEnvironment();

describe('the ui requests', () => {
  interface Answer {
    readonly v: number;
    readonly type: string;
    readonly id: number;
    readonly response: { readonly ok: boolean; readonly error?: unknown; readonly data?: unknown };
  }

  /** The answer shape: `{ ok: true; data? } | { ok: false; error: string }`, as a `ui/response`. */
  function expectAnswer(answer: unknown, id: number): Answer {
    const a = answer as Answer;
    expect(a.v).toBe(1);
    expect(a.type).toBe('ui/response');
    expect(a.id).toBe(id);
    expect(typeof a.response.ok).toBe('boolean');
    if (!a.response.ok) expect(typeof a.response.error).toBe('string');
    return a;
  }

  /** Sends one request (`v: 1`, id 1) and checks the answer is the protocol's. */
  async function ask(h: Harness, request: Record<string, unknown>): Promise<Answer> {
    return expectAnswer(await h.root.onUiRequest({ v: 1, id: 1, ...request }), 1);
  }

  test.each([
    { v: 1, id: 1, type: 'ui/skip', viewingId: 'nope' },
    { v: 1, id: 2, type: 'ui/pause', until: T0 + 3_600_000 },
    { v: 1, id: 3, type: 'ui/pause', until: null },
    { v: 1, id: 4, type: 'ui/track-site', origin: 'https://films.example' },
    { v: 1, id: 5, type: 'ui/what-was-sent', playId: 'nope' },
    { v: 1, id: 6, type: 'ui/connect', strategy: 'pkce_dpop' },
    { v: 1, id: 7, type: 'ui/disconnect', sendFirst: true },
    { v: 1, id: 8, type: 'ui/settings', patch: {} },
    { v: 1, id: 9, type: 'ui/export' },
    { v: 1, id: 10, type: 'ui/clear' },
    { v: 1, id: 11, type: 'ui/capture' },
    { v: 1, id: 12, type: 'ui/clear-history' },
  ])('$type answers a ui/response for its id', async (request) => {
    const h = harness({ strategies: [new FakeAuthStrategy('pkce_dpop', { kind: 'cancelled' })] });
    expectAnswer(await h.root.onUiRequest(request), request.id);
  });

  // Skip means "don't add this viewing".
  test('ui/skip: a skipped viewing is never added, even when finished', async () => {
    const h = harness();
    const frame = { tabId: 1, frameId: 0, url: PRIME_FILM };
    await playFilm(h, frame, WHOLE_FILM.slice(0, 4));
    const [viewing] = h.viewings.all();
    if (viewing === undefined) throw new Error('no viewing');
    const answer = await ask(h, { type: 'ui/skip', viewingId: viewing.id });
    expect(answer.response.ok).toBe(true);
    await playFilm(h, frame, WHOLE_FILM.slice(4), undefined, 60);
    expect(h.viewings.all()[0]?.state).toBe('skipped');
    expect(h.outbox.entries()).toEqual([]);
    expect(h.gateway.sends).toEqual([]);
  });

  // Pause tracking: a viewing is only reported while tracking is not paused.
  test('ui/pause sets the pause, and null resumes', async () => {
    const h = harness();
    const until = T0 + 3_600_000;
    expect((await ask(h, { type: 'ui/pause', until })).response.ok).toBe(true);
    expect((await h.settings.get()).pausedUntil).toBe(until);
    await ask(h, { type: 'ui/pause', until: null });
    expect((await h.settings.get()).pausedUntil).toBeNull();
  });

  // "What was sent": the exact JSON body, the time, and the server's answer
  test('ui/what-was-sent gives the exact body of a sent play; an unknown play is not found', async () => {
    const h = harness();
    const body: PlayBody = {
      kind: 'movie',
      title: 'Arrival',
      year: 2016,
      watched_at: '2026-10-20T21:40:00+02:00',
      duration_seconds: 6_960,
      furthest_position_seconds: 6_500,
      ended: true,
    };
    const entry: HistoryEntry = {
      playId: 'play-1',
      scrobbleId: 's-1',
      body,
      sentAt: T0,
      receipt: { state: 'recorded', reason: null, titleId: 't-1' },
      receiptReadAt: T0 + 10_000,
      receiptGoneAt: null,
      label: 'Arrival',
    };
    await h.history.put(entry);
    const found = await ask(h, { type: 'ui/what-was-sent', playId: 'play-1' });
    expect(found.response.ok).toBe(true);
    const data = found.response.data as { body?: unknown; sentAt?: unknown };
    expect(data.body).toEqual(body);
    expect(data.sentAt).toBe(T0);
    const missing = await ask(h, { type: 'ui/what-was-sent', playId: 'nope' });
    expect(missing.response.ok).toBe(false);
  });

  // One sign-in flow at a time, through the chosen strategy.
  test('ui/connect asks the named strategy once', async () => {
    const strategy = new FakeAuthStrategy('pkce_dpop', { kind: 'cancelled' });
    const h = harness({ strategies: [strategy] });
    await ask(h, { type: 'ui/connect', strategy: 'pkce_dpop' });
    expect(strategy.inputs).toHaveLength(1);
  });

  // Disconnect deletes the credential and the key.
  test('ui/disconnect forgets the connection', async () => {
    const h = harness();
    expect((await ask(h, { type: 'ui/disconnect', sendFirst: false })).response.ok).toBe(true);
    expect(h.connection.forgets).toBe(1);
    expect(await h.connection.get()).toEqual({ kind: 'none' });
  });

  // Privacy settings, such as tracking in incognito windows.
  test('ui/settings changes what it names and answers the settings', async () => {
    const h = harness();
    const answer = await ask(h, { type: 'ui/settings', patch: { trackIncognito: true } });
    expect(answer.response.ok).toBe(true);
    expect((await h.settings.get()).trackIncognito).toBe(true);
  });

  // A shorter history takes effect at once, not at the next retention pass hours later.
  test('ui/settings keeping the history a day removes what is older now', async () => {
    const h = harness({ settings: { historyDays: 30 } });
    const sentAt = (playId: string, at: number): HistoryEntry => ({
      playId,
      scrobbleId: `s-${playId}`,
      body: {
        kind: 'movie',
        title: 'Arrival',
        year: 2016,
        watched_at: '2026-10-20T21:40:00+02:00',
      },
      sentAt: at,
      receipt: { state: 'recorded', reason: null, titleId: 't-1' },
      receiptReadAt: at + 10_000,
      receiptGoneAt: null,
      label: 'Arrival',
    });
    await h.history.put(sentAt('two-days', T0 - 2 * DAY));
    await h.history.put(sentAt('an-hour', T0 - DAY / 24));
    const answer = await ask(h, { type: 'ui/settings', patch: { historyDays: 1 } });
    expect(answer.response.ok).toBe(true);
    expect((await h.settings.get()).historyDays).toBe(1);
    expect((await h.history.recent(10)).map((entry) => entry.playId)).toEqual(['an-hour']);
  });

  // The switch's prompt is the page's; turning it off is the worker's, and gives Chrome's
  // access to every site back rather than only forgetting it in the settings.
  test('ui/settings turning all sites off gives that access back, then reconciles', async () => {
    const h = harness({ settings: { allSites: true } });
    const answer = await ask(h, { type: 'ui/settings', patch: { allSites: false } });
    expect(answer.response.ok).toBe(true);
    expect(h.permissions.forgetAllSites).toHaveBeenCalledTimes(1);
    expect(h.permissions.reconcile).toHaveBeenCalled();
  });

  // A site is added only from a click, and the worker only checks what was granted.
  test('ui/track-site refuses an origin Chrome has not granted', async () => {
    const h = harness();
    const answer = await ask(h, { type: 'ui/track-site', origin: 'https://films.example' });
    expect(answer.response.ok).toBe(false);
  });

  // Track this site on an excluded host removes the exclusion, and the bootstrap follows the
  // grant (reconcile).
  test('ui/track-site with the grant removes an exclusion and reconciles', async () => {
    const h = harness({
      granted: ['https://films.example'],
      settings: { excludedHosts: ['films.example'] },
    });
    const answer = await ask(h, { type: 'ui/track-site', origin: 'https://films.example' });
    expect(answer.response.ok).toBe(true);
    expect((await h.settings.get()).excludedHosts).toEqual([]);
    expect(h.permissions.reconcile).toHaveBeenCalled();
  });

  // An origin granted before fires no grant, so no grant brings the bootstrap to the tab it was
  // pressed in: Track this site does, to the site's own frames only. A video already playing
  // there then asks at once (bootstrap.test.ts), with no reload.
  test('ui/track-site brings the bootstrap to the site’s open tabs, an exclusion just lifted', async () => {
    const h = harness({
      granted: ['https://films.example'],
      settings: { excludedHosts: ['films.example'], allowedHosts: ['films.example'] },
      openTabs: [
        {
          tabId: 7,
          url: 'https://films.example/arrival',
          frames: [
            { frameId: 0, documentId: 'top', origin: 'https://films.example' },
            { frameId: 4, documentId: 'ad', origin: 'https://ads.example' },
          ],
        },
        { tabId: 8, url: 'https://news.example/', frames: [] },
      ],
    });
    expect(
      (await ask(h, { type: 'ui/track-site', origin: 'https://films.example' })).response.ok,
    ).toBe(true);
    // The page is answered first; the tabs get their bootstrap after.
    await drainMicrotasks();
    expect(h.bootstrap.openTabs).toHaveBeenCalledWith(['https://films.example/*']);
    expect(h.bootstrap.inject.mock.calls).toEqual([[{ tabId: 7, frameId: 0, documentId: 'top' }]]);
  });

  // A site open in many tabs does not hold the page's button busy.
  test('ui/track-site answers before the open tabs have their bootstrap', async () => {
    const h = harness({
      granted: ['https://films.example'],
      settings: { allowedHosts: ['films.example'] },
      openTabs: [
        {
          tabId: 7,
          url: 'https://films.example/arrival',
          frames: [{ frameId: 0, documentId: 'top', origin: 'https://films.example' }],
        },
      ],
    });
    h.bootstrap.inject.mockImplementation(() => new Promise<boolean>(() => undefined));
    expect(
      (await ask(h, { type: 'ui/track-site', origin: 'https://films.example' })).response.ok,
    ).toBe(true);
  });

  // Clear all local data (ui/clear, confirmed first) also forgets the connection.
  test('ui/clear wipes the stores, resets the settings and forgets the connection', async () => {
    const h = harness({ settings: { trackIncognito: true } });
    expect((await ask(h, { type: 'ui/clear' })).response.ok).toBe(true);
    expect(h.wipe).toHaveBeenCalledTimes(1);
    expect(h.connection.forgets).toBeGreaterThanOrEqual(1);
    expect((await h.settings.get()).trackIncognito).toBe(false);
  });

  // Clear history (confirmed first): the plays already sent and their answers go, those still
  // waiting for an answer too; the diary in MediaTracker keeps them, and nothing else goes.
  test('ui/clear-history empties the history and keeps the viewings, the settings and the connection', async () => {
    const h = harness({ settings: { trackIncognito: true } });
    await playFilm(h, { tabId: 1, frameId: 0, url: PRIME_FILM }, WHOLE_FILM.slice(0, 4));
    const sent = (playId: string, receipt: HistoryEntry['receipt']): HistoryEntry => ({
      playId,
      scrobbleId: `s-${playId}`,
      body: {
        kind: 'movie',
        title: 'Arrival',
        year: 2016,
        watched_at: '2026-10-20T21:40:00+02:00',
      },
      sentAt: T0,
      receipt,
      receiptReadAt: receipt === null ? null : T0 + 10_000,
      receiptGoneAt: null,
      label: 'Arrival',
    });
    await h.history.put(sent('answered', { state: 'recorded', reason: null, titleId: 't-1' }));
    await h.history.put(sent('waiting', null));
    const viewings = h.viewings.all();
    const outbox = h.outbox.entries();
    const forgets = h.connection.forgets;
    expect(viewings).not.toEqual([]);

    expect((await ask(h, { type: 'ui/clear-history' })).response.ok).toBe(true);

    expect(await h.history.recent(10)).toEqual([]);
    expect(await h.history.unsettled()).toEqual([]);
    expect(h.viewings.all()).toEqual(viewings);
    expect(h.outbox.entries()).toEqual(outbox);
    expect(h.connection.forgets).toBe(forgets);
    expect((await h.settings.get()).trackIncognito).toBe(true);
    expect(h.wipe).not.toHaveBeenCalled();
  });

  // The export holds the settings, open viewings, history and outbox.
  test('ui/export carries the settings, the open viewings, the history and the outbox', async () => {
    const h = harness();
    await playFilm(h, { tabId: 1, frameId: 0, url: PRIME_FILM }, WHOLE_FILM.slice(0, 4));
    const answer = await ask(h, { type: 'ui/export' });
    const data = answer.response.data as Record<string, unknown>;
    expect(data).toHaveProperty('settings');
    expect(data).toHaveProperty('history');
    expect(data).toHaveProperty('outbox');
    expect(JSON.stringify(data)).toContain('Arrival');
  });
});

describe('ui/export never carries the credential', () => {
  // The export never contains accessToken or keyPair.
  test('with a stored token and key pair, the export names neither', async () => {
    const db = await openDatabase();
    const handle = () => Promise.resolve(db);
    const token = `mts_ext_${'a'.repeat(49)}`;
    const algorithm = { name: 'ECDSA', namedCurve: 'P-256' };
    const pair = await crypto.subtle.generateKey(algorithm, false, ['sign', 'verify']);
    const connection = new IdbConnectionRepo(handle);
    const state = {
      kind: 'connected',
      id: 'conn-1',
      strategy: 'pkce_dpop',
      connectedAt: T0,
      expiresAt: T0 + 1,
    } as const;
    await connection.saveCredential(state, token, pair);
    const h = harness({
      overrides: {
        connection,
        viewings: new IdbViewingStore(handle),
        outbox: new IdbOutbox(handle),
        history: new IdbPlayHistory(handle),
      },
    });
    const answer = (await h.root.onUiRequest({ v: 1, id: 1, type: 'ui/export' })) as {
      response: { ok: boolean; data?: unknown };
    };
    expect(answer.response.ok).toBe(true);
    const text = JSON.stringify(answer.response.data);
    expect(text).not.toContain('accessToken');
    expect(text).not.toContain('keyPair');
    expect(text).not.toContain('privateKey');
    expect(text).not.toContain(token);
    db.close();
  });
});

describe('ui/capture is sanitised', () => {
  // The capture drops any value that looks like an account, profile, e-mail, token or URL query
  test('the captured snapshot carries no e-mail, JWT or profile name', async () => {
    const jwt = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
    const h = harness({
      interpret: () => null,
      pageState: { video: { title: 'Arrival', profileName: 'Alice', proof: jwt } },
    });
    const snapshot = snapshotOf(NETFLIX_WATCH, {
      documentTitle: 'Netflix',
      selectors: { titleHeading: ['Arrival'], titleParts: ['alice@example.com', 'S1:E2'] },
      mediaSession: { title: 'Arrival', artist: 'alice@example.com' },
    });
    h.clock.set(T0);
    await report(h, { tabId: 1, frameId: 0, url: NETFLIX_WATCH }, sampleAt(h.clock, 0), snapshot);
    await settle();
    const answer = (await h.root.onUiRequest({ v: 1, id: 1, type: 'ui/capture', tabId: 1 })) as {
      response: { ok: boolean; data?: { filename?: string; fixture?: { snapshot?: Snapshot } } };
    };
    expect(answer.response.ok).toBe(true);
    const text = JSON.stringify(answer.response.data?.fixture);
    expect(text).not.toContain('alice@example.com');
    expect(text).not.toContain(jwt);
    expect(text).not.toContain('profileName');
    expect(text).not.toContain('Alice');
    expect(text).toContain('Arrival');
    // The download is named <service>-<date>.snapshot.json.
    expect(answer.response.data?.filename).toBe('netflix-2026-10-20.snapshot.json');
    // The file says what was removed, by kind, and which parts a reader took from.
    const data = answer.response.data as { fixture?: { removed?: unknown }; used?: unknown };
    expect(data.fixture?.removed).toMatchObject({ emails: 2, query_values: 0 });
    expect(data.used).toEqual(['media_session']);
  });
});

describe('ui/capture says which parts of the sample a reader took something from', () => {
  interface Captured {
    readonly used: readonly string[];
    readonly fixture: { readonly removed: Readonly<Record<string, number>> };
  }
  async function captured(h: Harness): Promise<Captured> {
    const answer = await askUi(h, { type: 'ui/capture', tabId: 1 });
    expect(answer.ok).toBe(true);
    return (answer as { data: Captured }).data;
  }

  test('a module that answered marks the address and every part its definition declares', async () => {
    // Netflix declares selectors, page state, the Media Session and a signal; no JSON-LD and
    // no Open Graph tags.
    const reading = (_id: string, s: Snapshot): ServiceReading | null =>
      s.url.pathname.startsWith('/watch/')
        ? {
            kind: { value: 'movie', confidence: 0.95, source: 'module' },
            title: { value: 'Arrival', confidence: 0.95, source: 'module' },
            providerIds: [{ level: 'title', key: 'videoId', value: '70196253' }],
          }
        : null;
    const h = harness({ interpret: reading });
    h.clock.set(T0);
    await report(
      h,
      { tabId: 1, frameId: 0, url: NETFLIX_WATCH },
      sampleAt(h.clock, 0),
      snapshotOf(NETFLIX_WATCH),
    );
    await settle();
    const { used } = await captured(h);
    expect(new Set(used)).toEqual(new Set(['address', 'page_data', 'media_session', 'signals']));
  });

  test('a module that answered nothing marks nothing it did not read', async () => {
    const h = harness({ interpret: () => null });
    h.clock.set(T0);
    await report(
      h,
      { tabId: 1, frameId: 0, url: NETFLIX_WATCH },
      sampleAt(h.clock, 0),
      snapshotOf(NETFLIX_WATCH),
    );
    await settle();
    expect((await captured(h)).used).toEqual([]);
  });

  test('a page read generically marks the part its facts came from', async () => {
    const h = harness();
    await playFilm(h, { tabId: 1, frameId: 0, url: PRIME_FILM }, [0, 15]);
    const { used } = await captured(h);
    expect(used).toContain('structured_data');
    expect(used).not.toContain('address');
    expect(used).not.toContain('open_graph');
    expect(used).not.toContain('media_session');
    expect(used).not.toContain('page_data');
  });

  test('a series page whose address names the episode marks the address and Open Graph', async () => {
    const url = 'https://series.example/watch/221#t:221-s:5-e:1';
    const h = harness({ settings: { allowedHosts: ['series.example'] } });
    const snapshot = snapshotOf(url, {
      openGraph: { 'og:type': 'video.tv_series', 'og:title': 'Some Show (2020)' },
    });
    await playFilm(h, { tabId: 1, frameId: 0, url }, [0, 15], snapshot);
    const { used } = await captured(h);
    expect(used).toContain('address');
    expect(used).toContain('open_graph');
  });

  test('without a tab, the tab that reported last with a snapshot, past one that holds none', async () => {
    const h = harness({ settings: { disabledServices: ['netflix'] } });
    await playFilm(h, { tabId: 1, frameId: 0, url: PRIME_FILM }, [0, 15]);
    // Later, a turned-off service's tab: its bootstrap is refused, and it holds no snapshot.
    h.clock.advance(60_000);
    const off = { tabId: 2, frameId: 0, url: NETFLIX_WATCH };
    await h.root.onContentMessage({ v: 1, type: 'bootstrap/play' }, sender(off));
    const answer = await askUi(h, { type: 'ui/capture' });
    expect(answer.ok).toBe(true);
    const data = (answer as { data: { filename: string } }).data;
    expect(data.filename).toBe('prime_video-2026-10-20.snapshot.json');
  });

  test('the file carries what was removed, by kind, beside the sample', async () => {
    const h = harness();
    const snapshot = filmSnapshot(PRIME_FILM);
    await playFilm(h, { tabId: 1, frameId: 0, url: PRIME_FILM }, [0, 15], {
      ...snapshot,
      documentTitle: 'Arrival — write to a@b.example',
      mediaSession: { title: 'Arrival', artist: 'c@d.example' },
    });
    const { fixture } = await captured(h);
    expect(fixture.removed.emails).toBe(2);
    expect(JSON.stringify(fixture)).not.toContain('@b.example');
    expect(JSON.stringify(fixture)).not.toContain('@d.example');
  });
});

describe('diagnostics retention through the expire alarm', () => {
  // Diagnostics are kept 7 days.
  test('entries older than 7 days go, younger ones stay', async () => {
    const db = await openDatabase();
    const handle = () => Promise.resolve(db);
    const clock = new FakeClock(T0);
    const diagnostics = new IdbDiagnostics(handle, clock, () => Promise.resolve(true));
    clock.set(T0 - 8 * DAY);
    await diagnostics.log('old.event', {});
    clock.set(T0 - 6 * DAY);
    await diagnostics.log('kept.event', {});
    clock.set(T0);
    const h = harness({
      overrides: {
        clock,
        diagnostics,
        viewings: new IdbViewingStore(handle),
        outbox: new IdbOutbox(handle),
        history: new IdbPlayHistory(handle),
        scheduler: new FakeScheduler(clock),
      },
    });
    await h.root.onAlarm('expire');
    const events = (await diagnostics.list()).map((e) => e.event);
    expect(events).not.toContain('old.event');
    expect(events).toContain('kept.event');
    db.close();
  });
});

describe('the popup states the site of its tab', () => {
  const siteFor = async (h: Harness) => (await h.root.uiState(1)).site;

  test.each<[string, string, Partial<SettingsValue>, PopupState['site']]>([
    [
      'a site nobody allowed: Track this site, for that origin alone',
      'https://films.example/arrival',
      {},
      {
        origin: 'https://films.example',
        name: 'films.example',
        tracking: 'trackable',
        pattern: 'https://films.example/*',
      },
    ],
    [
      'a site the person allowed',
      'https://films.example/arrival',
      { allowedHosts: ['films.example'] },
      {
        origin: 'https://films.example',
        name: 'films.example',
        tracking: 'tracked',
        pattern: null,
      },
    ],
    [
      'any site, with all sites on',
      'https://films.example/arrival',
      { allSites: true },
      {
        origin: 'https://films.example',
        name: 'films.example',
        tracking: 'tracked',
        pattern: null,
      },
    ],
    [
      'an excluded site: tracking it removes the exclusion',
      'https://films.example/arrival',
      { allSites: true, excludedHosts: ['films.example'] },
      {
        origin: 'https://films.example',
        name: 'films.example',
        tracking: 'trackable',
        pattern: 'https://films.example/*',
      },
    ],
    [
      'a built-in service, by its name',
      'https://www.netflix.com/browse',
      {},
      { origin: 'https://www.netflix.com', name: 'Netflix', tracking: 'tracked', pattern: null },
    ],
    [
      'a built-in service the person turned off',
      'https://www.netflix.com/browse',
      { disabledServices: ['netflix'] },
      { origin: 'https://www.netflix.com', name: 'Netflix', tracking: 'turned_off', pattern: null },
    ],
    [
      'a blocked site',
      'https://www.youtube.com/watch?v=1',
      { allSites: true },
      {
        origin: 'https://www.youtube.com',
        name: 'www.youtube.com',
        tracking: 'blocked',
        pattern: null,
      },
    ],
    [
      'an address with a port: asked for by its host, since a match pattern names no port',
      'http://127.0.0.1:8080/film',
      {},
      {
        origin: 'http://127.0.0.1:8080',
        name: '127.0.0.1',
        tracking: 'trackable',
        pattern: 'http://127.0.0.1/*',
      },
    ],
  ])('%s', async (_name, tabUrl, settings, expected) => {
    const h = harness({ tabUrl, settings });
    expect(await siteFor(h)).toEqual(expected);
  });

  test.each([
    ['no address Chrome shows', null],
    ['a page that is not http(s)', 'chrome://newtab/'],
    ['an address that is no URL', 'not a url'],
  ])('%s: no site', async (_name, tabUrl) => {
    const h = harness({ tabUrl });
    expect(await siteFor(h)).toBeNull();
  });

  test('a page open in a tab of its own has no site', async () => {
    const h = harness({ tabUrl: 'https://films.example/arrival' });
    expect((await h.root.uiState(null)).site).toBeNull();
  });

  // The popup's Now playing line agrees with the site: Track this site only where it can work.
  test.each<[string, string, Partial<SettingsValue>, Partial<PopupState['nowPlaying']>]>([
    [
      'trackable',
      'https://films.example/arrival',
      {},
      { state: 'not_tracked', origin: 'https://films.example' },
    ],
    [
      'turned off: no Track this site',
      'https://www.netflix.com/browse',
      { disabledServices: ['netflix'] },
      { state: 'not_tracked', origin: null },
    ],
    ['blocked', 'https://www.youtube.com/watch?v=1', {}, { state: 'blocked', origin: null }],
  ])('Now playing on a site that is %s', async (_name, tabUrl, settings, expected) => {
    const h = harness({ tabUrl, settings });
    expect((await h.root.uiState(1)).nowPlaying).toMatchObject(expected ?? {});
  });

  test('a tracked site with nothing playing has a site and no Now playing', async () => {
    const h = harness({ tabUrl: 'https://www.netflix.com/browse' });
    const state = await h.root.uiState(1);
    expect(state.nowPlaying).toBeNull();
    expect(state.site?.tracking).toBe('tracked');
  });

  test('ui/track-site takes an origin with a port, checking the grant of its host', async () => {
    const h = harness({ granted: ['http://127.0.0.1:8080'] });
    const response = await askUi(h, { type: 'ui/track-site', origin: 'http://127.0.0.1:8080' });
    expect(response.ok).toBe(true);
    expect(h.permissions.has).toHaveBeenCalledWith('http://127.0.0.1:8080');
  });
});

describe('the popup says why a video that plays is not tracked', () => {
  const nowPlaying = async (h: Harness) => (await h.root.uiState(1)).nowPlaying;

  test('a page that names nothing: the site, the reason, and nothing once 30 s have passed', async () => {
    const facts: Facts = { url: COURSES, audible: false, incognito: false };
    const h = harness({ settings: COURSES_SETTINGS, overrides: tabFacts(facts) });
    await playFilm(h, { tabId: 1, frameId: 0, url: COURSES }, everyFifteen(45), lectureSnapshot());
    expect(await nowPlaying(h)).toMatchObject({
      state: 'not_tracking',
      reason: 'page_silent',
      serviceName: 'courses.example',
      viewingId: null,
      label: '',
      progress: null,
      problem: null,
    });
    h.clock.advance(29_000);
    expect(await nowPlaying(h)).toMatchObject({ state: 'not_tracking', reason: 'page_silent' });
    h.clock.advance(2_000);
    expect(await nowPlaying(h)).toBeNull();
  });

  test('the reason is kept for the tab alone: another tab says nothing of it', async () => {
    const facts: Facts = { url: COURSES, audible: false, incognito: false };
    const h = harness({ settings: COURSES_SETTINGS, overrides: tabFacts(facts) });
    await playFilm(h, { tabId: 1, frameId: 0, url: COURSES }, everyFifteen(45), lectureSnapshot());
    expect((await h.root.uiState(2)).nowPlaying).toBeNull();
  });

  test('a series page that names no season and episode says so', async () => {
    const url = 'https://series.example/watch/221';
    const facts: Facts = { url, audible: false, incognito: false };
    const h = harness({
      settings: { allowedHosts: ['series.example'] },
      overrides: tabFacts(facts),
    });
    const snapshot = snapshotOf(url, {
      openGraph: { 'og:type': 'video.tv_series', 'og:title': 'Some Show (2020)' },
    });
    await playFilm(h, { tabId: 1, frameId: 0, url }, everyFifteen(45), snapshot);
    expect(await nowPlaying(h)).toMatchObject({
      state: 'not_tracking',
      reason: 'series_no_episode',
    });
  });

  test('a billboard on a module site off its player route: not a player page, kept while it plays', async () => {
    const browse = 'https://www.netflix.com/browse';
    const facts: Facts = { url: browse, audible: true, incognito: false };
    const h = harness({ overrides: tabFacts(facts) });
    // Past 30 s, since the tab's last counted sample: the dropped ones are not samples of a
    // player, and the reason they keep is newer than that.
    await playFilm(h, { tabId: 1, frameId: 0, url: browse }, everyFifteen(75), snapshotOf(browse));
    expect(await nowPlaying(h)).toMatchObject({
      state: 'not_tracking',
      reason: 'not_player_page',
      serviceName: 'Netflix',
    });
  });

  // Chrome says a tab is audible; no frame has sent a sample.
  describe('a player the extension cannot reach', () => {
    test('audible, and no frame ever sent a sample', async () => {
      const facts: Facts = { url: PRIME_FILM, audible: true, incognito: false };
      const h = harness({ overrides: tabFacts(facts) });
      expect(await nowPlaying(h)).toMatchObject({
        state: 'not_tracking',
        reason: 'player_unreachable',
        serviceName: 'Prime Video',
      });
    });

    test('silent: nothing plays, nothing is said', async () => {
      const facts: Facts = { url: PRIME_FILM, audible: false, incognito: false };
      const h = harness({ overrides: tabFacts(facts) });
      expect(await nowPlaying(h)).toBeNull();
    });

    test('a sample within 30 s means the player is reached; one 31 s ago does not', async () => {
      const facts: Facts = { url: PRIME_FILM, audible: true, incognito: false };
      const h = harness({ overrides: tabFacts(facts) });
      // One paused sample: a frame spoke, and it leaves no reason behind.
      h.clock.set(T0);
      await report(
        h,
        { tabId: 1, frameId: 0, url: PRIME_FILM },
        sampleAt(h.clock, 0, { paused: true }),
        filmSnapshot(PRIME_FILM),
      );
      await settle();
      h.clock.set(T0 + 29_000);
      expect(await nowPlaying(h)).toBeNull();
      h.clock.set(T0 + 31_000);
      expect(await nowPlaying(h)).toMatchObject({
        state: 'not_tracking',
        reason: 'player_unreachable',
      });
    });

    test('it hides a bound viewing, but only for an audible tab', async () => {
      const facts: Facts = { url: PRIME_FILM, audible: false, incognito: false };
      const h = harness({ overrides: tabFacts(facts) });
      await playFilm(h, { tabId: 1, frameId: 0, url: PRIME_FILM }, everyFifteen(45));
      expect(await nowPlaying(h)).toMatchObject({ state: 'tracking', label: 'Arrival' });
      h.clock.advance(40_000);
      expect(await nowPlaying(h)).toMatchObject({ state: 'tracking', label: 'Arrival' });
      facts.audible = true;
      expect(await nowPlaying(h)).toMatchObject({
        state: 'not_tracking',
        reason: 'player_unreachable',
        viewingId: null,
        label: '',
      });
    });

    test('a recent sample that reaches a viewing keeps the viewing on show', async () => {
      const facts: Facts = { url: PRIME_FILM, audible: true, incognito: false };
      const h = harness({ overrides: tabFacts(facts) });
      await playFilm(h, { tabId: 1, frameId: 0, url: PRIME_FILM }, everyFifteen(45));
      expect(await nowPlaying(h)).toMatchObject({ state: 'tracking', label: 'Arrival' });
    });
  });

  // Tracking paused, an incognito tab, a service turned off: the worker's own gates.
  describe('the gates before the core are told from the tab and the settings, in that order', () => {
    const PAUSED = { pausedUntil: PAUSE_INDEFINITELY } as const;
    test.each<[string, Partial<SettingsValue>, Partial<Facts>, string]>([
      ['a tracked page that is audible and unheard', {}, {}, 'player_unreachable'],
      ['paused', PAUSED, {}, 'tracking_paused'],
      ['an incognito window without the setting', {}, { incognito: true }, 'incognito'],
      [
        'an incognito window with the setting on',
        { trackIncognito: true },
        { incognito: true },
        'player_unreachable',
      ],
      ['a service turned off', { disabledServices: ['prime_video'] }, {}, 'service_off'],
      [
        'incognito before the service turned off',
        { disabledServices: ['prime_video'] },
        { incognito: true },
        'incognito',
      ],
      [
        'paused before incognito and the service turned off',
        { ...PAUSED, disabledServices: ['prime_video'] },
        { incognito: true },
        'tracking_paused',
      ],
    ])('%s', async (_name, settings, change, reason) => {
      const facts: Facts = { url: PRIME_FILM, audible: true, incognito: false, ...change };
      const h = harness({ settings, overrides: tabFacts(facts) });
      expect(await nowPlaying(h)).toMatchObject({ state: 'not_tracking', reason });
    });

    test.each<[string, Partial<SettingsValue>, Partial<Facts>]>([
      ['paused', PAUSED, {}],
      ['an incognito window without the setting', {}, { incognito: true }],
      ['a service turned off', { disabledServices: ['prime_video'] }, {}],
    ])('%s, and nothing plays: no reason is given', async (_name, settings, change) => {
      const facts: Facts = { url: PRIME_FILM, audible: false, incognito: false, ...change };
      const h = harness({ settings, overrides: tabFacts(facts) });
      const playing = await nowPlaying(h);
      expect(playing?.reason ?? null).toBeNull();
    });

    test('a recent kept reason is something that plays: paused is told even for a silent tab', async () => {
      const facts: Facts = { url: COURSES, audible: false, incognito: false };
      const h = harness({ settings: COURSES_SETTINGS, overrides: tabFacts(facts) });
      await playFilm(
        h,
        { tabId: 1, frameId: 0, url: COURSES },
        everyFifteen(45),
        lectureSnapshot(),
      );
      await h.settings.patch({ pausedUntil: PAUSE_INDEFINITELY });
      expect(await nowPlaying(h)).toMatchObject({ reason: 'tracking_paused' });
      // Thirty seconds on, nothing plays any more.
      h.clock.advance(31_000);
      expect((await nowPlaying(h))?.reason ?? null).toBeNull();
    });

    test('a kept reason is told after the pause: paused beats it', async () => {
      const facts: Facts = { url: COURSES, audible: true, incognito: false };
      const h = harness({ settings: COURSES_SETTINGS, overrides: tabFacts(facts) });
      await playFilm(
        h,
        { tabId: 1, frameId: 0, url: COURSES },
        everyFifteen(45),
        lectureSnapshot(),
      );
      expect(await nowPlaying(h)).toMatchObject({ reason: 'page_silent' });
      await h.settings.patch({ pausedUntil: PAUSE_INDEFINITELY });
      expect(await nowPlaying(h)).toMatchObject({ reason: 'tracking_paused' });
    });
  });

  describe('the states a site already has win', () => {
    const YOUTUBE_WATCH = 'https://www.youtube.com/watch?v=1';

    test('a blocked site keeps its line, however loud', async () => {
      const facts: Facts = { url: YOUTUBE_WATCH, audible: true, incognito: false };
      const h = harness({ overrides: tabFacts(facts) });
      expect(await nowPlaying(h)).toMatchObject({ state: 'blocked', reason: null });
    });

    test('a blocked site is not "paused" either', async () => {
      const facts: Facts = { url: YOUTUBE_WATCH, audible: true, incognito: false };
      const h = harness({
        settings: { pausedUntil: PAUSE_INDEFINITELY },
        overrides: tabFacts(facts),
      });
      expect(await nowPlaying(h)).toMatchObject({ state: 'blocked', reason: null });
    });

    test('a site the extension does not run on keeps its line, and offers Track this site', async () => {
      const facts: Facts = {
        url: 'https://films.example/arrival',
        audible: true,
        incognito: false,
      };
      const h = harness({ overrides: tabFacts(facts) });
      expect(await nowPlaying(h)).toMatchObject({
        state: 'not_tracked',
        reason: null,
        origin: 'https://films.example',
      });
    });
  });

  describe('a bound viewing the play builder would refuse', () => {
    /** Netflix with its episode numbers hidden: a show, no season and no episode. */
    const hiddenNumbers = (_id: string, s: Snapshot): ServiceReading | null =>
      s.url.pathname.startsWith('/watch/')
        ? {
            kind: { value: 'episode', confidence: 0.95, source: 'module' },
            showTitle: { value: 'Breaking Bad', confidence: 0.95, source: 'module' },
            providerIds: [{ level: 'title', key: 'videoId', value: '70196253' }],
          }
        : null;

    test('stays tracking, and says that it will not be added, and why', async () => {
      const facts: Facts = { url: NETFLIX_WATCH, audible: false, incognito: false };
      const h = harness({ interpret: hiddenNumbers, overrides: tabFacts(facts) });
      await playFilm(
        h,
        { tabId: 1, frameId: 0, url: NETFLIX_WATCH },
        everyFifteen(45),
        snapshotOf(NETFLIX_WATCH),
      );
      expect(await nowPlaying(h)).toMatchObject({
        state: 'tracking',
        problem: 'series_no_episode',
        reason: null,
      });
    });

    test('a viewing that will be added has no problem', async () => {
      const facts: Facts = { url: PRIME_FILM, audible: false, incognito: false };
      const h = harness({ overrides: tabFacts(facts) });
      await playFilm(h, { tabId: 1, frameId: 0, url: PRIME_FILM }, everyFifteen(45));
      expect(await nowPlaying(h)).toMatchObject({ state: 'tracking', problem: null });
    });
  });
});

describe('diagnostics: viewing.ignored', () => {
  const ignoredLogs = (h: Harness) => loggedAs(h, 'viewing.ignored');

  test('once per change of reason in a tab, with the reason alone', async () => {
    const h = harness({ settings: COURSES_SETTINGS });
    const frame = { tabId: 1, frameId: 0, url: COURSES };
    // Three observations of a page that names nothing.
    await playFilm(h, frame, [0, 15, 30], lectureSnapshot());
    expect(ignoredLogs(h)).toEqual([['viewing.ignored', { reason: 'page_silent' }]]);
    // An ad shows: a new reason.
    for (const [i, position] of [45, 60].entries()) {
      h.clock.set(T0 + (45 + i * 15) * 1000);
      await report(h, frame, sampleAt(h.clock, position, { adPlaying: true }), lectureSnapshot());
      await settle();
    }
    expect(ignoredLogs(h).map(([, detail]) => detail)).toEqual([
      { reason: 'page_silent' },
      { reason: 'ad' },
    ]);
    // The first reason returns: it is logged again.
    await playFilm(h, frame, [75, 90], lectureSnapshot(), 75);
    expect(ignoredLogs(h).map(([, detail]) => detail)).toEqual([
      { reason: 'page_silent' },
      { reason: 'ad' },
      { reason: 'page_silent' },
    ]);
  });

  test('a viewing that binds clears the kept reason and adds no reason of its own', async () => {
    const h = harness({ settings: COURSES_SETTINGS });
    const lecture = { tabId: 1, frameId: 0, url: COURSES };
    const filmUrl = 'https://courses.example/arrival';
    const film = { tabId: 1, frameId: 0, url: filmUrl };
    await playFilm(h, lecture, [0, 15], lectureSnapshot());
    expect(ignoredLogs(h)).toHaveLength(1);
    // A film on the same site binds in the same tab, which clears the kept reason.
    await playFilm(h, film, [30, 45, 60, 75], filmSnapshot(filmUrl), 30);
    expect(h.viewings.all()).toHaveLength(1);
    // The brief wait for the reading to hold still is a reason of its own; binding adds none,
    // and clears what was kept against the tab.
    expect(ignoredLogs(h).map(([, detail]) => detail)).toEqual([
      { reason: 'page_silent' },
      { reason: 'settling' },
    ]);
    expect((await h.viewings.tabState(1))?.ignored ?? null).toBeNull();
  });

  test('another tab has its own last reason', async () => {
    const h = harness({ settings: COURSES_SETTINGS });
    await playFilm(h, { tabId: 1, frameId: 0, url: COURSES }, [0, 15], lectureSnapshot());
    await playFilm(h, { tabId: 2, frameId: 0, url: COURSES }, [0, 15], lectureSnapshot());
    expect(ignoredLogs(h)).toHaveLength(2);
  });

  test('a billboard off the player route logs not_player_page once', async () => {
    const browse = 'https://www.netflix.com/browse';
    const h = harness();
    await playFilm(h, { tabId: 1, frameId: 0, url: browse }, [0, 15, 30, 45], snapshotOf(browse));
    expect(ignoredLogs(h)).toEqual([['viewing.ignored', { reason: 'not_player_page' }]]);
  });
});

describe('Recently: the answers to a start link where they should', () => {
  const startBody: PlayBody = {
    report: 'start',
    kind: 'movie',
    title: 'Arrival',
    duration_seconds: 6_960,
    furthest_position_seconds: 1_020,
  };
  const answered = (
    n: number,
    state: 'started' | 'ignored',
    reason: string | null,
    titleId: string | null,
  ): HistoryEntry => ({
    playId: `0192f1a2-7b3c-7d4e-8f5a-6b7c8d9e0f${String(50 + n)}`,
    body: startBody,
    label: 'Arrival',
    scrobbleId: `s-${String(n)}`,
    sentAt: T0 - n * 60_000,
    receipt: { state, reason, titleId },
    receiptReadAt: T0,
    receiptGoneAt: null,
  });

  test.each<[string, 'started' | 'ignored', string | null, string | null, string | null]>([
    ['started links to the title its receipt names', 'started', null, 'title-1', 'title-1'],
    ['already in the library links to it', 'ignored', 'status_stands', 'title-2', 'title-2'],
    ['could not tell which film links nowhere', 'ignored', 'not_placed', null, null],
  ])('%s', async (_name, state, reason, titleId, link) => {
    const h = harness();
    await h.history.put(answered(1, state, reason, titleId));
    const [line] = (await h.root.uiState(null)).recent;
    expect(line?.start).toBe(true);
    expect(line?.href).toBe(
      link === null ? null : `http://localhost:3000${WEB_ROUTES.title(link)}`,
    );
  });

  test('a start waiting to be sent is a start line too', async () => {
    const h = harness();
    await h.outbox.add({
      playId: '0192f1a2-7b3c-7d4e-8f5a-6b7c8d9e0f77',
      viewingId: 'v-9',
      body: startBody,
      createdAt: T0,
      watchedAt: T0,
      attempts: 0,
      nextAttemptAt: T0 + DAY,
      state: 'pending',
      lastError: null,
    });
    const [line] = (await h.root.uiState(null)).recent;
    expect(line).toMatchObject({ start: true, label: 'Arrival' });
  });
});
