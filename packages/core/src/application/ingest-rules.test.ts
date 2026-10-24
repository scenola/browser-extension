/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The rules that decide which viewing a sample belongs to — one service per viewing, refinement
// on a shown length, a module's identity, the service's own title ids, muted playback, the
// sticky election, stated lengths and other media — driven through `IngestObservation` over the
// in-memory ports. Every expected value comes from the rule, never from running the code.

import { describe, expect, test } from 'vitest';

import { PlayedRanges } from '../domain/coverage';
import type { PlaybackSample } from '../domain/coverage';
import { electFrame } from '../domain/frames';
import type { FrameReport } from '../domain/frames';
import type {
  Field,
  ProviderId,
  ReadingSource,
  ServiceReading,
  StatedIds,
} from '../domain/reading';
import { DAY_MS, MINUTE_MS } from '../domain/time';
import { applySample, newViewing } from '../domain/viewing';
import type { Viewing } from '../domain/viewing';
import { IngestObservation } from './ingest-observation';
import type { ObservationResult } from './ingest-observation';
import type { TabState } from './ports';
import { ReportViewing } from './report-viewing';
import { makeWorld, must } from './test-world';
import type { World } from './test-world';
import { ViewingLock } from './viewing-lock';

// ---------------------------------------------------------------------------------------------
// Test helpers (test infrastructure only)

const STEP_MS = 15_000;

const mod = <T>(value: T): Field<T> => ({ value, confidence: 0.9, source: 'module' });
const gen = <T>(value: T, source: ReadingSource = 'json-ld'): Field<T> => ({
  value,
  confidence: 0.7,
  source,
});

const titleId = (value: string, key = 'videoId'): ProviderId => ({ level: 'title', key, value });
const showId = (value: string, key = 'showId'): ProviderId => ({ level: 'show', key, value });

interface EpisodeSpec {
  readonly show?: string;
  readonly season?: number;
  readonly episode?: number;
  readonly episodeTitle?: string;
  readonly showYear?: number;
  readonly providerIds?: readonly ProviderId[];
  readonly contentEnded?: boolean;
  readonly adPlaying?: boolean;
  readonly contentDurationSeconds?: number;
}

/** A module's reading of an episode. */
function episode(o: EpisodeSpec = {}): ServiceReading {
  return {
    kind: mod('episode'),
    showTitle: mod(o.show ?? 'show'),
    season: mod(o.season ?? 1),
    episode: mod(o.episode ?? 1),
    ...(o.episodeTitle === undefined ? {} : { episodeTitle: mod(o.episodeTitle) }),
    ...(o.showYear === undefined ? {} : { showYear: mod(o.showYear) }),
    ...(o.providerIds === undefined ? {} : { providerIds: o.providerIds }),
    ...(o.contentEnded === undefined ? {} : { contentEnded: o.contentEnded }),
    ...(o.adPlaying === undefined ? {} : { adPlaying: o.adPlaying }),
    ...(o.contentDurationSeconds === undefined
      ? {}
      : { contentDurationSeconds: o.contentDurationSeconds }),
  };
}

/** A module's reading of a film. */
function film(
  title: string,
  o: { year?: number; providerIds?: readonly ProviderId[]; contentDurationSeconds?: number } = {},
): ServiceReading {
  return {
    kind: mod('movie'),
    title: mod(title),
    ...(o.year === undefined ? {} : { year: mod(o.year) }),
    ...(o.providerIds === undefined ? {} : { providerIds: o.providerIds }),
    ...(o.contentDurationSeconds === undefined
      ? {}
      : { contentDurationSeconds: o.contentDurationSeconds }),
  };
}

interface FrameSpec {
  readonly frameId?: number;
  readonly isTop?: boolean;
  /** `null`: a frame that reports no media element. */
  readonly position?: number | null;
  readonly duration?: number | null;
  readonly paused?: boolean;
  readonly ended?: boolean;
  readonly muted?: boolean;
  readonly adPlaying?: boolean;
  readonly visibleArea?: number;
  readonly reading?: ServiceReading | null;
  readonly generic?: readonly ServiceReading[];
}

function sampleAt(at: number, f: FrameSpec): PlaybackSample | null {
  if (f.position === null || f.position === undefined) return null;
  return {
    at,
    position: f.position,
    duration: f.duration === undefined ? 1000 : f.duration,
    paused: f.paused ?? false,
    ended: f.ended ?? false,
    rate: 1,
    adPlaying: f.adPlaying ?? false,
    muted: f.muted ?? false,
    visibleArea: f.visibleArea ?? 1,
  };
}

function frameAt(at: number, f: FrameSpec): FrameReport {
  const frameId = f.frameId ?? 0;
  return {
    frameId,
    isTop: f.isTop ?? frameId === 0,
    sample: sampleAt(at, f),
    reading: f.reading ?? null,
    generic: f.generic ?? [],
  };
}

interface Run {
  readonly serviceId?: string | null;
  readonly tabId?: number;
  readonly ingest?: IngestObservation;
}

/** One observation of the given frames at the clock's time; then the clock moves 15 s on. */
async function see(
  w: World,
  frames: readonly FrameSpec[],
  r: Run = {},
): Promise<ObservationResult> {
  const at = w.clock.now();
  const result = await (r.ingest ?? w.ingest).execute({
    tabId: r.tabId ?? 1,
    incognito: false,
    serviceId: r.serviceId ?? null,
    frames: frames.map((f) => frameAt(at, f)),
  });
  w.clock.advance(STEP_MS);
  return result;
}

/** Continuous playback of one top-frame player from `from` to `to` (inclusive), 15 s apart. */
async function play(
  w: World,
  reading: ServiceReading | null,
  from: number,
  to: number,
  f: Omit<FrameSpec, 'position' | 'reading'> = {},
  r: Run = {},
): Promise<ObservationResult[]> {
  const results: ObservationResult[] = [];
  for (let p = from; p <= to; p += 15) {
    results.push(await see(w, [{ ...f, position: p, reading }], r));
  }
  return results;
}

/** A worker that stopped and started again: new use cases over the same stores. */
function restarted(w: World): IngestObservation {
  const lock = new ViewingLock();
  const report = new ReportViewing({
    viewings: w.viewings,
    outbox: w.outbox,
    history: w.history,
    ids: w.ids,
    clock: w.clock,
    scheduler: w.scheduler,
    lock,
    accountKey: w.accountKey,
  });
  return new IngestObservation({
    viewings: w.viewings,
    settings: w.settings,
    rules: w.rules,
    clock: w.clock,
    ids: w.ids,
    report,
    lock,
    accountKey: w.accountKey,
  });
}

const byKey = (w: World, key: string): Viewing | undefined =>
  w.viewings.all().find((v) => v.key === key);
const keyed = (w: World, key: string): Viewing => must(byKey(w, key));
const coverage = (v: Viewing): number => PlayedRanges.fromJSON(v.ranges).total();
const fresh = (w: World, v: Viewing): Viewing => must(w.viewings.all().find((x) => x.id === v.id));

// ---------------------------------------------------------------------------------------------
// A viewing belongs to one service

describe('a viewing belongs to one service', () => {
  test('a module site keys a title as <service>/<title key>; a site without a module keeps a bare key', async () => {
    // The title keys: `ep:<show>:<season>:<episode>`, `mv:<title>:<year>`.
    const netflix = makeWorld();
    await play(netflix, episode({ season: 1, episode: 2 }), 0, 30, {}, { serviceId: 'netflix' });
    expect(netflix.viewings.all().map((v) => v.key)).toEqual(['netflix/ep:show:1:2']);

    const generic = makeWorld();
    await play(generic, episode({ season: 1, episode: 2 }), 0, 30);
    expect(generic.viewings.all().map((v) => v.key)).toEqual(['ep:show:1:2']);

    const filmOnModule = makeWorld();
    await play(filmOnModule, film('film', { year: 2021 }), 0, 30, {}, { serviceId: 'apple_tv' });
    expect(filmOnModule.viewings.all().map((v) => v.key)).toEqual(['apple_tv/mv:film:2021']);
  });

  test('a title the service names by its own id is keyed svc:<service>:<id>', async () => {
    // The id key: `svc:<service>:<title-level provider value>`.
    const w = makeWorld();
    await play(w, episode({ providerIds: [titleId('81')] }), 0, 30, {}, { serviceId: 'netflix' });
    expect(w.viewings.all().map((v) => v.key)).toEqual(['svc:netflix:81']);
  });

  test('a later sitting of the same title on another service, without ids, is a second partial viewing: nothing is reported', async () => {
    // The rule's accepted cost: two partial viewings.
    const w = makeWorld();
    const e = episode({ season: 1, episode: 2 });
    await play(w, e, 0, 450, {}, { serviceId: 'netflix' });
    await w.viewings.dropTab(1);
    w.clock.advance(DAY_MS);
    // Together the two sittings would cover 930 s of 1000 and reach the end.
    await play(w, e, 450, 990, {}, { serviceId: 'apple_tv', tabId: 2 });

    const keys = w.viewings.all().map((v) => v.key);
    expect(keys.sort()).toEqual(['apple_tv/ep:show:1:2', 'netflix/ep:show:1:2']);
    expect(keyed(w, 'netflix/ep:show:1:2').ranges).toEqual([[15, 450]]);
    expect(w.outbox.entries()).toEqual([]);
  });

  test("another service's reading with its own ids never refines this viewing", async () => {
    // It never joins, refines or ends a viewing, with or without ids.
    const w = makeWorld();
    await play(w, episode({ season: 1, episode: 2 }), 0, 300, {}, { serviceId: 'netflix' });
    const netflix = keyed(w, 'netflix/ep:show:1:2');
    await w.viewings.dropTab(1);
    w.clock.advance(DAY_MS);
    await play(
      w,
      episode({ season: 1, episode: 2, providerIds: [titleId('umc.cmc.zz', 'contentId')] }),
      0,
      300,
      {},
      { serviceId: 'apple_tv', tabId: 2 },
    );
    const after = fresh(w, netflix);
    expect(after.key).toBe('netflix/ep:show:1:2');
    expect(after.reading.providerIds).toBeUndefined();
    expect(after.ranges).toEqual([[15, 300]]);
    expect(keyed(w, 'svc:apple_tv:umc.cmc.zz').serviceId).toBe('apple_tv');
  });

  test("a tab that moves to another service on media of the same length adds nothing to this service's viewing", async () => {
    // Never joined, refined or ended — with ids or without, and whatever the title and the
    // lengths say.
    const w = makeWorld();
    const e = episode({ season: 1, episode: 2 });
    await play(w, e, 0, 300, {}, { serviceId: 'netflix' });
    const netflix = keyed(w, 'netflix/ep:show:1:2');
    // The tab is now on Apple TV, playing the same episode at the same length, where it was.
    await play(w, e, 315, 405, {}, { serviceId: 'apple_tv' });
    expect(fresh(w, netflix).ranges).toEqual([[15, 300]]);
  });

  test("another service's end screen on media of the same length does not end this service's viewing", async () => {
    // Played short of its line, so only an end could close it.
    const w = makeWorld();
    await play(w, episode({ season: 1, episode: 2 }), 0, 600, {}, { serviceId: 'netflix' });
    const netflix = keyed(w, 'netflix/ep:show:1:2');
    await see(w, [{ position: 615, reading: { contentEnded: true } }], { serviceId: 'apple_tv' });
    await see(w, [{ position: 630, ended: true, reading: { contentEnded: true } }], {
      serviceId: 'apple_tv',
    });
    expect(fresh(w, netflix)).toMatchObject({ state: 'open', contentEnded: false });
    expect(w.outbox.entries()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// A refinement is decided only on a length the observation shows

describe('a refinement is decided only on a length the observation shows', () => {
  const yearless = film('film');
  const withYear = film('film', { year: 2021 });

  async function bound(w: World): Promise<Viewing> {
    await play(w, yearless, 0, 300, { duration: 6000 });
    return keyed(w, 'mv:film:');
  }

  test.each([
    ['no duration', { duration: null }],
    ['a duration under 120 s', { duration: 100 }],
    ['an ad', { duration: 6000, adPlaying: true }],
  ] as const)(
    'a finer name seen with %s is held: no re-key, no join, no new viewing',
    async (_label, seen) => {
      // Held: it does not join, does not re-key and does not open a viewing.
      const w = makeWorld();
      const v = await bound(w);
      for (const p of [315, 330, 345, 360]) {
        await see(w, [{ ...seen, position: p, reading: withYear }]);
      }
      expect(w.viewings.all()).toHaveLength(1);
      const after = fresh(w, v);
      expect(after.key).toBe('mv:film:');
      expect(after.reading.year).toBeUndefined();
      expect(after.ranges).toEqual([[15, 300]]);
    },
  );

  test('at a length the observation shows, a finer name re-keys the viewing only once it held still for two observations', async () => {
    const w = makeWorld();
    const v = await bound(w);
    await see(w, [{ position: 315, duration: 6000, reading: withYear }]);
    expect(fresh(w, v).key).toBe('mv:film:');
    await see(w, [{ position: 330, duration: 6000, reading: withYear }]);
    const after = fresh(w, v);
    expect(after.key).toBe('mv:film:2021');
    expect(after.id).toBe(v.id);
    expect(w.viewings.all()).toHaveLength(1);
  });

  test('one stray observation naming a year never renames the viewing', async () => {
    // Two observations to re-key: one stray observation naming another year must not rename the
    // viewing for good.
    const w = makeWorld();
    const v = await bound(w);
    await see(w, [{ position: 315, duration: 6000, reading: withYear }]);
    await play(w, yearless, 330, 600, { duration: 6000 });
    const after = fresh(w, v);
    expect(after.key).toBe('mv:film:');
    expect(after.reading.year).toBeUndefined();
    expect(w.viewings.all()).toHaveLength(1);
  });

  test('two different stated show years never refine: the bound episode keeps its show year and gains no id', async () => {
    const w = makeWorld();
    const NETFLIX = { serviceId: 'netflix' } as const;
    await play(w, episode({ season: 1, episode: 2, showYear: 2008 }), 0, 300, {}, NETFLIX);
    const v = keyed(w, 'netflix/ep:show:1:2');
    const other = episode({ season: 1, episode: 2, showYear: 2013, providerIds: [titleId('X')] });
    await play(w, other, 315, 405, {}, NETFLIX);
    const after = fresh(w, v);
    expect(after.key).toBe('netflix/ep:show:1:2');
    expect(after.reading.showYear).toBe(2008);
    expect(after.reading.providerIds).toBeUndefined();
    expect(byKey(w, 'svc:netflix:X')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// A module's reading decides the identity

describe("a module's reading decides the identity", () => {
  // JSON-LD left from before an in-app navigation: about episode 1, with its ids.
  const staleJsonLd: ServiceReading = {
    kind: gen('episode'),
    showTitle: gen('show'),
    season: gen(1),
    episode: gen(1),
    episodeTitle: gen('pilot'),
    year: gen(2008),
    showYear: gen(2008),
    ids: gen<StatedIds>({ imdb: 'tt0959621' }),
    showIds: gen<StatedIds>({ imdb: 'tt0903747' }),
    contentDurationSeconds: 3480,
  };
  // The module names episode 2 by its id and numbers, and states nothing else.
  const moduleEp2 = episode({ season: 1, episode: 2, providerIds: [titleId('70196253')] });

  test('the generic readers fill no identity field once the module answered: no episode title, year, ids or stated length from stale JSON-LD', async () => {
    // The generic readers fill no identity field — not kind, title, show, numbers, episode
    // title, year or ids — nor the stated length.
    const w = makeWorld();
    const stale = { generic: [staleJsonLd] };
    const results = await play(w, moduleEp2, 0, 960, stale, { serviceId: 'netflix' });
    const v = keyed(w, 'svc:netflix:70196253');
    expect(v.reading).toMatchObject({ kind: 'episode', showTitle: 'show', season: 1, episode: 2 });
    expect(v.reading.episodeTitle).toBeUndefined();
    expect(v.reading.year).toBeUndefined();
    expect(v.reading.showYear).toBeUndefined();
    expect(v.reading.ids).toBeUndefined();
    expect(v.reading.showIds).toBeUndefined();
    // The element's 1000 s, not the stale page's 3480 s.
    expect(v.durationSeconds).toBe(1000);
    expect(results.filter((r) => r.reported)).toHaveLength(1);

    const body = must(w.outbox.entries()[0]).body;
    expect(body.episode_number).toBe(2);
    expect(body.title).toBeUndefined();
    expect(body.ids?.imdb).toBeUndefined();
    expect(body.show?.ids?.imdb).toBeUndefined();
    expect(body.show?.year).toBeUndefined();
  });

  test('a module that answers null leaves the identity to the generic readers', async () => {
    // The generic readers serve sites without a module, and a module that answers `null`.
    const w = makeWorld();
    await play(w, null, 0, 30, { generic: [staleJsonLd] }, { serviceId: 'netflix' });
    const v = keyed(w, 'netflix/ep:show:1:1');
    expect(v.reading).toMatchObject({ season: 1, episode: 1, episodeTitle: 'pilot' });
  });

  test("the top frame's module reading decides the identity of an embedded player whose frame has only generic readings", async () => {
    // The module answered when either the player frame's or the top frame's did.
    const w = makeWorld();
    for (const p of [0, 15, 30, 45]) {
      await see(
        w,
        [
          { frameId: 0, isTop: true, position: null, reading: moduleEp2 },
          { frameId: 7, isTop: false, position: p, reading: null, generic: [staleJsonLd] },
        ],
        { serviceId: 'netflix' },
      );
    }
    const v = keyed(w, 'svc:netflix:70196253');
    expect(v.reading.episode).toBe(2);
    expect(v.reading.episodeTitle).toBeUndefined();
    expect(v.reading.ids).toBeUndefined();
    expect(v.ranges).toEqual([[15, 45]]);
  });

  test("the player frame's module reading decides the identity over stale JSON-LD in the top frame", async () => {
    const w = makeWorld();
    for (const p of [0, 15, 30]) {
      await see(
        w,
        [
          { frameId: 0, isTop: true, position: null, reading: null, generic: [staleJsonLd] },
          { frameId: 7, isTop: false, position: p, reading: moduleEp2 },
        ],
        { serviceId: 'netflix' },
      );
    }
    const v = keyed(w, 'svc:netflix:70196253');
    expect(v.reading.episode).toBe(2);
    expect(v.reading.ids).toBeUndefined();
  });

  test('what a generic reading says of the moment still flows when the module states nothing of it', async () => {
    // `contentEnded` and `adPlaying` name no item and still flow: the module's when it states
    // it, else the first generic reading's.
    const w = makeWorld();
    await play(w, moduleEp2, 0, 300, {}, { serviceId: 'netflix' });
    const v = keyed(w, 'svc:netflix:70196253');
    await see(w, [{ position: 315, reading: moduleEp2, generic: [{ contentEnded: true }] }], {
      serviceId: 'netflix',
    });
    expect(fresh(w, v).contentEnded).toBe(true);
  });

  test("the module's own statement of the moment wins over a generic one", async () => {
    const w = makeWorld();
    const stated = episode({
      season: 1,
      episode: 2,
      providerIds: [titleId('70196253')],
      contentEnded: false,
    });
    await play(w, stated, 0, 300, {}, { serviceId: 'netflix' });
    const v = keyed(w, 'svc:netflix:70196253');
    await see(w, [{ position: 315, reading: stated, generic: [{ contentEnded: true }] }], {
      serviceId: 'netflix',
    });
    expect(fresh(w, v).contentEnded).toBe(false);
  });

  test('an in-app move: a later observation whose module answers null and whose JSON-LD names episode 1 neither renames nor splits the bound episode 2 on its media', async () => {
    // Stale JSON-LD must not give episode 2 the numbers of episode 1: the bound media's samples
    // are the bound viewing's, and nothing else starts from them.
    const w = makeWorld();
    const appleEp2 = episode({
      season: 1,
      episode: 2,
      providerIds: [titleId('umc.cmc.x', 'contentId')],
    });
    await play(w, appleEp2, 0, 300, {}, { serviceId: 'apple_tv' });
    const v = keyed(w, 'svc:apple_tv:umc.cmc.x');
    await play(w, null, 315, 405, { generic: [staleJsonLd] }, { serviceId: 'apple_tv' });
    const after = fresh(w, v);
    expect(after.key).toBe('svc:apple_tv:umc.cmc.x');
    expect(after.reading.episode).toBe(2);
    expect(after.reading.ids).toBeUndefined();
    expect(w.viewings.all()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// A different title-level id is a different identity, even without a kind

describe('a different own-service title id is a different identity', () => {
  const a = episode({ season: 1, episode: 1, providerIds: [titleId('A')] });
  const bWithKind = episode({ season: 1, episode: 2, providerIds: [titleId('B')] });
  const bKindless: ServiceReading = { providerIds: [titleId('B')], contentEnded: false };
  const NETFLIX = { serviceId: 'netflix' } as const;

  /** Episode A played to `to`, short of its line, so it stays open for what follows. */
  async function boundA(w: World, to = 600): Promise<Viewing> {
    await play(w, a, 0, to, {}, NETFLIX);
    return keyed(w, 'svc:netflix:A');
  }

  test('a reading of another id, with a kind, on what is still the bound media adds no sample, ends nothing and opens nothing', async () => {
    // It never adds its samples to that viewing, never ends it and never renames it, not even
    // on what may still be its media; nothing opens from the bound media's samples.
    const w = makeWorld();
    const v = await boundA(w);
    await play(w, bWithKind, 615, 645, {}, NETFLIX);
    const endScreen: ServiceReading = { providerIds: [titleId('B')], contentEnded: true };
    await see(w, [{ position: 660, reading: endScreen }], NETFLIX);
    const after = fresh(w, v);
    expect(after.ranges).toEqual([[15, 600]]);
    expect(after.contentEnded).toBe(false);
    expect(after.key).toBe('svc:netflix:A');
    expect(byKey(w, 'svc:netflix:B')).toBeUndefined();
    expect(w.outbox.entries()).toEqual([]);
  });

  test('a kindless reading of another id adds no sample to the bound viewing and opens nothing, across a worker restart', async () => {
    const w = makeWorld();
    const v = await boundA(w, 600);
    await play(w, bKindless, 615, 660, {}, NETFLIX);
    const ingest = restarted(w);
    await play(w, bKindless, 675, 750, {}, { ...NETFLIX, ingest });
    expect(fresh(w, v).ranges).toEqual([[15, 600]]);
    expect(w.viewings.all()).toHaveLength(1);
  });

  test('a kindless reading of another id on its own media opens nothing, however long it holds still', async () => {
    const w = makeWorld();
    await boundA(w, 600);
    await play(w, bKindless, 0, 300, { duration: 1100 }, NETFLIX);
    expect(w.viewings.all()).toHaveLength(1);
  });

  test('a reading of another id with a kind opens its own viewing on its own media, empty', async () => {
    // With a kind it binds like any new identity once it held still.
    const w = makeWorld();
    const v = await boundA(w, 600);
    await play(w, bWithKind, 0, 15, { duration: 1100 }, NETFLIX);
    expect(keyed(w, 'svc:netflix:B').ranges).toEqual([]);
    expect(fresh(w, v).ranges).toEqual([[15, 600]]);
  });

  test("a kindless reading of the bound viewing's own id still goes to it (the controls are hidden)", async () => {
    // Only a *different* id is another identity: no kind and no other title's id is a reading
    // that names nothing of its own, and it goes to the tab's viewing.
    const w = makeWorld();
    const v = await boundA(w, 450);
    await play(w, { providerIds: [titleId('A')], contentEnded: false }, 465, 540, {}, NETFLIX);
    expect(fresh(w, v).ranges).toEqual([[15, 540]]);
  });

  test('an id gained by refinement, then a third id on the same media: the refined viewing keeps its id and its ranges', async () => {
    // A re-key after two observations; another id adds no samples and opens nothing on the
    // bound media.
    const w = makeWorld();
    const plain = episode({ season: 1, episode: 1 });
    await play(w, plain, 0, 300, {}, NETFLIX);
    const v = keyed(w, 'netflix/ep:show:1:1');
    const as81 = episode({ season: 1, episode: 1, providerIds: [titleId('81')] });
    await play(w, as81, 315, 330, {}, NETFLIX);
    expect(fresh(w, v).key).toBe('svc:netflix:81');
    const before = fresh(w, v).ranges;

    const as82 = episode({ season: 1, episode: 1, providerIds: [titleId('82')] });
    await play(w, as82, 345, 405, {}, NETFLIX);
    const after = fresh(w, v);
    expect(after.key).toBe('svc:netflix:81');
    expect(after.ranges).toEqual(before);
    expect(byKey(w, 'svc:netflix:82')).toBeUndefined();

    // On its own media, held still and with sound, 82 opens.
    await play(w, as82, 0, 15, { duration: 1100 }, NETFLIX);
    expect(keyed(w, 'svc:netflix:82').id).not.toBe(v.id);
  });
});

// ---------------------------------------------------------------------------------------------
// A muted element never starts a viewing, except the next episode after sound

describe('a muted element never starts a viewing', () => {
  const NETFLIX = { serviceId: 'netflix' } as const;
  /** The next media in the player: another length, muted. */
  const MUTED = { muted: true, duration: 1100 } as const;
  const e1 = episode({ episode: 1 });
  const e2 = episode({ episode: 2 });

  test('muted playback opens nothing, however large the player', async () => {
    const w = makeWorld();
    await play(w, film('film'), 0, 300, { muted: true, visibleArea: 1 });
    expect(w.viewings.all()).toEqual([]);
  });

  test('observations made while muted count towards holding still: the first sample with sound binds, and the sitting starts there', async () => {
    // So the first unmuted sample binds at once, and the sitting starts from it.
    const w = makeWorld();
    await play(w, film('film'), 0, 45, { muted: true });
    const bound = await see(w, [{ position: 60, reading: film('film') }]);
    expect(must(bound.viewing).ranges).toEqual([]);
    await see(w, [{ position: 75, reading: film('film') }]);
    expect(keyed(w, 'mv:film:').ranges).toEqual([[60, 75]]);
  });

  test('a viewing started with sound keeps counting after the person mutes it, and reports', async () => {
    const w = makeWorld();
    await play(w, episode(), 0, 450);
    const results = await play(w, episode(), 465, 960, { muted: true });
    const v = keyed(w, 'ep:show:1:1');
    expect(results.filter((r) => r.reported)).toHaveLength(1);
    // Recorded at the 645 s sample, a muted one, whose 630 s played reach the 616 s line: the
    // muted samples up to there are counted.
    expect(coverage(v)).toBe(630);
  });

  test('the next episode that autoplays muted on the same player after sound opens and counts', async () => {
    // "The same player": the same frame, within 75 s, an episode of the tab's show on the same
    // service.
    const w = makeWorld();
    await play(w, e1, 0, 450, {}, NETFLIX);
    await play(w, e1, 465, 990, { muted: true }, NETFLIX);
    // Autoplay: the next episode loads in the same frame, still muted.
    const results = await play(w, e2, 0, 1050, MUTED, NETFLIX);
    const next = keyed(w, 'netflix/ep:show:1:2');
    // Bound at 15 s and counted to its line, 678 s of its 968 s story: 690 s at the 705 s sample.
    expect(coverage(next)).toBe(690);
    expect(results.filter((r) => r.reported)).toHaveLength(1);
  });

  test('the mark of the player heard with sound survives a worker restart between the two episodes', async () => {
    // The mark is kept in the persisted tab state.
    const w = makeWorld();
    await play(w, e1, 0, 450, {}, NETFLIX);
    await play(w, e1, 465, 990, { muted: true }, NETFLIX);
    const ingest = restarted(w);
    await play(w, e2, 0, 60, MUTED, { ...NETFLIX, ingest });
    expect(keyed(w, 'netflix/ep:show:1:2').ranges).not.toEqual([]);
  });

  test('a muted trailer of a film in the same frame, right after an episode played with sound, opens nothing', async () => {
    // The core sees a frame, not an element: the show is what tells a trailer from the next
    // episode.
    const w = makeWorld();
    await play(w, e1, 0, 450, {}, NETFLIX);
    await play(w, film('trailer'), 0, 150, { muted: true, duration: 150 }, NETFLIX);
    expect(w.viewings.all().map((v) => v.key)).toEqual(['netflix/ep:show:1:1']);
  });

  test('a muted autoplay into an episode of another show opens nothing', async () => {
    const w = makeWorld();
    await play(w, e1, 0, 450, {}, NETFLIX);
    await play(w, episode({ show: 'another', episode: 1 }), 0, 150, MUTED, NETFLIX);
    expect(w.viewings.all()).toHaveLength(1);
  });

  test('a muted next episode after the player stopped playing for more than 75 s opens nothing', async () => {
    const w = makeWorld();
    await play(w, e1, 0, 450, {}, NETFLIX);
    w.clock.advance(90_000);
    await play(w, e2, 0, 150, MUTED, NETFLIX);
    expect(w.viewings.all()).toHaveLength(1);
  });

  test('a muted next episode in another frame opens nothing', async () => {
    const w = makeWorld();
    await play(w, e1, 0, 450, {}, NETFLIX);
    await play(w, e2, 0, 150, { ...MUTED, frameId: 4, isTop: true }, NETFLIX);
    expect(w.viewings.all()).toHaveLength(1);
  });

  test('a muted next episode on another service opens nothing', async () => {
    const w = makeWorld();
    await play(w, e1, 0, 450, {}, NETFLIX);
    await play(w, e2, 0, 150, MUTED, { serviceId: 'apple_tv' });
    expect(w.viewings.all()).toHaveLength(1);
  });

  test("the show's own ids decide when both state one: the same name under another show id is another show", async () => {
    // `sameShowOnService`: show-level ids when both state one, else the normalised show titles.
    const w = makeWorld();
    const first = episode({ episode: 1, providerIds: [titleId('E1'), showId('S1')] });
    const next = episode({ episode: 2, providerIds: [titleId('E2'), showId('S9')] });
    await play(w, first, 0, 450, {}, NETFLIX);
    await play(w, next, 0, 150, MUTED, NETFLIX);
    expect(byKey(w, 'svc:netflix:E2')).toBeUndefined();
  });

  test("the show's own ids decide when both state one: another spelling of the name under the same show id is the same show", async () => {
    const w = makeWorld();
    const first = episode({ episode: 1, providerIds: [titleId('E1'), showId('S1')] });
    const next = episode({
      show: 'show: the series',
      episode: 2,
      providerIds: [titleId('E2'), showId('S1')],
    });
    await play(w, first, 0, 450, {}, NETFLIX);
    await play(w, next, 0, 60, MUTED, NETFLIX);
    expect(byKey(w, 'svc:netflix:E2')).toBeDefined();
  });

  test('show years that disagree are two shows: a muted autoplay into the other one opens nothing', async () => {
    const w = makeWorld();
    await play(w, episode({ episode: 1, showYear: 2004 }), 0, 450, {}, NETFLIX);
    await play(w, episode({ episode: 2, showYear: 1978 }), 0, 150, MUTED, NETFLIX);
    expect(w.viewings.all()).toHaveLength(1);
  });

  test('a muted next episode in a small player opens but is not reported while it stays muted and small', async () => {
    // A viewing opened that way, muted, is engaged only once its player fills ENGAGED_AREA of
    // the viewport or is unmuted.
    const w = makeWorld();
    await play(w, e1, 0, 450, {}, NETFLIX);
    const results = await play(w, e2, 0, 1095, { ...MUTED, visibleArea: 0.1 }, NETFLIX);
    expect(byKey(w, 'netflix/ep:show:1:2')).toBeDefined();
    expect(results.filter((r) => r.reported)).toHaveLength(0);
  });

  test('a stored tab state whose sound mark, sitting frame and sitting length are not those is no mark (no throw), so muted playback opens nothing', async () => {
    // Storage is hostile: a stored value that is not a frame id, a length or a mark is none.
    const w = makeWorld();
    await play(w, e1, 0, 300, {}, NETFLIX);
    const tab = must(await w.viewings.tabState(1));
    const junk = { sound: 'x', sittingFrameId: 'y', sittingLength: 'z' };
    await w.viewings.putTabState({ ...tab, ...junk } as unknown as TabState);
    await play(w, e2, 0, 150, MUTED, NETFLIX);
    expect(w.viewings.all()).toHaveLength(1);
  });
});

describe('the election sticks to the open sitting', () => {
  const at = 1_000_000;
  const muted = (frameId: number, visibleArea: number, paused = false): FrameReport =>
    frameAt(at, { frameId, isTop: frameId === 0, position: 100, muted: true, visibleArea, paused });

  test("the open sitting's muted frame wins over a larger muted preview", () => {
    const elected = electFrame([muted(0, 0.3), muted(2, 1)], { sittingFrameId: 0 });
    expect(elected?.player.frameId).toBe(0);
  });

  test("the open sitting's paused frame wins over a playing muted preview", () => {
    // The sitting's frame wins over every muted frame, playing or paused.
    const elected = electFrame([muted(0, 0.3, true), muted(2, 1)], { sittingFrameId: 0 });
    expect(elected?.player.frameId).toBe(0);
  });

  test('without an open sitting, the larger muted frame is elected', () => {
    // The largest visible player is elected; the open sitting is the only exception.
    const elected = electFrame([muted(0, 0.3), muted(2, 1)], { sittingFrameId: null });
    expect(elected?.player.frameId).toBe(2);
  });

  test("an unmuted playing frame still comes before the sitting's muted frame", () => {
    const loud = frameAt(at, { frameId: 2, isTop: false, position: 100, visibleArea: 0.2 });
    const elected = electFrame([muted(0, 0.9), loud], { sittingFrameId: 0 });
    expect(elected?.player.frameId).toBe(2);
  });

  test('a person who mutes the viewing beside a larger muted preview keeps its coverage', async () => {
    // The election is sticky, and muting keeps counting.
    const w = makeWorld();
    const f = film('film');
    await play(w, f, 0, 300, { visibleArea: 0.3 });
    for (let p = 315; p <= 405; p += 15) {
      await see(w, [
        { frameId: 0, position: p, reading: f, muted: true, visibleArea: 0.3 },
        { frameId: 2, isTop: false, position: p - 300, duration: 150, muted: true, visibleArea: 1 },
      ]);
    }
    expect(keyed(w, 'mv:film:').ranges).toEqual([[15, 405]]);
  });

  test('a muted preview playing beside the paused viewing changes nothing, however long, and its end ends nothing', async () => {
    // The sitting's frame wins over every muted frame, playing or paused, so the preview never
    // takes over.
    const w = makeWorld();
    const f = film('film');
    const small = { visibleArea: 0.3 };
    await play(w, f, 0, 300, small);
    const v = keyed(w, 'mv:film:');
    for (let i = 0; i < 12; i += 1) {
      await see(w, [
        { ...small, frameId: 0, position: 300, paused: true, reading: f },
        { frameId: 2, isTop: false, position: i * 12, duration: 150, muted: true },
      ]);
    }
    await see(w, [
      { ...small, frameId: 0, position: 300, paused: true, reading: f },
      { frameId: 2, isTop: false, position: 150, duration: 150, muted: true, ended: true },
    ]);
    expect(fresh(w, v)).toMatchObject({ ranges: [[15, 300]], contentEnded: false, state: 'open' });
  });
});

// ---------------------------------------------------------------------------------------------
// A stated content length under 120 s is unknown

describe('a stated content length under MIN_CONTENT_SECONDS is unknown, not trusted', () => {
  test('a module stating 1 s throughout: the element length stands and the viewing reports', async () => {
    // One bad statement must not make a viewing unreportable.
    const w = makeWorld();
    const results = await play(w, film('film', { contentDurationSeconds: 1 }), 0, 960);
    expect(keyed(w, 'mv:film:').durationSeconds).toBe(1000);
    expect(results.filter((r) => r.reported)).toHaveLength(1);
  });

  test('119 s is unknown; 120 s is a statement', async () => {
    // MIN_CONTENT_SECONDS is 120.
    const under = makeWorld();
    await play(under, film('film', { contentDurationSeconds: 119 }), 0, 60);
    expect(keyed(under, 'mv:film:').durationSeconds).toBe(1000);

    const at = makeWorld();
    await play(at, film('film', { contentDurationSeconds: 120 }), 0, 60);
    expect(keyed(at, 'mv:film:').durationSeconds).toBe(120);
  });

  test('a good statement, then a tiny one: the good one stands', async () => {
    // The tiny one is no statement, so the last good one stands.
    const w = makeWorld();
    await play(w, film('film', { contentDurationSeconds: 3000 }), 0, 60, { duration: 3100 });
    await play(w, film('film', { contentDurationSeconds: 60 }), 75, 120, { duration: 3100 });
    expect(keyed(w, 'mv:film:').durationSeconds).toBe(3000);
  });

  test('a stored statement under 120 s is held to the same rule', () => {
    const v = must(
      newViewing({
        id: 'v',
        serviceId: null,
        reading: { kind: 'movie', title: 'film', sources: ['module'] },
        at: 0,
        incognito: false,
      }),
    );
    const stored: Viewing = { ...v, statedDurationSeconds: 5, durationSeconds: 5 };
    const s = (at: number, position: number): PlaybackSample => ({
      at,
      position,
      duration: 1000,
      paused: false,
      ended: false,
      rate: 1,
      adPlaying: false,
      muted: false,
      visibleArea: 1,
    });
    const reading = { kind: 'movie', title: 'film', sources: ['module'] } as const;
    const once = applySample(stored, null, s(0, 0), reading);
    const twice = applySample(once, s(0, 0), s(15_000, 15), reading);
    expect(twice.durationSeconds).toBe(1000);
  });
});

// ---------------------------------------------------------------------------------------------
// A sample from other media adds nothing

describe('a sample from other media adds nothing', () => {
  // 2 % of 6000 s is 120 s; 6130 and 5870 are outside it whether the share is taken of the
  // sitting's length or of the longer one (it is the longer).
  test.each([
    [1000, 1060, true],
    [1000, 1061, false],
    [1000, 939, false],
    [6000, 6120, true],
    [6000, 6130, false],
    [6000, 5880, true],
    [6000, 5870, false],
  ])(
    'a sitting at %i s, a sample at %i s: adds coverage = %s (max of 60 s and 2 per cent)',
    async (length, other, adds) => {
      // Other media: the lengths disagree by more than max(60 s, 2 %).
      const w = makeWorld();
      await play(w, film('film'), 0, 300, { duration: length });
      const v = keyed(w, 'mv:film:');
      await see(w, [{ position: 315, duration: other, reading: film('film') }]);
      expect(fresh(w, v).ranges).toEqual(adds ? [[15, 315]] : [[15, 300]]);
    },
  );

  test("a sample of other media's length ends nothing, its element's `ended` included", async () => {
    const w = makeWorld();
    await play(w, film('film'), 0, 300);
    const v = keyed(w, 'mv:film:');
    await see(w, [{ position: 140, duration: 150, ended: true, reading: film('film') }]);
    await see(w, [{ position: 150, duration: 150, ended: true, reading: { contentEnded: true } }]);
    expect(fresh(w, v)).toMatchObject({ contentEnded: false, ranges: [[15, 300]] });
  });

  test('a preview with sound in another frame, beside the paused main player, adds nothing and ends nothing, however long', async () => {
    const w = makeWorld();
    const f = film('film');
    await play(w, f, 0, 300);
    const v = keyed(w, 'mv:film:');
    for (let p = 0; p <= 150; p += 15) {
      await see(w, [
        { frameId: 0, position: 300, paused: true, reading: f },
        { frameId: 3, isTop: false, position: p, duration: 150 },
      ]);
    }
    await see(w, [
      { frameId: 0, position: 300, paused: true, reading: f },
      { frameId: 3, isTop: false, position: 150, duration: 150, ended: true },
    ]);
    expect(fresh(w, v)).toMatchObject({ ranges: [[15, 300]], contentEnded: false });
  });

  test('the element is compared with the element, never with a stated length', async () => {
    // A stitched stream's element runs longer than the content it states.
    const w = makeWorld();
    await play(w, film('film', { contentDurationSeconds: 2700 }), 0, 300, { duration: 3000 });
    expect(keyed(w, 'mv:film:').ranges).toEqual([[15, 300]]);
  });

  test('after a gap longer than 75 s, media of another length is a new sitting and counts', async () => {
    // Past the gap, a sample of another length starts a new sitting and its length becomes the
    // sitting's.
    const w = makeWorld();
    await play(w, film('film'), 0, 300);
    const v = keyed(w, 'mv:film:');
    w.clock.advance(2 * MINUTE_MS);
    await play(w, film('film'), 315, 360, { duration: 1100 });
    expect(coverage(fresh(w, v))).toBeGreaterThan(285);
  });

  test("an ad the module's reading reports adds no coverage and its end ends nothing", async () => {
    // Ad time is excluded when the service module reports it: an ad never finishes a viewing,
    // nor does it add coverage.
    const w = makeWorld();
    await play(w, film('film'), 0, 300, {}, { serviceId: 'apple_tv' });
    const v = keyed(w, 'apple_tv/mv:film:');
    const promo: ServiceReading = {
      adPlaying: true,
      ids: mod<StatedIds>({}),
      showIds: mod<StatedIds>({}),
    };
    await play(w, promo, 315, 405, {}, { serviceId: 'apple_tv' });
    await see(w, [{ position: 420, ended: true, reading: promo }], { serviceId: 'apple_tv' });
    expect(fresh(w, v)).toMatchObject({ ranges: [[15, 300]], contentEnded: false });
  });
});
