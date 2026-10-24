/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The composition root, as the pages reach it: the sender rules and coalescing, a same-document
// navigation, the bootstrap in tabs already open, the entry rule and what may start a viewing,
// sittings, and — over fake-indexeddb — a play that survives the worker's restart. Expected
// values come from the rules the root applies, through the harness (test-harness.ts).

import type { PlayBody, ServiceReading, Snapshot } from '@mt/core';
import { FakeClock, FakePlaysGateway, FakeScheduler } from '@mt/core/testing';
import { createPlaysGateway } from '@mt/api';
import { describe, expect, test, vi } from 'vitest';

import { IdbConnectionRepo } from '../platform/connection-store';
import { IdbPlayHistory } from '../platform/history-store';
import { openDatabase } from '../platform/idb';
import type { MtDatabase } from '../platform/idb';
import { IdbOutbox } from '../platform/outbox-store';
import { credentialSigner } from '../platform/signer';
import { IdbViewingStore } from '../platform/viewing-store';
import { createRoot } from './root';
import type { PlatformDeps } from './root';
import {
  API,
  CONNECTED,
  CONNECTED_ID,
  EPISODE_A,
  EPISODE_B,
  FILM_SECONDS,
  KEY_A,
  KEY_B,
  NETFLIX_BROWSE,
  NETFLIX_WATCH,
  PRIME_FILM,
  ROOT_ACCOUNT,
  T0,
  TestSettings,
  WHOLE_FILM,
  askUi,
  episodeSnapshot,
  everyFifteen,
  filmSnapshot,
  harness,
  keysOf,
  netflixLike,
  playFilm,
  report,
  sampleAt,
  sender,
  settle,
  snapshotOf,
  useRootTestEnvironment,
  uuidIds,
} from './test-harness';
import type { FrameAt, Harness, OpenTab } from './test-harness';

useRootTestEnvironment();

describe('a control: a whole film on a built-in site without a module', () => {
  // A viewing is reported when it reaches its line, watched, content, says what it is and is
  // allowed; JSON-LD Movie passes the entry rule; an outbox entry exists before any network call.
  test('opens one viewing and reports it once', async () => {
    const h = harness();
    await playFilm(h, { tabId: 1, frameId: 0, url: PRIME_FILM }, WHOLE_FILM);
    expect(h.viewings.all()).toHaveLength(1);
    expect(h.viewings.all()[0]?.reading.title).toBe('Arrival');
    const sends = h.gateway.sends.length + h.outbox.entries().length;
    expect(sends).toBe(1);
  });
});

describe('the sender rules', () => {
  // A message from another extension id is ignored.
  test('a message from another extension is ignored', async () => {
    const h = harness();
    const frame = { tabId: 1, frameId: 0, url: PRIME_FILM, senderId: 'another-extension' };
    const play = await h.root.onContentMessage({ v: 1, type: 'bootstrap/play' }, sender(frame));
    expect(play).toEqual({ inject: false });
    expect(h.injector.inject).not.toHaveBeenCalled();
    await playFilm(h, frame, WHOLE_FILM);
    expect(h.viewings.all()).toEqual([]);
    expect(h.outbox.entries()).toEqual([]);
  });

  // A report from an excluded host is ignored (an exclusion beats a built-in service).
  test('a report from an excluded host is ignored', async () => {
    const h = harness({ settings: { excludedHosts: ['primevideo.com'] } });
    const frame = { tabId: 1, frameId: 0, url: PRIME_FILM };
    const play = await h.root.onContentMessage({ v: 1, type: 'bootstrap/play' }, sender(frame));
    expect(play).toEqual({ inject: false });
    await playFilm(h, frame, WHOLE_FILM);
    expect(h.viewings.all()).toEqual([]);
    expect(h.outbox.entries()).toEqual([]);
  });

  // A report whose payload claims a different site changes nothing (the site is taken from
  // sender.url).
  test('a snapshot claiming a tracked site from an untracked one changes nothing', async () => {
    const h = harness();
    const frame = { tabId: 1, frameId: 0, url: 'https://not-allowed.example/film' };
    await playFilm(h, frame, WHOLE_FILM, filmSnapshot(PRIME_FILM));
    expect(h.viewings.all()).toEqual([]);
    expect(h.outbox.entries()).toEqual([]);
  });

  // The site comes from sender.url, never from the message. The forged snapshot keeps the
  // frame's own path: one on another path names nothing at all.
  test('a snapshot claiming Netflix from Prime Video is read as Prime Video', async () => {
    const h = harness({
      interpret: () => ({
        kind: { value: 'movie', confidence: 0.95, source: 'module' },
        title: { value: 'Forged', confidence: 0.95, source: 'module' },
      }),
    });
    const frame = { tabId: 1, frameId: 0, url: PRIME_FILM };
    const forged = filmSnapshot(`https://www.netflix.com${new URL(PRIME_FILM).pathname}`);
    await playFilm(h, frame, WHOLE_FILM.slice(0, 4), forged);
    expect(h.interpreter.calls).toEqual([]);
    const [viewing] = h.viewings.all();
    expect(viewing?.serviceId).toBeNull();
    expect(viewing?.reading.title).toBe('Arrival');
    const capture = await h.root.onUiRequest({ v: 1, id: 1, type: 'ui/capture', tabId: 1 });
    const data = (capture?.response as { data?: { fixture?: { snapshot?: Snapshot } } }).data;
    expect(data?.fixture?.snapshot?.url.hostname).toBe('www.primevideo.com');
  });
});

describe('a same-document navigation', () => {
  // Seen on a real Netflix tab (2026-10-22): the billboard plays on /browse, the click is a pushState
  // to /watch/<id>, and Chrome's sender.url stays /browse for the rest of the document.
  test('browse, then a pushState to /watch/<id>, opens that title’s viewing', async () => {
    const h = harness({ interpret: netflixLike });
    const browse = { tabId: 1, frameId: 0, url: NETFLIX_BROWSE };
    await playFilm(h, browse, [0, 15], snapshotOf(NETFLIX_BROWSE));
    const watch = { tabId: 1, frameId: 0, url: EPISODE_A };
    expect(sender(watch).url).toBe(NETFLIX_BROWSE);
    await playFilm(h, watch, [0, 15, 30], episodeSnapshot(EPISODE_A), 30);
    expect(keysOf(h)).toEqual([KEY_A]);
  });

  // Netflix's autoplay into the next episode: the same document, the next id on the address.
  test('watch A, then a pushState to watch B, opens B’s viewing, and A gets nothing of B’s', async () => {
    const h = harness({ interpret: netflixLike });
    const watch = { tabId: 1, frameId: 0, url: EPISODE_A };
    await playFilm(h, watch, [0, 15, 30, 45], episodeSnapshot(EPISODE_A));
    const before = h.viewings.all().find((v) => v.key === KEY_A)?.ranges;
    expect(before?.length).toBeGreaterThan(0);
    const next = { tabId: 1, frameId: 0, url: EPISODE_B };
    await playFilm(h, next, [0, 15, 30], episodeSnapshot(EPISODE_B, 'Еп. 4', 'Наступна'), 60);
    expect(keysOf(h).sort()).toEqual([KEY_A, KEY_B]);
    expect(h.viewings.all().find((v) => v.key === KEY_A)?.ranges).toEqual(before);
    expect(h.viewings.all().find((v) => v.key === KEY_B)?.ranges.length).toBeGreaterThan(0);
  });

  // A snapshot built on A, delivered once Chrome already says B: it names nothing, its sample
  // still counts (it is the bound media's).
  test('a report built before a pushState and delivered after it names nothing, but its sample counts', async () => {
    const h = harness({ interpret: netflixLike });
    const watch = { tabId: 1, frameId: 0, url: EPISODE_A };
    await playFilm(h, watch, [0, 15, 30], episodeSnapshot(EPISODE_A));
    expect(keysOf(h)).toEqual([KEY_A]);
    const asked = h.interpreter.calls.length;
    h.clock.set(T0 + 45_000);
    const late = { tabId: 1, frameId: 0, url: EPISODE_B };
    await report(h, late, sampleAt(h.clock, 45), episodeSnapshot(EPISODE_A));
    await settle();
    expect(h.interpreter.calls.length).toBe(asked);
    expect(keysOf(h)).toEqual([KEY_A]);
    expect(h.viewings.all()[0]?.lastSampleAt).toBe(T0 + 45_000);
  });

  // The site is Chrome's word for the document, never a tab address of another origin (a late
  // message of a document the tab has already left).
  test('a frame-0 tab.url of another origin is ignored', async () => {
    const h = harness({ interpret: netflixLike });
    const frame = {
      tabId: 1,
      frameId: 0,
      url: EPISODE_A,
      tabUrl: 'https://www.primevideo.com/watch/99999999',
    };
    await playFilm(h, frame, [0, 15, 30], episodeSnapshot(EPISODE_A));
    expect(keysOf(h)).toEqual([KEY_A]);
    const capture = await h.root.onUiRequest({ v: 1, id: 1, type: 'ui/capture', tabId: 1 });
    const data = (capture?.response as { data?: { fixture?: { snapshot?: Snapshot } } }).data;
    expect(data?.fixture?.snapshot?.url).toMatchObject({
      hostname: 'www.netflix.com',
      pathname: '/watch/80000003',
    });
  });
});

describe('a frame’s identity survives hidden controls', () => {
  /** The player page once Netflix hid its controls: no title area, the route's id alone. */
  const hidden = (url: string): Snapshot =>
    snapshotOf(url, { documentTitle: 'Netflix', selectors: { titleHeading: [], titleParts: [] } });

  test('the controls show once and then hide: it still binds on the second sighting of the id', async () => {
    const h = harness({ interpret: netflixLike });
    const watch = { tabId: 1, frameId: 0, url: EPISODE_A };
    await playFilm(h, watch, [0], episodeSnapshot(EPISODE_A));
    expect(keysOf(h)).toEqual([]);
    await playFilm(h, watch, [15, 30], hidden(EPISODE_A), 15);
    expect(keysOf(h)).toEqual([KEY_A]);
    const [viewing] = h.viewings.all();
    expect(viewing?.reading).toMatchObject({ kind: 'episode', showTitle: 'Джентльмени' });
  });

  // The same id on another path (the route's locale segment): the path changed, so nothing of
  // the previous reading is kept, and the hidden controls name nothing.
  test('a path change carries nothing, even for the same id', async () => {
    const h = harness({ interpret: netflixLike });
    await playFilm(h, { tabId: 1, frameId: 0, url: EPISODE_A }, [0], episodeSnapshot(EPISODE_A));
    const localized = { tabId: 1, frameId: 0, url: 'https://www.netflix.com/gb/watch/80000003' };
    await playFilm(h, localized, [15, 30, 45], hidden(localized.url), 15);
    expect(keysOf(h)).toEqual([]);
  });
});

// Seen on a real Netflix tab (2026-10-22): after Reload on chrome://extensions the open tab
// kept the previous version's bootstrap, cut off from the new worker, and nothing played.
describe('the bootstrap in tabs already open', () => {
  const OPEN: readonly OpenTab[] = [
    {
      tabId: 1,
      url: 'https://www.netflix.com/watch/70196253',
      frames: [
        { frameId: 0, documentId: 'netflix-top', origin: 'https://www.netflix.com' },
        // An `about:blank` player frame: its origin is its creator's (match_origin_as_fallback).
        { frameId: 1, documentId: 'netflix-blank', origin: 'https://www.netflix.com' },
        { frameId: 2, documentId: 'blocked', origin: 'https://www.youtube.com' },
        { frameId: 3, documentId: 'ads', origin: 'https://ads.example' },
        { frameId: 4, documentId: 'sandboxed', origin: null },
      ],
    },
    {
      tabId: 2,
      url: 'https://films.example/arrival',
      frames: [{ frameId: 0, documentId: 'films-top', origin: 'https://films.example' }],
    },
    {
      tabId: 3,
      url: 'https://excluded.example/film',
      frames: [{ frameId: 0, documentId: 'excluded-top', origin: 'https://excluded.example' }],
    },
  ];
  const grants = {
    allowedHosts: ['films.example', 'excluded.example'],
    excludedHosts: ['excluded.example'],
  };
  const injected = (h: Harness): string[] =>
    h.bootstrap.inject.mock.calls.map(([t]) => `${String(t.tabId)}/${String(t.frameId)}`).sort();

  test.each(['install', 'update'])(
    'on %s, every frame of a built-in or granted site gets it, never a blocked or excluded one',
    async (reason) => {
      const h = harness({ settings: grants, openTabs: OPEN });
      await h.root.onInstalled(reason);
      expect(injected(h)).toEqual(['1/0', '1/1', '2/0']);
      expect(h.bootstrap.inject).toHaveBeenCalledWith({
        tabId: 1,
        frameId: 0,
        documentId: 'netflix-top',
      });
    },
  );

  test('a browser or shared-module update injects nothing', async () => {
    const h = harness({ settings: grants, openTabs: OPEN });
    await h.root.onInstalled('chrome_update');
    await h.root.onInstalled('shared_module_update');
    expect(h.bootstrap.inject).not.toHaveBeenCalled();
  });

  test('a newly granted site gets it in its open tabs, and only those', async () => {
    const h = harness({ settings: grants, openTabs: OPEN });
    await h.root.onPermissionsChanged(['https://films.example/*']);
    expect(h.bootstrap.openTabs).toHaveBeenCalledWith(['https://films.example/*']);
    expect(injected(h)).toEqual(['2/0']);
  });

  test('a permission given back injects nothing', async () => {
    const h = harness({ settings: grants, openTabs: OPEN });
    await h.root.onPermissionsChanged([]);
    expect(h.bootstrap.inject).not.toHaveBeenCalled();
  });
});

describe('what may start a viewing', () => {
  const titled = (): ServiceReading => ({
    kind: { value: 'movie', confidence: 0.95, source: 'module' },
    title: { value: 'Arrival', confidence: 0.95, source: 'module' },
    providerIds: [{ level: 'title', key: 'videoId', value: '70196253' }],
  });

  /** The module answers on a player route only (Netflix's `/watch/<id>`). */
  const onPlayerRoute = (_id: string, s: Snapshot): ServiceReading | null =>
    s.url.pathname.startsWith('/watch/') ? titled() : null;

  const top = { tabId: 1, frameId: 0, url: NETFLIX_WATCH };
  const embed = (frameId: number, path: string): FrameAt => ({
    tabId: 1,
    frameId,
    url: `https://player.netflix.com${path}`,
    tabUrl: top.url,
  });
  const player = embed(3, '/embed/1');
  const preview = embed(4, '/embed/2');

  /** `rounds` observations of the top frame's snapshot and the player frame's sample. */
  async function playEmbedded(h: Harness, rounds: number): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      h.clock.set(T0 + i * 15_000);
      await report(h, top, null, snapshotOf(top.url));
      const sample = sampleAt(h.clock, i * 15, { visibleArea: 0.6 });
      await report(h, player, sample, snapshotOf(player.url));
      await settle();
    }
  }

  // A Netflix browse URL (not a player route) starts no viewing.
  test('a Netflix browse page starts nothing, whatever a module would say', async () => {
    const h = harness({ interpret: titled });
    const browse = 'https://www.netflix.com/browse';
    await playFilm(h, { tabId: 1, frameId: 0, url: browse }, WHOLE_FILM, snapshotOf(browse));
    expect(h.viewings.all()).toEqual([]);
    expect(h.outbox.entries()).toEqual([]);
  });

  // A generic page failing the entry rule starts no viewing; for example og:type video.other and
  // "Lecture 3: Calculus".
  test('an allowed page that does not say it is a film or an episode starts nothing', async () => {
    const h = harness({ settings: { allowedHosts: ['courses.example'] } });
    const url = 'https://courses.example/lecture-3';
    const snapshot = snapshotOf(url, {
      documentTitle: 'Lecture 3: Calculus',
      openGraph: { 'og:type': 'video.other', 'og:title': 'Lecture 3: Calculus' },
    });
    await playFilm(h, { tabId: 1, frameId: 0, url }, WHOLE_FILM, snapshot);
    expect(h.viewings.all()).toEqual([]);
    expect(h.outbox.entries()).toEqual([]);
    // The popup says why.
    const playing = (await h.root.uiState(1)).nowPlaying;
    expect(playing).toMatchObject({ state: 'not_tracking', reason: 'page_silent' });
  });

  // Seen in a real capture: a series page that names the episode in its address only.
  test('a series page whose address names the episode starts a viewing of that episode', async () => {
    const h = harness({ settings: { allowedHosts: ['series.example'] } });
    const url = 'https://series.example/watch/221#t:221-s:5-e:1';
    const snapshot = snapshotOf(url, {
      openGraph: {
        'og:type': 'video.tv_series',
        'og:title': 'Киллер с ножницами / Киллер Севен (2020)',
      },
    });
    await playFilm(h, { tabId: 1, frameId: 0, url }, WHOLE_FILM.slice(0, 4), snapshot);
    expect(h.viewings.all().map((v) => v.reading)).toMatchObject([
      { kind: 'episode', showTitle: 'Киллер с ножницами', showYear: 2020, season: 5, episode: 1 },
    ]);
  });

  // On an allowed site a JSON-LD Movie starts a viewing (the rule's positive side).
  test('an allowed page whose JSON-LD says Movie starts a viewing', async () => {
    const h = harness({ settings: { allowedHosts: ['films.example'] } });
    const frame = { tabId: 1, frameId: 0, url: 'https://films.example/arrival' };
    await playFilm(h, frame, WHOLE_FILM.slice(0, 4));
    expect(h.viewings.all()).toHaveLength(1);
  });

  // Two frames — a playing iframe without a title and a top frame whose module reading has the
  // title — produce one viewing with that title.
  test('a title-less playing iframe and a top frame with the module reading make one viewing', async () => {
    const h = harness({ interpret: onPlayerRoute });
    await playEmbedded(h, 4);
    const all = h.viewings.all();
    expect(all).toHaveLength(1);
    expect(all[0]?.reading.title).toBe('Arrival');
  });

  // Writes are coalesced: at most one storage write per tab per 15 s sample, so three frame
  // reports within 250 ms cause one ViewingStore.put.
  test('three reports within 250 ms are one observation and one put', async () => {
    const h = harness({ interpret: onPlayerRoute });
    await playEmbedded(h, 3);
    expect(h.viewings.all()).toHaveLength(1);
    const puts = h.viewings.writes.put;
    const tabWrites = h.viewings.writes.putTabState;

    h.clock.set(T0 + 45_000);
    await report(h, top, null, snapshotOf(top.url));
    await vi.advanceTimersByTimeAsync(40);
    await report(h, player, sampleAt(h.clock, 45, { visibleArea: 0.6 }), snapshotOf(player.url));
    await vi.advanceTimersByTimeAsync(40);
    const previewSample = sampleAt(h.clock, 3, { visibleArea: 0.05, muted: true, duration: 30 });
    await report(h, preview, previewSample, snapshotOf(preview.url));
    await settle();
    expect(h.viewings.writes.put - puts).toBe(1);
    expect(h.viewings.writes.putTabState - tabWrites).toBeLessThanOrEqual(1);
  });
});

describe('a burst from one frame (write-coalesced, at most one write per sample)', () => {
  // Reports arriving within 250 ms are ingested as one observation.
  test('three reports of one frame within 250 ms make one put', async () => {
    const h = harness();
    const frame = { tabId: 1, frameId: 0, url: PRIME_FILM };
    await playFilm(h, frame, [0, 15, 30]);
    expect(h.viewings.all()).toHaveLength(1);
    const puts = h.viewings.writes.put;
    for (const [i, position] of [45, 45.1, 45.2].entries()) {
      h.clock.set(T0 + 45_000 + i * 100);
      await report(h, frame, sampleAt(h.clock, position), filmSnapshot(PRIME_FILM));
      await vi.advanceTimersByTimeAsync(10);
    }
    await settle();
    expect(h.viewings.writes.put - puts).toBe(1);
  });
});

describe('sittings', () => {
  // onTabRemoved ends the sitting and a later report starts a new sitting of the same viewing.
  test('a closed tab ends its sitting; a later one joins the same viewing without bridging', async () => {
    const h = harness();
    const frame = { tabId: 1, frameId: 0, url: PRIME_FILM };
    await playFilm(h, frame, [0, 15, 30, 45, 60]);
    const [first] = h.viewings.all();
    expect(first).toBeDefined();
    await h.root.onTabRemoved(1);
    expect(await h.viewings.tabState(1)).toBeNull();

    // Ten seconds later, 15 s further on: continuous by the seek rule had the sitting
    // gone on — so the stretch 60…75 is covered only if the old sitting were still open. The
    // same tab id, so that only the ended sitting — not a new tab's empty state — keeps the two
    // sittings apart.
    for (const [i, position] of [75, 90, 105, 120].entries()) {
      h.clock.set(T0 + 70_000 + i * 15_000);
      await report(h, frame, sampleAt(h.clock, position), filmSnapshot(PRIME_FILM));
      await settle();
    }
    const all = h.viewings.all();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(first?.id);
    const ranges = all[0]?.ranges ?? [];
    for (const [start, end] of ranges) expect(end <= 60 || start >= 75).toBe(true);
    expect(ranges.some(([start]) => start >= 75)).toBe(true);
  });
});

describe('restart integration', () => {
  /** What a scripted `fetch` received. */
  interface Received {
    readonly url: string;
    readonly init: RequestInit | undefined;
  }

  /** A `202` as the server writes one: `{scrobble_id, state, reason}`. */
  const accepted = (): Response => {
    const body = { scrobble_id: '01JABCDEFGHJKMNPQRSTVWXYZ0', state: 'received', reason: null };
    const headers = { 'Content-Type': 'application/json' };
    return new Response(JSON.stringify(body), { status: 202, headers });
  };

  // Feed two stable reports, report a finished viewing, drop the root and build a new one over
  // the same fake-indexeddb: onStartup() drains the outbox and the mock gateway receives exactly
  // one play with the original playId. The play's event id is the Idempotency-Key, every retry
  // the same key.
  test('a play enqueued before the worker stopped is sent once, under its own key, after a restart', async () => {
    const dbs: MtDatabase[] = [];
    const open = async (): Promise<() => Promise<MtDatabase>> => {
      const db = await openDatabase();
      dbs.push(db);
      return () => Promise.resolve(db);
    };
    const clock = new FakeClock(T0, 120);
    const settings = new TestSettings();

    async function rootOver(gateway: PlatformDeps['gateway']) {
      const db = await open();
      const root = createRoot({
        ...harness().deps,
        clock,
        ids: uuidIds(clock),
        viewings: new IdbViewingStore(db),
        outbox: new IdbOutbox(db),
        history: new IdbPlayHistory(db),
        connection: new IdbConnectionRepo(db),
        settings,
        gateway,
        scheduler: new FakeScheduler(clock),
      });
      return { root, db };
    }

    // The connection, as a sign-in stored it (a personal token: no proof to verify here) and its
    // first check named its account.
    const setup = await open();
    await new IdbConnectionRepo(setup).saveCredential(CONNECTED, 'mts_pat_restart', null);
    await new IdbConnectionRepo(setup).keepAccountKey(CONNECTED_ID, ROOT_ACCOUNT);

    // Worker 1: the send it starts never comes back — the worker is stopped mid-send.
    const hanging = new FakePlaysGateway();
    hanging.onSend = () => new Promise(() => undefined);
    const first = await rootOver(hanging);
    const h1 = { ...harness(), root: first.root, clock } as unknown as Harness;
    await playFilm(h1, { tabId: 1, frameId: 0, url: PRIME_FILM }, WHOLE_FILM);
    const queued = await new IdbOutbox(first.db).list();
    expect(queued).toHaveLength(1);
    const original = queued[0];
    if (original === undefined) throw new Error('nothing was queued');

    for (const db of dbs.splice(0)) db.close();

    // Worker 2, over the same database, with the real gateway on a scripted fetch.
    const requests: Received[] = [];
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input instanceof Request ? input.url : input), init });
      return Promise.resolve(accepted());
    });
    const restartedDb = await open();
    const nonces = { get: () => Promise.resolve(null), set: () => Promise.resolve() };
    const gateway = createPlaysGateway({
      fetch,
      apiBase: API,
      signer: credentialSigner(new IdbConnectionRepo(restartedDb), nonces, clock),
    });
    const second = await rootOver(gateway);
    await second.root.onStartup();
    await settle();
    await settle();

    const plays = requests.filter((r) => r.url === `${API}/v1/integrations/plays`);
    expect(plays).toHaveLength(1);
    const headers = new Headers(plays[0]?.init?.headers);
    expect(headers.get('Idempotency-Key')).toBe(original.playId);
    expect(JSON.parse(plays[0]?.init?.body as string) as PlayBody).toEqual(original.body);
    expect(await new IdbOutbox(second.db).list()).toEqual([]);
    const sent = await new IdbPlayHistory(second.db).byPlayId(original.playId);
    expect(sent?.playId).toBe(original.playId);
    for (const db of dbs.splice(0)) db.close();
  });
});

describe('on a module site a sample counts only while the top frame is on a player route', () => {
  // A sample counts only on a player route. A billboard on Netflix's /browse
  // plays media of the episode's own length, so no length rule can tell it apart: the route can.
  const BILLBOARD = [0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150];

  async function billboard(h: Harness, frame: FrameAt, startAt: number): Promise<void> {
    for (const [i, position] of BILLBOARD.entries()) {
      h.clock.set(T0 + (startAt + i * 15) * 1000);
      const sample = sampleAt(h.clock, position, { ended: position >= FILM_SECONDS });
      await report(h, frame, sample, frame.frameId === 0 ? snapshotOf(NETFLIX_BROWSE) : null);
      await settle();
    }
  }

  test('back on /browse, a preview that plays to its end adds nothing and ends nothing', async () => {
    const h = harness({ interpret: netflixLike });
    const watch = { tabId: 1, frameId: 0, url: EPISODE_A };
    await playFilm(h, watch, [0, 15, 30, 45, 60, 75, 90, 105], episodeSnapshot(EPISODE_A));
    const before = h.viewings.all().find((v) => v.key === KEY_A);
    expect(before?.state).toBe('open');
    // A pushState back to /browse: the same document, so Chrome's sender.url stays /watch.
    const browse = { tabId: 1, frameId: 0, url: NETFLIX_BROWSE };
    expect(sender(browse).url).toBe(EPISODE_A);
    await billboard(h, browse, 120);
    const after = h.viewings.all().find((v) => v.key === KEY_A);
    expect(after?.ranges).toEqual(before?.ranges);
    expect(after?.contentEnded).toBe(false);
    expect(after?.state).toBe('open');
    expect(h.outbox.entries()).toEqual([]);
    expect(h.gateway.sends).toEqual([]);
  });

  test('a frame inside a page off the player route counts nothing either', async () => {
    const h = harness({ interpret: netflixLike });
    const watch = { tabId: 1, frameId: 0, url: EPISODE_A };
    await playFilm(h, watch, [0, 15, 30, 45, 60, 75, 90, 105], episodeSnapshot(EPISODE_A));
    const before = h.viewings.all().find((v) => v.key === KEY_A);
    // The top frame is on /browse now, and a frame of the same site plays inside it.
    await report(
      h,
      { tabId: 1, frameId: 0, url: NETFLIX_BROWSE },
      null,
      snapshotOf(NETFLIX_BROWSE),
    );
    const inner = {
      tabId: 1,
      frameId: 2,
      url: 'https://www.netflix.com/preview/1',
      tabUrl: NETFLIX_BROWSE,
    };
    await billboard(h, inner, 120);
    const after = h.viewings.all().find((v) => v.key === KEY_A);
    expect(after?.ranges).toEqual(before?.ranges);
    expect(after?.contentEnded).toBe(false);
    expect(h.outbox.entries()).toEqual([]);
  });

  test('on the player route the same samples count (the control)', async () => {
    const h = harness({ interpret: netflixLike });
    const watch = { tabId: 1, frameId: 0, url: EPISODE_A };
    await playFilm(h, watch, [0, 15, 30, 45, 60, 75, 90, 105], episodeSnapshot(EPISODE_A));
    const before = h.viewings.all().find((v) => v.key === KEY_A)?.ranges ?? [];
    await playFilm(h, watch, [120, 135], episodeSnapshot(EPISODE_A), 120);
    const after = h.viewings.all().find((v) => v.key === KEY_A)?.ranges ?? [];
    expect(after).not.toEqual(before);
  });
});

describe('an unchanged snapshot is not interpreted again', () => {
  // The extension stays light on the browser: a report with a snapshot on a module player route
  // would otherwise cost a round trip to the offscreen sandbox, changed or not. A module's
  // `interpret` is pure, so the same snapshot gives the same reading.
  test('the same snapshot and page state are asked once; a changed one is asked again', async () => {
    const h = harness({ interpret: netflixLike });
    const watch = { tabId: 1, frameId: 0, url: EPISODE_A };
    await playFilm(h, watch, [0, 15, 30, 45], episodeSnapshot(EPISODE_A));
    expect(h.interpreter.calls).toHaveLength(1);
    await playFilm(h, watch, [60], episodeSnapshot(EPISODE_A, 'Еп. 3', 'Інша назва'), 60);
    expect(h.interpreter.calls).toHaveLength(2);
    expect(keysOf(h)).toEqual([KEY_A]);
  });

  test('a module that answered nothing is asked again (nothing is kept for it)', async () => {
    const h = harness({ interpret: () => null });
    const watch = { tabId: 1, frameId: 0, url: EPISODE_A };
    await playFilm(h, watch, [0, 15, 30], episodeSnapshot(EPISODE_A));
    expect(h.interpreter.calls).toHaveLength(3);
  });

  test('the same snapshot of the same service in another tab is the same reading', async () => {
    const h = harness({ interpret: netflixLike });
    const snapshot = episodeSnapshot(EPISODE_A);
    await playFilm(h, { tabId: 1, frameId: 0, url: EPISODE_A }, [0, 15], snapshot);
    await playFilm(h, { tabId: 2, frameId: 0, url: EPISODE_A }, [0, 15], snapshot);
    expect(h.interpreter.calls).toHaveLength(1);
  });
});

describe('the address’s parameters on a site without a module', () => {
  const SERIES_SETTINGS = { allowedHosts: ['series.example'] } as const;
  const seriesSnapshot = (url: string): Snapshot =>
    snapshotOf(url, {
      openGraph: { 'og:type': 'video.tv_series', 'og:title': 'Some Show (2020)' },
    });

  test('a name in another case is read: the episode the query names is the viewing', async () => {
    const url = 'https://series.example/watch/221?Season=5&EPISODE=1';
    const h = harness({ settings: SERIES_SETTINGS });
    await playFilm(h, { tabId: 1, frameId: 0, url }, everyFifteen(45), seriesSnapshot(url));
    expect(h.viewings.all()[0]?.reading).toMatchObject({ kind: 'episode', season: 5, episode: 1 });
  });

  test('a value that is not a number is not kept: the snapshot holds only what the reader reads', async () => {
    // A search box's `?s=` beside the episode's `e`.
    const url = 'https://series.example/watch/221?s=some+words&e=2&q=3';
    const h = harness({ settings: SERIES_SETTINGS });
    await playFilm(h, { tabId: 1, frameId: 0, url }, [0], seriesSnapshot(url));
    const answer = await askUi(h, { type: 'ui/capture', tabId: 1 });
    const data = (answer as { data: { fixture: { snapshot: Snapshot } } }).data;
    expect(Object.keys(data.fixture.snapshot.url.query)).toEqual(['e']);
  });
});
