/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Apple TV module against synthetic snapshots shaped like its player pages (the README's
// shape). Expected values: the `umc.cmc.*` id from the path at the title level; kind and numbers
// from JSON-LD first at 0.95, then the media session and the label grammar at 0.8; ids at the
// level they belong, IMDb ids only as the page states them, within the API's bounds; an end
// screen ends the content and names no title nor another id; a header promo is
// `{ adPlaying: true }`, no kind.

import { assert, describe, expect, it } from 'vitest';

import { matchPlayerRoute } from '../../sdk';
import type { ServiceReading, Snapshot } from '../../sdk';
import { appleTv } from './definition';
import browseFixture from './fixtures/browse.snapshot.json';
import creditsFixture from './fixtures/credits.snapshot.json';
import episodeFixture from './fixtures/episode.snapshot.json';
import filmFixture from './fixtures/film.snapshot.json';

const snapshotOf = (fixture: { readonly snapshot: unknown }): Snapshot =>
  fixture.snapshot as Snapshot;

const EPISODE = snapshotOf(episodeFixture);
const FILM = snapshotOf(filmFixture);
const CREDITS = snapshotOf(creditsFixture);
const BROWSE = snapshotOf(browseFixture);

const EP2 = 'umc.cmc.synthep0102';
const EP3 = 'umc.cmc.synthep0103';
const SHOW = 'umc.cmc.synthshow01';

function read(snapshot: Snapshot): ServiceReading {
  const r = appleTv.interpret(snapshot);
  assert(r !== null, 'expected a reading');
  return r;
}

const valuesAt = (r: ServiceReading, level: 'title' | 'show'): string[] =>
  (r.providerIds ?? []).filter((p) => p.level === level).map((p) => p.value);

// The wire's rules, as the server validates a play's evidence.
const PROVIDER_KEY = /^[a-z][A-Za-z0-9._-]*$/u;
const PROVIDER_VALUE = /^[ !#-[\]-~]+$/u;
const IMDB = /^tt[0-9]{5,10}$/u;

function expectWithinWire(r: ServiceReading | null): void {
  if (r === null) return;
  for (const f of [r.title, r.showTitle, r.episodeTitle]) {
    if (f !== undefined) expect(Array.from(f.value).length).toBeLessThanOrEqual(200);
  }
  for (const p of r.providerIds ?? []) {
    expect(p.key).toMatch(PROVIDER_KEY);
    expect(p.value).toMatch(PROVIDER_VALUE);
    expect(p.value.length).toBeLessThanOrEqual(200);
  }
  for (const ids of [r.ids?.value, r.showIds?.value]) {
    if (ids?.imdb !== undefined) expect(ids.imdb).toMatch(IMDB);
  }
  for (const f of [r.year, r.showYear]) {
    if (f === undefined) continue;
    expect(f.value).toBeGreaterThanOrEqual(1870);
    expect(f.value).toBeLessThanOrEqual(2200);
  }
  if (r.season !== undefined) expect(r.season.value).toBeLessThanOrEqual(10_000);
  if (r.episode !== undefined) expect(r.episode.value).toBeLessThanOrEqual(100_000);
}

describe('fixtures are synthetic until a maintainer captures real pages', () => {
  it.each([
    ['episode', episodeFixture],
    ['film', filmFixture],
    ['credits', creditsFixture],
    ['browse', browseFixture],
  ])('%s carries "synthetic": true', (_name, fixture) => {
    expect(fixture.synthetic).toBe(true);
  });
});

describe('an episode', () => {
  it('reads kind, show, numbers and episode title from the JSON-LD about it, at 0.95', () => {
    const r = read(EPISODE);
    expect(r.kind).toMatchObject({ value: 'episode', confidence: 0.95 });
    expect(r.showTitle).toMatchObject({ value: 'Severance', confidence: 0.95 });
    expect(r.season).toMatchObject({ value: 1, confidence: 0.95 });
    expect(r.episode).toMatchObject({ value: 2, confidence: 0.95 });
    expect(r.episodeTitle).toMatchObject({ value: 'Half Loop', confidence: 0.95 });
  });

  it('states the path’s umc.cmc id at the title level', () => {
    expect(valuesAt(read(EPISODE), 'title')).toEqual([EP2]);
  });

  it("states the series' own id, which the address carries, at the show level", () => {
    // The service's own ids sit at the level they belong (a show's id on the show).
    expect(valuesAt(read(EPISODE), 'show')).toEqual([SHOW]);
  });

  it('states the IMDb ids the page states, each at its level, and the show year', () => {
    // `ids.imdb` only when the page itself states it (JSON-LD `sameAs`); `show` carries
    // its own ids and year.
    const r = read(EPISODE);
    expect(r.ids?.value).toEqual({ imdb: 'tt90000102' });
    expect(r.showIds?.value).toEqual({ imdb: 'tt11280740' });
    expect(r.showYear?.value).toBe(2022);
  });

  it('is not the end of the content, and a stated length, if any, is 54 minutes', () => {
    const r = read(EPISODE);
    expect(r.contentEnded).not.toBe(true);
    if (r.contentDurationSeconds !== undefined) expect(r.contentDurationSeconds).toBe(3240);
  });

  it('without JSON-LD, reads the numbers from the player through the label grammar, at 0.8', () => {
    const r = read({ ...EPISODE, jsonLd: [] });
    expect(r.kind?.value).toBe('episode');
    expect(r.season).toMatchObject({ value: 1, confidence: 0.8 });
    expect(r.episode).toMatchObject({ value: 2, confidence: 0.8 });
    expect(valuesAt(r, 'title')).toEqual([EP2]);
  });
});

describe('a film', () => {
  it('reads kind, title, year and its IMDb id, the path id at the title level, no show id', () => {
    const r = read(FILM);
    expect(r.kind).toMatchObject({ value: 'movie', confidence: 0.95 });
    expect(r.title).toMatchObject({ value: 'CODA', confidence: 0.95 });
    expect(r.year?.value).toBe(2021);
    expect(r.ids?.value).toEqual({ imdb: 'tt10366460' });
    expect(valuesAt(r, 'title')).toEqual(['umc.cmc.synthfilm01']);
    expect(valuesAt(r, 'show')).toEqual([]);
    if (r.contentDurationSeconds !== undefined) expect(r.contentDurationSeconds).toBe(6660);
  });
});

describe('the up-next card over the credits', () => {
  it('says the content ended', () => {
    expect(read(CREDITS).contentEnded).toBe(true);
  });

  it('names no title or number, though the card and the page name the next episode', () => {
    const r = read(CREDITS);
    for (const f of [r.kind, r.title, r.showTitle, r.episodeTitle, r.season, r.episode]) {
      expect(f).toBeUndefined();
    }
  });

  it('states no id of another title', () => {
    const r = read(CREDITS);
    expect(valuesAt(r, 'title').every((v) => v === EP2)).toBe(true);
    expect(r.ids?.value.imdb).not.toBe('tt90000103');
  });

  it('contentEnded comes from the end screen only: the next episode named by the player alone ends nothing', () => {
    const r = read({ ...CREDITS, signals: { endOfContent: false, adPlaying: false } });
    expect(r.contentEnded).not.toBe(true);
  });
});

describe('a page that is not a player route (episode and movie paths only)', () => {
  const PAGES = ['/us', '/', `/us/show/severance/${SHOW}`, '/us/channel/tvs.sbd.4', '/us/search'];
  it.each(PAGES)('%s: no route, no reading', (pathname) => {
    expect(matchPlayerRoute(appleTv.playerRoutes, pathname)).toBeNull();
    expect(appleTv.interpret({ ...BROWSE, url: { ...BROWSE.url, pathname } })).toBeNull();
  });

  it('the browse fixture reads as null', () => {
    expect(appleTv.interpret(BROWSE)).toBeNull();
  });
});

describe('JSON-LD about another umc.cmc id is ignored', () => {
  // The app moved to episode 3 and kept the page's first JSON-LD, about episode 2.
  const moved: Snapshot = {
    ...EPISODE,
    url: { ...EPISODE.url, pathname: `/us/episode/in-perpetuity/${EP3}` },
    selectors: {
      ...EPISODE.selectors,
      playerSubtitle: ['S1, E3 · In Perpetuity'],
      contentId: [EP2],
    },
  };

  it("takes none of the other item's title, numbers or IMDb id", () => {
    const r = read(moved);
    expect(r.episodeTitle?.value).not.toBe('Half Loop');
    expect(r.episode?.value).not.toBe(2);
    expect(r.ids?.value.imdb).not.toBe('tt90000102');
  });

  it("takes none of it while the player's lines are hidden either", () => {
    const hidden = { player: ['video-player'], contentId: [EP2] };
    const r = read({ ...moved, selectors: hidden });
    expect(r.episodeTitle?.value).not.toBe('Half Loop');
    expect(r.episode?.value).not.toBe(2);
    expect(r.ids?.value.imdb).not.toBe('tt90000102');
    expect(valuesAt(r, 'title')).toEqual([EP3]);
  });

  it('reads what plays from the player instead, at 0.8', () => {
    const r = read(moved);
    expect(r.season).toMatchObject({ value: 1, confidence: 0.8 });
    expect(r.episode).toMatchObject({ value: 3, confidence: 0.8 });
  });

  it('a node that names no item is the page’s, and the page was rendered for another one', () => {
    const nameless = { url: undefined, '@id': undefined };
    const anonymous = EPISODE.jsonLd.map((node) => ({ ...(node as object), ...nameless }));
    const r = read({ ...moved, jsonLd: JSON.parse(JSON.stringify(anonymous)) as unknown[] });
    expect(r.episodeTitle?.value).not.toBe('Half Loop');
    expect(r.ids?.value.imdb).not.toBe('tt90000102');
  });
});

describe('a promotional video outside the player', () => {
  it('is `{ adPlaying: true }` with no kind', () => {
    const promo = read({ ...FILM, selectors: { contentId: ['umc.cmc.synthfilm01'] } });
    expect(promo.adPlaying).toBe(true);
    expect(promo.kind).toBeUndefined();
  });
});

describe('odd and huge shapes are total: no throw, and the wire bounds hold (checklist)', () => {
  const node = EPISODE.jsonLd[0];
  const long = 'Severance '.repeat(100_000);
  const nulls: unknown[] = Array.from({ length: 100_000 }, () => null);
  const types = Array.from({ length: 100_000 }, () => 'Thing');
  const deep: unknown = JSON.parse(`${'['.repeat(5000)}${']'.repeat(5000)}`);
  const odd: readonly (readonly [string, unknown])[] = [
    ['null', null],
    ['a number', 7],
    ['a url that is a string', { ...EPISODE, url: `/us/episode/x/${EP2}` }],
    ['selectors that are null', { ...EPISODE, selectors: null }],
    ['JSON-LD that is an object', { ...EPISODE, jsonLd: { '@type': 'TVEpisode' } }],
    ['100,000 nulls before the node', { ...EPISODE, jsonLd: [...nulls, node] }],
    ['a 100,000-entry @type', { ...EPISODE, jsonLd: [{ ...(node as object), '@type': types }] }],
    ['a megabyte name', { ...EPISODE, jsonLd: [{ ...(node as object), name: long }] }],
    ['a megabyte player title', { ...EPISODE, selectors: { player: ['x'], playerTitle: [long] } }],
    ['odd numbers', { ...EPISODE, jsonLd: [{ '@type': 'TVEpisode', episodeNumber: 1e9 }] }],
    ['an odd duration', { ...EPISODE, jsonLd: [{ ...(node as object), duration: 'P99999D' }] }],
    ['an empty duration', { ...EPISODE, jsonLd: [{ ...(node as object), duration: 'PT' }] }],
    ['a year far out', { ...FILM, jsonLd: [{ '@type': 'Movie', datePublished: '9999-01-01' }] }],
    ['a nested @graph', { ...EPISODE, jsonLd: [{ '@graph': [{ '@graph': [node] }] }] }],
    ['deep JSON-LD', { ...EPISODE, jsonLd: [deep] }],
    ['a sameAs list of junk', { ...EPISODE, jsonLd: [{ ...(node as object), sameAs: nulls }] }],
    ['an upper-case id', { ...EPISODE, url: { pathname: '/us/episode/x/UMC.CMC.ABC' } }],
    ['a 3,000-character route', { ...EPISODE, url: { pathname: `/us/${'x'.repeat(3000)}` } }],
  ];

  it.each(odd)('%s', (_label, snapshot) => {
    let r: ServiceReading | null = null;
    expect(() => {
      r = appleTv.interpret(snapshot as Snapshot);
    }).not.toThrow();
    expectWithinWire(r);
  });
});

// The series' own id that the JSON-LD about the route's episode names (`partOfSeries.url` /
// `@id`) is stated at the show level too (a show's id sits on the show); where the address's `showId` names another series, neither is stated.
describe("the series' id from the JSON-LD about the route's episode", () => {
  const seriesUrl = (id: string) => `https://tv.apple.com/us/show/severance/${id}`;
  const [episodeNode] = EPISODE.jsonLd as readonly Record<string, unknown>[];
  /** The episode fixture with the `showId` query given and its series node naming `series`. */
  function episodeWith(query: Record<string, string>, series: Record<string, unknown>): Snapshot {
    const partOfSeries = { ...(episodeNode?.partOfSeries as object), ...series };
    return {
      ...EPISODE,
      url: { ...EPISODE.url, query },
      jsonLd: [{ ...episodeNode, partOfSeries }],
    };
  }

  it('is stated when the address carries none', () => {
    const r = read(episodeWith({}, { url: seriesUrl(SHOW) }));
    expect(valuesAt(r, 'show')).toEqual([SHOW]);
    expect((r.providerIds ?? []).find((p) => p.level === 'show')?.key).toBe('contentId');
  });

  it("is stated once when the address's showId names the same series", () => {
    const r = read(episodeWith({ showId: SHOW }, { '@id': seriesUrl(SHOW) }));
    expect(valuesAt(r, 'show')).toEqual([SHOW]);
  });

  it("neither is stated when the address's showId names another series", () => {
    const r = read(episodeWith({ showId: SHOW }, { url: seriesUrl('umc.cmc.othershow9') }));
    expect(valuesAt(r, 'show')).toEqual([]);
  });

  it("the series' url and @id naming two ids state none", () => {
    const series = { url: seriesUrl(SHOW), '@id': seriesUrl('umc.cmc.othershow9') };
    expect(valuesAt(read(episodeWith({}, series)), 'show')).toEqual([]);
  });

  it("a series id that is the episode's own is no show id", () => {
    expect(valuesAt(read(episodeWith({}, { url: seriesUrl(EP2) })), 'show')).toEqual([]);
  });

  it('JSON-LD about another item gives no series id (the app moved on)', () => {
    const other = 'https://tv.apple.com/us/episode/x/umc.cmc.synthep0101';
    const stale = {
      ...episodeNode,
      '@id': other,
      url: other,
      partOfSeries: { name: 'Severance', url: seriesUrl('umc.cmc.othershow9') },
    };
    const r = read({ ...EPISODE, url: { ...EPISODE.url, query: {} }, jsonLd: [stale] });
    expect(valuesAt(r, 'show')).toEqual([]);
  });
});
