/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Only the viewing's own media advances or ends it, driven through `IngestObservation` over the
// in-memory ports: ad time, an element that is not the viewing's media, coverage up to a pause,
// and the credits signal's first position. Real cases — a pre-roll in its own element that once
// recorded an episode half-watched, Netflix's billboard trailer after going back to browse —
// are regression tests here. Every expected value comes from the rules, never from running the
// code.

import { describe, expect, test } from 'vitest';

import { PlayedRanges } from '../domain/coverage';
import type { PlaybackSample } from '../domain/coverage';
import type { FrameReport } from '../domain/frames';
import type { Field, MergedReading, ProviderId, ServiceReading } from '../domain/reading';
import { MINUTE_MS } from '../domain/time';
import { applySample, newViewing, storyOf } from '../domain/viewing';
import type { Viewing } from '../domain/viewing';
import { makeWorld, must } from './test-world';
import type { World } from './test-world';

// ---------------------------------------------------------------------------------------------
// Test helpers (test infrastructure only)

const gen = <T>(value: T): Field<T> => ({ value, confidence: 0.7, source: 'json-ld' });
const mod = <T>(value: T): Field<T> => ({ value, confidence: 0.95, source: 'module' });

/** What a page's JSON-LD says on a site without a module: an episode. */
const PAGE_EPISODE: ServiceReading = {
  kind: gen('episode'),
  showTitle: gen('Frieren'),
  season: gen(1),
  episode: gen(3),
  episodeTitle: gen('Killing Magic'),
};
/** …and a film. */
const PAGE_FILM: ServiceReading = { kind: gen('movie'), title: gen('Arrival'), year: gen(2016) };

const NETFLIX_ID: ProviderId = { level: 'title', key: 'videoId', value: '80100175' };
/** The Netflix module's reading of an episode on its player route. */
const NETFLIX_EPISODE: ServiceReading = {
  kind: mod('episode'),
  showTitle: mod('Dark'),
  season: mod(1),
  episode: mod(4),
  providerIds: [NETFLIX_ID],
};

const STEP_MS = 15_000;

function sampleAt(w: World, o: Partial<PlaybackSample>): PlaybackSample {
  return {
    at: w.clock.now(),
    position: 0,
    duration: 1440,
    paused: false,
    ended: false,
    rate: 1,
    adPlaying: false,
    muted: false,
    visibleArea: 0.8,
    ...o,
  };
}

/** One observation of a site without a module whose page names `page`; the clock moves on. */
async function onPage(
  w: World,
  o: Partial<PlaybackSample>,
  page: ServiceReading,
  advanceMs = STEP_MS,
  frames?: (sample: PlaybackSample) => FrameReport[],
): Promise<boolean> {
  const sample = sampleAt(w, o);
  const result = await w.ingest.execute({
    tabId: 1,
    incognito: false,
    serviceId: null,
    frames: frames?.(sample) ?? [
      { frameId: 0, isTop: true, sample, reading: null, generic: [page] },
    ],
  });
  w.clock.advance(advanceMs);
  return result.reported;
}

/** One observation of a module site (one top frame); the clock moves on. */
async function onService(
  w: World,
  serviceId: string,
  o: Partial<PlaybackSample>,
  reading: ServiceReading | null,
  advanceMs = STEP_MS,
): Promise<boolean> {
  const sample = sampleAt(w, o);
  const result = await w.ingest.execute({
    tabId: 1,
    incognito: false,
    serviceId,
    frames: [{ frameId: 0, isTop: true, sample, reading, generic: [] }],
  });
  w.clock.advance(advanceMs);
  return result.reported;
}

/**
 * Plays `from`..`to` in 15-s steps of one `duration`-long element on a page naming `page`;
 * the first position that recorded the viewing, or `null`.
 */
async function playPage(
  w: World,
  from: number,
  to: number,
  duration: number,
  page: ServiceReading,
): Promise<number | null> {
  let reportedAt: number | null = null;
  for (let p = from; p <= to; p += 15) {
    const reported = await onPage(w, { position: p, duration }, page);
    if (reported && reportedAt === null) reportedAt = p;
  }
  return reportedAt;
}

/** The same on a module site, with the module's `reading` on every observation. */
async function playService(
  w: World,
  serviceId: string,
  from: number,
  to: number,
  duration: number,
  reading: ServiceReading | null,
): Promise<void> {
  for (let p = from; p <= to; p += 15) {
    await onService(w, serviceId, { position: p, duration }, reading);
  }
}

const only = (w: World): Viewing => {
  expect(w.viewings.all()).toHaveLength(1);
  return must(w.viewings.all()[0]);
};

const furthest = (v: Viewing): number => PlayedRanges.fromJSON(v.ranges).furthest();

/**
 * The story's end where nothing says where the credits start:
 * `duration − min(12 % of duration, 20 min)`, spelled here from the rule, not imported.
 */
const estimatedCreditsStart = (duration: number): number =>
  duration - Math.min(0.12 * duration, 20 * 60);

// ---------------------------------------------------------------------------------------------
// An element that is not the viewing's media ends nothing and adds nothing

describe('media under 120 s is ad time — it adds no coverage, ends nothing and opens nothing', () => {
  test('a pre-roll in its own element ends before the episode; the episode is recorded at its line, not before', async () => {
    // Content is at least 120 s (no live streams, previews or ads), and a viewing is recorded
    // once the story seconds played reach the line.
    const w = makeWorld();
    await onPage(w, { position: 0, duration: 30 }, PAGE_EPISODE);
    await onPage(w, { position: 15, duration: 30 }, PAGE_EPISODE);
    const preRollEnd = { position: 30, duration: 30, paused: true, ended: true };
    await onPage(w, preRollEnd, PAGE_EPISODE, 1_000);
    expect(w.outbox.entries()).toEqual([]);

    // The story ends at 1440 − min(172.8, 1200) = 1267.2 s: 1267 whole seconds, whose 70 % line
    // is 887 s. The page held still through the pre-roll, so the episode binds at its first
    // sample and has played 900 s at the 900 s one.
    expect(estimatedCreditsStart(1440)).toBeCloseTo(1267.2, 6);
    expect(await playPage(w, 0, 1440, 1440, PAGE_EPISODE)).toBe(900);
    expect(w.outbox.entries()).toHaveLength(1);
    expect(only(w).durationSeconds).toBe(1440);
  });

  async function midRoll(w: World): Promise<void> {
    await playPage(w, 0, 780, 1440, PAGE_EPISODE);
    await onPage(w, { position: 781, duration: 1440, paused: true }, PAGE_EPISODE, 1_000);
    await onPage(w, { position: 0, duration: 30 }, PAGE_EPISODE);
    await onPage(w, { position: 15, duration: 30 }, PAGE_EPISODE);
    await onPage(w, { position: 30, duration: 30, paused: true, ended: true }, PAGE_EPISODE);
  }

  test('a mid-roll ad in its own element ends while the episode is paused: nothing is recorded, nothing ends', async () => {
    // Ad time is excluded, and the ad's end is not the content's.
    const w = makeWorld();
    await midRoll(w);
    expect(w.outbox.entries()).toEqual([]);
    expect(only(w)).toMatchObject({ state: 'open', contentEnded: false });
    expect(furthest(only(w))).toBe(781);
  });

  test('after a mid-roll, the episode resumes and is recorded at its line', async () => {
    // The ad's samples are nobody's, so the resume continues the episode's own timeline. Before
    // the ad, 766 s were played (bound at 15 s, paused at 781 s); the 887 s line needs 121 s
    // more, so 781 + 15k: the first at or past 902 is 916.
    const w = makeWorld();
    await midRoll(w);
    expect(await playPage(w, 781, 1440, 1440, PAGE_EPISODE)).toBe(916);
    expect(w.outbox.entries()).toHaveLength(1);
  });

  test('the film paused (its frame silent), a muted 30-s preview in another frame plays and ends: nothing ends', async () => {
    // Never a muted autoplay preview.
    const w = makeWorld();
    await playPage(w, 0, 4200, 6960, PAGE_FILM);
    await onPage(w, { position: 4201, duration: 6960, paused: true }, PAGE_FILM, 1_000);
    const preview = (sample: PlaybackSample): FrameReport[] => [
      { frameId: 0, isTop: true, sample: null, reading: null, generic: [PAGE_FILM] },
      {
        frameId: 3,
        isTop: false,
        sample: { ...sample, muted: true, visibleArea: 0.2 },
        reading: null,
        generic: [],
      },
    ];
    await onPage(w, { position: 0, duration: 30 }, PAGE_FILM, STEP_MS, preview);
    await onPage(w, { position: 15, duration: 30 }, PAGE_FILM, STEP_MS, preview);
    const previewEnd = { position: 30, duration: 30, paused: true, ended: true };
    await onPage(w, previewEnd, PAGE_FILM, STEP_MS, preview);

    expect(w.outbox.entries()).toEqual([]);
    expect(only(w)).toMatchObject({ state: 'open', contentEnded: false });
    expect(furthest(only(w))).toBe(4201);
  });

  test('Netflix, back to /browse at once, a 90-s billboard trailer ends: the half-watched episode is not recorded', async () => {
    // /browse is no player route, so the core sees no reading there. The episode's 1185 s played
    // are short of its 1664 s line (70 % of its 2376 s story).
    const w = makeWorld();
    await playService(w, 'netflix', 0, 1200, 2700, NETFLIX_EPISODE);
    w.clock.advance(5_000);
    await playService(w, 'netflix', 0, 75, 90, null);
    await onService(w, 'netflix', { position: 90, duration: 90, paused: true, ended: true }, null);

    expect(w.outbox.entries()).toEqual([]);
    expect(only(w)).toMatchObject({ key: 'svc:netflix:80100175', contentEnded: false });
  });

  test('a 119-s element playing with sound opens nothing, however long; a 120-s one is content', async () => {
    // Content has a finite duration of at least 120 s (MIN_CONTENT_SECONDS).
    const short = makeWorld();
    await playPage(short, 0, 105, 119, PAGE_FILM);
    expect(short.viewings.all()).toEqual([]);

    const content = makeWorld();
    await playPage(content, 0, 45, 120, PAGE_FILM);
    expect(content.viewings.all()).toHaveLength(1);
  });

  test('ad time after the sitting lapsed adds nothing to the bound viewing', async () => {
    // Ad time is excluded. Past 75 s the sitting's length no longer refuses another length; the
    // ad-time rule still does.
    const w = makeWorld();
    await playPage(w, 1000, 1300, 6000, PAGE_FILM);
    const before = only(w).ranges;
    w.clock.advance(2 * MINUTE_MS);
    await playPage(w, 0, 90, 100, PAGE_FILM);
    expect(only(w).ranges).toEqual(before);
  });
});

describe("an element's `ended` ends a viewing only when that element plays the viewing's media", () => {
  test('Netflix, back to /browse after 80 s, a 150-s billboard trailer ends: the episode is not recorded', async () => {
    // The trailer is 150 s, the episode 2700 s: its end is not the episode's. The episode was
    // played short of its line.
    const w = makeWorld();
    await playService(w, 'netflix', 0, 1200, 2700, NETFLIX_EPISODE);
    w.clock.advance(80_000);
    await playService(w, 'netflix', 0, 135, 150, null);
    const trailerEnd = { position: 150, duration: 150, paused: true, ended: true };
    await onService(w, 'netflix', trailerEnd, null);

    expect(w.outbox.entries()).toEqual([]);
    expect(only(w)).toMatchObject({ contentEnded: false });
  });

  test('on a site without a module, a 150-s element in the same frame after a long pause ends nothing', async () => {
    // The page still names the film; the element is not the film's.
    const w = makeWorld();
    await playPage(w, 0, 3000, 6000, PAGE_FILM);
    w.clock.advance(5 * MINUTE_MS);
    await playPage(w, 0, 135, 150, PAGE_FILM);
    await onPage(w, { position: 150, duration: 150, paused: true, ended: true }, PAGE_FILM);

    expect(w.outbox.entries()).toEqual([]);
    expect(only(w)).toMatchObject({ contentEnded: false });
  });

  test("the viewing's own element ending still ends it", async () => {
    const w = makeWorld();
    // Played from 0 to 990 of a 6000-s film, then 2400 to 2700: the credits are never reached.
    await playPage(w, 0, 1000, 6000, PAGE_FILM);
    await playPage(w, 2400, 2700, 6000, PAGE_FILM);
    expect(only(w).contentEnded).toBe(false);
    const end = { position: 6000, duration: 6000, paused: true, ended: true };
    const reported = await onPage(w, end, PAGE_FILM);
    // Short of the line: the end sends nothing, and the viewing waits for more of it to be played.
    expect(reported).toBe(false);
    expect(only(w).state).toBe('open');
  });

  const viewingOf = (reading: MergedReading): Viewing =>
    must(newViewing({ id: 'v', serviceId: null, reading, at: 0, incognito: false }));
  const s = (at: number, position: number, o: Partial<PlaybackSample> = {}): PlaybackSample => ({
    at,
    position,
    duration: 2700,
    paused: false,
    ended: false,
    rate: 1,
    adPlaying: false,
    muted: false,
    visibleArea: 1,
    ...o,
  });
  const FILM: MergedReading = { kind: 'movie', title: 'Arrival', sources: ['json-ld'] };

  /** A viewing that learnt its element length (two samples agreed on 2700 s). */
  function learnt(): Viewing {
    const one = applySample(viewingOf(FILM), null, s(0, 100), FILM);
    const two = applySample(one, s(0, 100), s(15_000, 115), FILM);
    expect(two.elementDurationSeconds).toBe(2700);
    return two;
  }

  test.each([
    ['its own length', 2700, true],
    ['a length within max(60 s, 2 %) of it', 2754, true],
    ['another content length', 150, false],
    ['a length under 120 s', 90, false],
  ])(
    'an element of %s (%i s) that ends: contentEnded = %s (applySample)',
    (_label, length, ends) => {
      // Its length must agree with the viewing's media length, within max(60 s, 2 %).
      const end = s(20_000, length, { duration: length, paused: true, ended: true });
      const ended = applySample(learnt(), s(15_000, 115), end, FILM);
      expect(ended.contentEnded).toBe(ends);
    },
  );

  test('an element that ends while the viewing knows no length of its own ends nothing', () => {
    // A wrong end sends a play; a missed one is caught by the credits estimate.
    const v = applySample(viewingOf(FILM), null, s(0, 100), FILM);
    expect(v.elementDurationSeconds).toBeNull();
    const ended = applySample(v, s(0, 100), s(5_000, 2700, { paused: true, ended: true }), FILM);
    expect(ended.contentEnded).toBe(false);
  });

  test("a service's own end signal still ends the viewing whatever the element's length", () => {
    // The service showing its credits or post-play signal is the service's word.
    const signal: MergedReading = { ...FILM, contentEnded: true };
    const ended = applySample(learnt(), s(15_000, 115), s(30_000, 130, { duration: 150 }), signal);
    expect(ended.contentEnded).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Coverage across a pause, and a seek made while paused

describe('coverage runs up to a pause, never across one', () => {
  test('the stretch from the last playing sample to the pause counts', async () => {
    // Between two samples while playing the interval is added; the media played up to the
    // pause.
    const w = makeWorld();
    await playPage(w, 0, 300, 6000, PAGE_FILM);
    await onPage(w, { position: 310, duration: 6000, paused: true }, PAGE_FILM);
    expect(only(w).ranges).toEqual([[15, 310]]);
  });

  test('a seek made while paused counts nothing', async () => {
    // A larger jump is a seek and adds nothing. Play to 1500, pause, seek to 1581 while paused,
    // resume about 60 s later.
    const w = makeWorld();
    await playPage(w, 0, 1485, 6000, PAGE_FILM);
    await onPage(w, { position: 1500, duration: 6000 }, PAGE_FILM, 1_000);
    await onPage(w, { position: 1501, duration: 6000, paused: true }, PAGE_FILM, 20_000);
    await onPage(w, { position: 1581, duration: 6000, paused: true }, PAGE_FILM, 39_000);
    await onPage(w, { position: 1581, duration: 6000 }, PAGE_FILM);
    await onPage(w, { position: 1596, duration: 6000 }, PAGE_FILM);
    expect(only(w).ranges).toEqual([
      [15, 1501],
      [1581, 1596],
    ]);
  });

  test('a resume a few seconds ahead of the pause, after a long pause, adds nothing across it', async () => {
    // Only playback adds; the time paused is no playback, so the position the resume
    // starts from is not reached by playing.
    const w = makeWorld();
    await playPage(w, 0, 300, 6000, PAGE_FILM);
    await onPage(w, { position: 300, duration: 6000, paused: true }, PAGE_FILM, 40_000);
    await onPage(w, { position: 330, duration: 6000 }, PAGE_FILM);
    await onPage(w, { position: 345, duration: 6000 }, PAGE_FILM);
    expect(only(w).ranges).toEqual([
      [15, 300],
      [330, 345],
    ]);
  });

  test("the last stretch before the element's own `ended` counts", async () => {
    // The element played through to its end.
    const w = makeWorld();
    await playPage(w, 0, 990, 6000, PAGE_FILM);
    await onPage(w, { position: 1010, duration: 6000, paused: true, ended: true }, PAGE_FILM);
    expect(furthest(only(w))).toBe(1010);
  });

  test('a paused sample of other media is not the timeline the resume continues', async () => {
    // A sample of other media goes nowhere, paused or playing.
    const w = makeWorld();
    await playPage(w, 0, 300, 6000, PAGE_FILM);
    // A 600-s element paused at 312, inside the sitting: other media.
    await onPage(w, { position: 312, duration: 600, paused: true }, PAGE_FILM, 5_000);
    await onPage(w, { position: 315, duration: 6000 }, PAGE_FILM);
    expect(only(w).ranges).toEqual([[15, 315]]);
  });
});

// ---------------------------------------------------------------------------------------------
// The credits signal's first position

describe("the first position of the service's credits or post-play signal is the credits start", () => {
  const LONG_CREDITS_ID: ProviderId = { level: 'title', key: 'videoId', value: '81000001' };
  const filmOnService: ServiceReading = {
    kind: mod('movie'),
    title: mod('Long Credits'),
    providerIds: [LONG_CREDITS_ID],
  };
  /** Netflix's end screen: the id of the title that ended, and that it ended. */
  const endScreen: ServiceReading = { providerIds: [LONG_CREDITS_ID], contentEnded: true };

  test('a film whose credits start long before the estimate counts at 90 % once its end screen shows', async () => {
    // Long end titles must not stop a viewing from counting, even at a 90 % line. 7200 s, played
    // 0..5385, the end screen at 5400. Over the estimated story
    // (7200 − 864 = 6336) that is 85 %; over the story to 5400 it is all of it.
    const w = makeWorld({ rule: { finishThresholdPercent: 90 } });
    await playService(w, 'netflix', 0, 5385, 7200, filmOnService);
    expect(w.outbox.entries()).toEqual([]);
    expect(await onService(w, 'netflix', { position: 5400, duration: 7200 }, endScreen)).toBe(true);
    expect(must(storyOf(only(w))).end).toBe(5400);
  });

  test('a credits start the service states wins over the signal position', async () => {
    // The credits span is the service's marker, or the estimate: the stated marker is the
    // service's own statement (6300), the signal only where none is stated.
    const w = makeWorld({ rule: { finishThresholdPercent: 90 } });
    const stated: ServiceReading = { ...filmOnService, creditsStartSeconds: 6300 };
    await playService(w, 'netflix', 0, 5385, 7200, stated);
    await onService(w, 'netflix', { position: 5400, duration: 7200 }, endScreen);
    expect(must(storyOf(only(w))).end).toBe(6300);
    // 5385 s of a 6300-s story: under 90 %.
    expect(w.outbox.entries()).toEqual([]);
  });

  const FILM: MergedReading = { kind: 'movie', title: 'Long Credits', sources: ['module'] };
  const ENDS: MergedReading = { sources: [], contentEnded: true };
  const s = (at: number, position: number, o: Partial<PlaybackSample> = {}): PlaybackSample => ({
    at,
    position,
    duration: 7200,
    paused: false,
    ended: false,
    rate: 1,
    adPlaying: false,
    muted: false,
    visibleArea: 1,
    ...o,
  });
  const fresh = (): Viewing =>
    must(newViewing({ id: 'v', serviceId: 'netflix', reading: FILM, at: 0, incognito: false }));

  /** Played 5385 → 5400, where the end screen first shows. */
  function at5400(): Viewing {
    const one = applySample(fresh(), null, s(0, 5385), FILM);
    return applySample(one, s(0, 5385), s(15_000, 5400), ENDS);
  }

  test('only the first signal counts: a later one does not move the credits start', () => {
    const later = applySample(at5400(), s(15_000, 5400), s(30_000, 5415), ENDS);
    expect(must(storyOf(later)).end).toBe(5400);
  });

  test("a signal in the content's first half is no credits start: the estimate stands", () => {
    // As for a stated marker: one bad signal must not end the story at its start.
    const one = applySample(fresh(), null, s(0, 2000), FILM);
    const two = applySample(one, s(0, 2000), s(15_000, 2015), ENDS);
    expect(must(storyOf(two)).end).toBeCloseTo(estimatedCreditsStart(7200), 6);
  });

  test('a signal while an ad shows names no position', () => {
    // Ad time is not the content's; its position is not the content's either.
    const one = applySample(fresh(), null, s(0, 5385), FILM);
    const two = applySample(one, s(0, 5385), s(15_000, 5400, { adPlaying: true }), ENDS);
    expect(must(storyOf(two)).end).toBeCloseTo(estimatedCreditsStart(7200), 6);
  });

  test('a stored signal position that is not a position reads as none (storage is hostile)', () => {
    // Stored markers are held to the same bounds as stated ones.
    const v = at5400();
    expect(v.ranges).toEqual([[5385, 5400]]);
    for (const junk of [Number.NaN, -1, Infinity, '5400', null]) {
      const stored = { ...v, creditsSignalSeconds: junk } as unknown as Viewing;
      expect(must(storyOf(stored)).end).toBeCloseTo(estimatedCreditsStart(7200), 6);
    }
  });
});
