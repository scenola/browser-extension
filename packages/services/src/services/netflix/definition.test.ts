/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Netflix module against synthetic snapshots shaped like its player page (the README's
// shape). Expected values: the episode is Breaking Bad, S1E2, "Cat's in the Bag...", videoId
// 70196253; 0.95 from the player's state, 0.8 from the title area; ids sit at the level they
// belong, within the API's bounds; an end screen ends the content and names no title, and
// states the id of the title that ended or none.

import { assert, describe, expect, it } from 'vitest';

import { matchPlayerRoute } from '../../sdk';
import type { ServiceReading, Snapshot } from '../../sdk';
import { netflix } from './definition';
import browseFixture from './fixtures/browse-preview.snapshot.json';
import episodeFixture from './fixtures/episode.snapshot.json';
import filmFixture from './fixtures/film.snapshot.json';
import hiddenControlsFixture from './fixtures/hidden-controls.snapshot.json';
import postplayFixture from './fixtures/postplay.snapshot.json';
import singleSeasonFixture from './fixtures/single-season.snapshot.json';

const snapshotOf = (fixture: { readonly snapshot: unknown }): Snapshot =>
  fixture.snapshot as Snapshot;

const EPISODE = snapshotOf(episodeFixture);
const FILM = snapshotOf(filmFixture);
const POSTPLAY = snapshotOf(postplayFixture);
const BROWSE = snapshotOf(browseFixture);
const SINGLE_SEASON = snapshotOf(singleSeasonFixture);
const HIDDEN = snapshotOf(hiddenControlsFixture);

function read(snapshot: Snapshot): ServiceReading {
  const r = netflix.interpret(snapshot);
  assert(r !== null, 'expected a reading');
  return r;
}

const titleIds = (r: ServiceReading) => (r.providerIds ?? []).filter((p) => p.level === 'title');
const showIds = (r: ServiceReading) => (r.providerIds ?? []).filter((p) => p.level === 'show');

// The wire's rules for a provider entry, as the server validates a play's evidence.
const PROVIDER_KEY = /^[a-z][A-Za-z0-9._-]*$/u;
const PROVIDER_VALUE = /^[ !#-[\]-~]+$/u;

function expectWithinWire(r: ServiceReading | null): void {
  if (r === null) return;
  for (const f of [r.title, r.showTitle, r.episodeTitle]) {
    if (f !== undefined) expect(Array.from(f.value).length).toBeLessThanOrEqual(200);
  }
  for (const p of r.providerIds ?? []) {
    expect(p.key).toMatch(PROVIDER_KEY);
    expect(p.key.length).toBeLessThanOrEqual(64);
    expect(p.value).toMatch(PROVIDER_VALUE);
    expect(p.value.length).toBeLessThanOrEqual(200);
  }
  if (r.season !== undefined) expect(r.season.value).toBeLessThanOrEqual(10_000);
  if (r.episode !== undefined) expect(r.episode.value).toBeLessThanOrEqual(100_000);
}

describe('fixtures are synthetic until a maintainer captures real pages', () => {
  it.each([
    ['episode', episodeFixture],
    ['film', filmFixture],
    ['postplay', postplayFixture],
    ['browse-preview', browseFixture],
    ['single-season', singleSeasonFixture],
    ['hidden-controls', hiddenControlsFixture],
  ])('%s carries "synthetic": true', (_name, fixture) => {
    expect(fixture.synthetic).toBe(true);
  });
});

describe('an episode, with the player state', () => {
  it('reads kind, show, numbers and episode title from the state, at 0.95', () => {
    const r = read(EPISODE);
    expect(r.kind).toMatchObject({ value: 'episode', confidence: 0.95 });
    expect(r.showTitle).toMatchObject({ value: 'Breaking Bad', confidence: 0.95 });
    expect(r.season).toMatchObject({ value: 1, confidence: 0.95 });
    expect(r.episode).toMatchObject({ value: 2, confidence: 0.95 });
    expect(r.episodeTitle).toMatchObject({ value: "Cat's in the Bag...", confidence: 0.95 });
  });

  it("states the route's video id at the title level", () => {
    const id = { level: 'title', key: 'videoId', value: '70196253' };
    expect(titleIds(read(EPISODE))).toEqual([id]);
  });

  it("states the show's own id at the show level when the state has it", () => {
    // `level: "show"` for the show id when the state has it (a show's id sits on the show).
    expect(showIds(read(EPISODE)).map((p) => p.value)).toEqual(['70143836']);
  });

  it('is not the end of the content', () => {
    // `contentEnded` is the end screen's; the player shows none here.
    expect(read(EPISODE).contentEnded).not.toBe(true);
  });

  it("a stated length, if any, is the session's in seconds", () => {
    // ServiceReading.contentDurationSeconds is seconds; the session says 2,880,000
    // milliseconds (the README's shape, from prior art).
    const length = read(EPISODE).contentDurationSeconds;
    if (length !== undefined) expect(length).toBe(2880);
  });
});

describe('an episode with no player state: the title area', () => {
  it('reads the numbers through the label grammar, at 0.8', () => {
    const r = read({ ...EPISODE, pageState: {} });
    expect(r.kind).toMatchObject({ value: 'episode', confidence: 0.8 });
    expect(r.showTitle).toMatchObject({ value: 'Breaking Bad', confidence: 0.8 });
    expect(r.season).toMatchObject({ value: 1, confidence: 0.8 });
    expect(r.episode).toMatchObject({ value: 2, confidence: 0.8 });
    expect(r.episodeTitle).toMatchObject({ value: "Cat's in the Bag..." });
    expect(titleIds(r).map((p) => p.value)).toEqual(['70196253']);
  });
});

// Seen on a real page on 2026-10-22: a single-season show's title area in Ukrainian —
// "Джентльмени", "Еп. 3", "Де моя трава?" — has an episode-only label.
describe("a single-season show's title area: an episode-only label", () => {
  const withArea = (heading: string, parts: readonly string[]): ServiceReading =>
    read({ ...SINGLE_SEASON, selectors: { titleHeading: [heading], titleParts: [...parts] } });

  it('reads the episode number and the episode title, and no season', () => {
    const r = read(SINGLE_SEASON);
    expect(r.kind).toMatchObject({ value: 'episode', confidence: 0.8 });
    expect(r.showTitle).toMatchObject({ value: 'Джентльмени', confidence: 0.8 });
    expect(r.episode).toMatchObject({ value: 3, confidence: 0.8 });
    expect(r.season).toBeUndefined();
    expect(r.episodeTitle).toMatchObject({ value: 'Де моя трава?', confidence: 0.8 });
    expect(titleIds(r).map((p) => p.value)).toEqual(['80000003']);
  });

  it.each([
    ['en', 'Ep. 3', 'Where Is My Weed?'],
    ['de', 'Folge 3', 'Wo ist mein Gras?'],
    ['zh', '第3集', '我的草在哪里？'],
  ])('%s: "%s" before the title', (_locale, label, title) => {
    const r = withArea('The Gentlemen', [label, title]);
    expect(r.episode).toMatchObject({ value: 3 });
    expect(r.season).toBeUndefined();
    expect(r.episodeTitle).toMatchObject({ value: title });
  });

  it('the title before the label is still the episode title, as the one other part', () => {
    const r = withArea('Джентльмени', ['Де моя трава?', 'Еп. 3']);
    expect(r.episode).toMatchObject({ value: 3 });
    expect(r.episodeTitle).toMatchObject({ value: 'Де моя трава?' });
  });

  it('a season-and-episode label wins over an episode-only one', () => {
    const r = withArea('Show', ['Еп. 3', 'S2:E5', 'Title']);
    expect(r.season).toMatchObject({ value: 2 });
    expect(r.episode).toMatchObject({ value: 5 });
    expect(r.episodeTitle).toMatchObject({ value: 'Title' });
  });

  it('parts with no label at all are still an episode of the show with no numbers', () => {
    const r = withArea('Джентльмени', ['Limited Series', 'Де моя трава?']);
    expect(r.kind).toMatchObject({ value: 'episode' });
    expect(r.showTitle).toMatchObject({ value: 'Джентльмени' });
    expect(r.episode).toBeUndefined();
    expect(r.season).toBeUndefined();
  });

  it('numbers Netflix hides are not taken from the title area', () => {
    const video = {
      type: 'show',
      id: 1,
      title: 'Джентльмени',
      currentEpisode: 80000003,
      hiddenEpisodeNumbers: true,
    };
    const r = read({ ...SINGLE_SEASON, pageState: { video } });
    expect(r.episode).toBeUndefined();
    expect(r.episodeTitle).toMatchObject({ value: 'Де моя трава?' });
  });
});

// The real player page (shapes from a real page of 2026-10-22, synthetic values): with the
// controls hidden there is no title area in the DOM at all; the player's root names the video it
// plays (`[data-uia="player"][data-videoid]`), and the server-rendered Falcor cache holds the
// route video's summary, runtime and credits offset as atoms.
describe('the real player page with its controls hidden: the player id and the Falcor summary', () => {
  const falcor = (summary: unknown, more: Record<string, unknown> = {}) => ({
    summary: { $type: 'atom', value: summary },
    ...more,
  });
  const withState = (pageState: Record<string, unknown>): Snapshot => ({ ...HIDDEN, pageState });
  const session = (videoId: number, currentTime: number) => ({
    s: { videoId, duration: 2_880_000, currentTime },
  });

  it('reads kind, season and episode from the summary of the route video, at 0.95', () => {
    const r = read(HIDDEN);
    expect(r.kind).toMatchObject({ value: 'episode', confidence: 0.95 });
    expect(r.season).toMatchObject({ value: 1, confidence: 0.95 });
    expect(r.episode).toMatchObject({ value: 2, confidence: 0.95 });
    expect(titleIds(r).map((p) => p.value)).toEqual(['70196253']);
    expect(r.contentDurationSeconds).toBe(2880);
    expect(r.contentEnded).toBe(false);
  });

  it('a player showing another video than the route names nothing: a switch under way', () => {
    const selectors = { ...HIDDEN.selectors, playerVideoId: ['70196254'] };
    const r = read({ ...HIDDEN, selectors });
    for (const f of [r.kind, r.title, r.showTitle, r.episodeTitle, r.season, r.episode]) {
      expect(f).toBeUndefined();
    }
    expect(r.providerIds ?? []).toEqual([]);
    expect(r.contentEnded).not.toBe(true);
  });

  it('a player that agrees with the route changes nothing', () => {
    const selectors = { titleHeading: [], titleParts: [] };
    expect(read(HIDDEN)).toEqual(read({ ...HIDDEN, selectors }));
  });

  it('a summary of another video gives nothing of it', () => {
    const r = read(withState({ falcor: falcor({ type: 'movie', id: 99_999_999 }) }));
    expect(r.kind).toBeUndefined();
  });

  it('a film’s summary gives the kind; the title area, when it shows, the title', () => {
    const selectors = { titleHeading: ['Arrival'], titleParts: [], playerVideoId: ['70196253'] };
    const film = { ...withState({ falcor: falcor({ type: 'movie', id: 70196253 }) }), selectors };
    const r = read(film);
    expect(r.kind).toMatchObject({ value: 'movie', confidence: 0.95 });
    expect(r.title).toMatchObject({ value: 'Arrival', confidence: 0.8 });
    expect(r.season).toBeUndefined();
  });

  it('numbers Netflix hides are not taken from the summary either', () => {
    const video = {
      type: 'show',
      id: 70143836,
      title: 'Breaking Bad',
      currentEpisode: 70196253,
      hiddenEpisodeNumbers: true,
    };
    const r = read(withState({ ...HIDDEN.pageState, video }));
    expect(r.kind).toMatchObject({ value: 'episode' });
    expect(r.season).toBeUndefined();
    expect(r.episode).toBeUndefined();
  });

  it('the runtime is a stated length where no session states one, from 120 s to a week', () => {
    const summary = { type: 'episode', id: 70196253, season: 1, episode: 2 };
    const length = (runtime: number) =>
      read(withState({ falcor: falcor(summary, { runtime: { $type: 'atom', value: runtime } }) }))
        .contentDurationSeconds;
    expect(length(2880)).toBe(2880);
    expect(length(60)).toBeUndefined();
    expect(length(8 * 86_400)).toBeUndefined();
  });

  // Core decides where the story ends, from a credits start the reading will state;
  // until core has that field the offset is collected and ends nothing of its own.
  it('the credits offset ends nothing of its own, even with the session past it', () => {
    const r = read(withState({ ...HIDDEN.pageState, playback: session(70196253, 2_850_000) }));
    expect(r.contentEnded).toBe(false);
    expect(r.kind).toMatchObject({ value: 'episode' });
  });
});

describe('a film, with the player state', () => {
  it('reads kind, title and year at 0.95, the video id at the title level and no show id', () => {
    const r = read(FILM);
    expect(r.kind).toMatchObject({ value: 'movie', confidence: 0.95 });
    expect(r.title).toMatchObject({ value: 'The Irishman', confidence: 0.95 });
    expect(r.year).toMatchObject({ value: 2019, confidence: 0.95 });
    expect(titleIds(r)).toEqual([{ level: 'title', key: 'videoId', value: '80175798' }]);
    expect(showIds(r)).toEqual([]);
    expect(r.season).toBeUndefined();
    expect(r.episode).toBeUndefined();
  });
});

describe('the post-play screen', () => {
  it('says the content ended', () => {
    expect(read(POSTPLAY).contentEnded).toBe(true);
  });

  it('names no title or number, though the screen and the state name the next episode', () => {
    const r = read(POSTPLAY);
    for (const f of [r.kind, r.title, r.showTitle, r.episodeTitle, r.season, r.episode]) {
      expect(f).toBeUndefined();
    }
  });

  it('states no id but the ended title’s', () => {
    for (const p of read(POSTPLAY).providerIds ?? []) {
      expect(p.value).not.toBe('70196254');
      expect(p.value).not.toBe('70143836');
    }
    expect(titleIds(read(POSTPLAY)).every((p) => p.value === '70196253')).toBe(true);
  });

  it('contentEnded comes from the end screen only: the next episode named in the title area alone ends nothing', () => {
    const r = read({ ...POSTPLAY, signals: { endOfContent: false, adPlaying: false } });
    expect(r.contentEnded).not.toBe(true);
  });
});

describe('a page that is not a player route', () => {
  const PAGES = ['/browse', '/title/70143836', '/', '/search', '/watchlist'];
  it.each(PAGES)('%s: no route, no reading', (pathname) => {
    expect(matchPlayerRoute(netflix.playerRoutes, pathname)).toBeNull();
    expect(netflix.interpret({ ...BROWSE, url: { ...BROWSE.url, pathname } })).toBeNull();
  });

  it('the browse fixture reads as null', () => {
    expect(netflix.interpret(BROWSE)).toBeNull();
  });
});

describe('state about another video is ignored (it is read only for the route’s own id)', () => {
  it('a film entry of another id does not make the episode a film', () => {
    const other = { type: 'movie', id: 99_999_999, title: 'Other Film', year: 2001 };
    const state = { ...EPISODE.pageState, video: other };
    const r = read({ ...EPISODE, pageState: state });
    expect(r.kind?.value).not.toBe('movie');
    expect(r.title?.value).not.toBe('Other Film');
    expect(r.year).toBeUndefined();
  });

  it("an episode entry of another id gives none of that episode's numbers or title", () => {
    const state = {
      ...EPISODE.pageState,
      season: 4,
      episode: { id: 70_999_999, seq: 9, title: 'Another Episode' },
    };
    const r = read({ ...EPISODE, pageState: state });
    expect(r.season?.value).not.toBe(4);
    expect(r.episode?.value).not.toBe(9);
    expect(r.episodeTitle?.value).not.toBe('Another Episode');
  });

  it("a playback session of another video states none of that video's length", () => {
    const state = {
      ...EPISODE.pageState,
      playback: { b0: { videoId: 81_000_000, duration: 5_400_000 } },
    };
    expect(read({ ...EPISODE, pageState: state }).contentDurationSeconds).not.toBe(5400);
  });
});

describe('odd and huge shapes are total: no throw, and the wire bounds hold (checklist)', () => {
  const long = 'Breaking Bad '.repeat(80_000);
  const many = Array.from({ length: 100_000 }, () => 'S1:E2');
  const deep: unknown = JSON.parse(`${'['.repeat(5000)}${']'.repeat(5000)}`);
  const odd: readonly (readonly [string, unknown])[] = [
    ['null', null],
    ['a number', 42],
    ['an array', [EPISODE]],
    ['a url that is a string', { ...EPISODE, url: '/watch/70196253' }],
    ['selectors that are null', { ...EPISODE, selectors: null }],
    ['selector values that are numbers', { ...EPISODE, selectors: { titleHeading: [1] } }],
    ['a megabyte title', { ...EPISODE, selectors: { titleHeading: [long], titleParts: [long] } }],
    ['100,000 title parts', { ...EPISODE, selectors: { titleHeading: ['x'], titleParts: many } }],
    ['page state that is a string', { ...EPISODE, pageState: 'x' }],
    ['a video entry that is an array', { ...EPISODE, pageState: { video: [1, 2] } }],
    ['odd numbers in the state', { ...EPISODE, pageState: { season: '1', episode: { seq: 1e9 } } }],
    ['a huge session duration', { ...EPISODE, pageState: { playback: { a: { duration: 1e9 } } } }],
    ['signals that are strings', { ...EPISODE, signals: { endOfContent: 'true', adPlaying: 1 } }],
    ['a 3,000-digit route', { ...EPISODE, url: { pathname: `/watch/${'7'.repeat(3000)}` } }],
    ['a deep page state', { ...EPISODE, pageState: { video: deep } }],
  ];

  it.each(odd)('%s', (_label, snapshot) => {
    let r: ServiceReading | null = null;
    expect(() => {
      r = netflix.interpret(snapshot as Snapshot);
    }).not.toThrow();
    expectWithinWire(r);
  });
});

// The show's own id, and the credits start the service states (Netflix's `creditsOffset`).
describe("the show's own id is stated only for the route's episode", () => {
  const withVideo = (video: Record<string, unknown>): Snapshot => ({
    ...EPISODE,
    pageState: { ...EPISODE.pageState, video },
  });
  const show = { type: 'show', id: 70143836, title: 'Breaking Bad', currentEpisode: 70196253 };

  it('under the key the title-level id has: Netflix numbers a show as a video', () => {
    expect(showIds(read(EPISODE))).toEqual([{ level: 'show', key: 'videoId', value: '70143836' }]);
  });

  it('a show entry about another episode states no show id', () => {
    const state = { ...EPISODE.pageState, video: { ...show, currentEpisode: 1 }, episode: {} };
    expect(showIds(read({ ...EPISODE, pageState: state }))).toEqual([]);
  });

  it("a show id that is the route's own id is no show id", () => {
    expect(showIds(read(withVideo({ ...show, id: 70196253 })))).toEqual([]);
  });

  it('a show id that is no id (a string of letters, a fraction, negative) is none', () => {
    for (const id of ['abc', 1.5, -3, null]) {
      expect(showIds(read(withVideo({ ...show, id })))).toEqual([]);
    }
  });

  it('where the summary names a film, the show entry and its id stand aside', () => {
    const falcor = {
      summary: { $type: 'atom', value: { type: 'movie', id: 70196253 } },
    };
    const r = read({ ...EPISODE, pageState: { ...EPISODE.pageState, falcor } });
    expect(r.kind).toMatchObject({ value: 'movie' });
    expect(showIds(r)).toEqual([]);
  });

  it('the end screen states no show id (the ended title’s id or none)', () => {
    expect(showIds(read(POSTPLAY))).toEqual([]);
  });
});

describe("the credits offset is the reading's credits start, for the route's video only", () => {
  const withFalcor = (falcor: Record<string, unknown>): Snapshot => ({
    ...HIDDEN,
    pageState: { ...HIDDEN.pageState, falcor },
  });
  const summary = (id: number) => ({
    $type: 'atom',
    value: { type: 'episode', id, season: 1, episode: 2 },
  });
  const offset = (value: unknown) => ({ $type: 'atom', value });

  it('is stated from the summary of the route video, in seconds', () => {
    expect(read(HIDDEN).creditsStartSeconds).toBe(2790);
    expect(read(EPISODE).creditsStartSeconds).toBe(2790);
  });

  it("is not stated when the summary is another video's, or absent", () => {
    const other = withFalcor({ summary: summary(70196254), creditsOffset: offset(2790) });
    expect(read(other).creditsStartSeconds).toBeUndefined();
    expect(read(withFalcor({ creditsOffset: offset(2790) })).creditsStartSeconds).toBeUndefined();
  });

  it('an offset that is no position (a string, negative, past a week) is none', () => {
    for (const value of ['2790', -1, 8 * 86_400, null]) {
      const r = read(withFalcor({ summary: summary(70196253), creditsOffset: offset(value) }));
      expect(r.creditsStartSeconds).toBeUndefined();
    }
  });

  it('the end screen states none: it says only that the title ended', () => {
    expect(read(POSTPLAY).creditsStartSeconds).toBeUndefined();
  });
});
