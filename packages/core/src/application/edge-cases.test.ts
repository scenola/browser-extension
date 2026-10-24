/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Edge cases of the core's rules, each decided on the safe side: nothing wrong is recorded,
// nothing is invented. The services' edge cases are in their own tests, the sanitiser's in
// sanitize.test.ts.

import { describe, expect, test } from 'vitest';

import { PlayedRanges } from '../domain/coverage';
import type { PlaybackSample } from '../domain/coverage';
import { parseEpisodeLabel } from '../domain/labels';
import type { Field, ProviderId, ServiceReading } from '../domain/reading';
import { DAY_MS, MINUTE_MS } from '../domain/time';
import { sameLength } from '../domain/viewing';
import type { Viewing } from '../domain/viewing';
import { makeWorld, must } from './test-world';
import type { World } from './test-world';

const gen = <T>(value: T): Field<T> => ({ value, confidence: 0.8, source: 'json-ld' });
const mod = <T>(value: T): Field<T> => ({ value, confidence: 0.95, source: 'module' });

/** A page's JSON-LD naming S1E2 of "Show", with the show's first year when given. */
const pageEpisode = (showYear?: number): ServiceReading => ({
  kind: gen('episode'),
  showTitle: gen('Show'),
  season: gen(1),
  episode: gen(2),
  ...(showYear === undefined ? {} : { showYear: gen(showYear) }),
});

function sampleAt(w: World, o: Partial<PlaybackSample>): PlaybackSample {
  return {
    at: w.clock.now(),
    position: 0,
    duration: 2700,
    paused: false,
    ended: false,
    rate: 1,
    adPlaying: false,
    muted: false,
    visibleArea: 1,
    ...o,
  };
}

interface Look {
  readonly tabId?: number;
  readonly serviceId?: string | null;
  readonly duration?: number;
}

/** Plays `from`..`to` in 15-s steps on one tab, the frame reporting `module` or `generic`. */
async function play(
  w: World,
  reading: ServiceReading | null,
  from: number,
  to: number,
  o: Look = {},
): Promise<void> {
  const serviceId = o.serviceId ?? null;
  for (let p = from; p <= to; p += 15) {
    const sample = sampleAt(w, { position: p, duration: o.duration ?? 2700 });
    await w.ingest.execute({
      tabId: o.tabId ?? 1,
      incognito: false,
      serviceId,
      frames: [
        {
          frameId: 0,
          isTop: true,
          sample,
          reading: serviceId === null ? null : reading,
          generic: serviceId === null && reading !== null ? [reading] : [],
        },
      ],
    });
    w.clock.advance(15_000);
  }
}

const viewingsByYear = (w: World): (number | undefined)[] =>
  w.viewings
    .all()
    .map((v) => v.reading.showYear)
    .sort();
const ofYear = (w: World, year: number): Viewing =>
  must(w.viewings.all().find((v) => v.reading.showYear === year));

// ---------------------------------------------------------------------------------------------
// An equal key whose stated show years disagree

describe('two stated show years are two shows, even under one key', () => {
  test('on what is still the bound media, the samples stay the bound show’s and its year stands', async () => {
    // Two show years that disagree are two identities, and the bound media's samples are the
    // bound viewing's.
    const w = makeWorld();
    await play(w, pageEpisode(2008), 0, 600);
    await play(w, pageEpisode(2013), 615, 705);
    expect(viewingsByYear(w)).toEqual([2008]);
    expect(ofYear(w, 2008).ranges).toEqual([[15, 705]]);
  });

  test('on media of its own, the other year opens its own viewing; the first keeps its year and ranges', async () => {
    const w = makeWorld();
    await play(w, pageEpisode(2008), 0, 600);
    w.clock.advance(2 * MINUTE_MS);
    await play(w, pageEpisode(2013), 0, 300, { duration: 2400 });
    expect(viewingsByYear(w)).toEqual([2008, 2013]);
    expect(ofYear(w, 2008).ranges).toEqual([[15, 600]]);
    expect(PlayedRanges.fromJSON(ofYear(w, 2013).ranges).total()).toBeGreaterThan(0);
  });

  test('a later sitting naming the first year joins the first show, not the newer one', async () => {
    const w = makeWorld();
    await play(w, pageEpisode(2008), 0, 600);
    await w.viewings.dropTab(1);
    w.clock.advance(DAY_MS);
    await play(w, pageEpisode(2013), 0, 300, { tabId: 2, duration: 2400 });
    await w.viewings.dropTab(2);
    w.clock.advance(DAY_MS);
    await play(w, pageEpisode(2008), 615, 900, { tabId: 3 });
    expect(viewingsByYear(w)).toEqual([2008, 2013]);
    expect(PlayedRanges.fromJSON(ofYear(w, 2008).ranges).furthest()).toBe(900);
    expect(PlayedRanges.fromJSON(ofYear(w, 2013).ranges).furthest()).toBe(300);
  });

  test('a reading that states no show year still joins the open viewing of its key', async () => {
    // Nothing contradicts: the key is the identity.
    const w = makeWorld();
    await play(w, pageEpisode(2008), 0, 600);
    await w.viewings.dropTab(1);
    w.clock.advance(DAY_MS);
    await play(w, pageEpisode(), 615, 900, { tabId: 2 });
    expect(viewingsByYear(w)).toEqual([2008]);
  });

  test("a viewing keyed by the service's own id is that id's, whatever the show years say", async () => {
    // The id is the identity.
    const id: ProviderId = { level: 'title', key: 'videoId', value: '81' };
    const byId = (showYear: number): ServiceReading => ({
      kind: mod('episode'),
      showTitle: mod('Show'),
      season: mod(1),
      episode: mod(2),
      showYear: mod(showYear),
      providerIds: [id],
    });
    const w = makeWorld();
    await play(w, byId(2008), 0, 600, { serviceId: 'netflix' });
    w.clock.advance(2 * MINUTE_MS);
    await play(w, byId(2013), 615, 900, { serviceId: 'netflix' });
    expect(w.viewings.all()).toHaveLength(1);
    expect(must(w.viewings.all()[0]).key).toBe('svc:netflix:81');
  });

  test('a reading that names nothing of its own never renames the bound show’s year', async () => {
    const w = makeWorld();
    await play(w, pageEpisode(2008), 0, 600);
    await play(w, { showYear: gen(2013) }, 615, 705);
    expect(viewingsByYear(w)).toEqual([2008]);
    expect(ofYear(w, 2008).ranges).toEqual([[15, 705]]);
  });
});

// ---------------------------------------------------------------------------------------------
// Label numbers past the grammar's digits

describe('a season of four digits or an episode of five is no label', () => {
  test.each([
    ['Season 2024, Episode 1', null],
    ['Season 202, Episode 1', { season: 202, episode: 1 }],
    ['S1E10000', null],
    ['S1E9999', { season: 1, episode: 9999 }],
  ])('%s → %j', (text, label) => {
    // A four-digit "season" is as likely a year; a number the page does not say plainly is
    // never invented: numbers are sent as the page numbers them.
    expect(parseEpisodeLabel(text)).toEqual(label);
  });
});

// ---------------------------------------------------------------------------------------------
// "2 %" of the longer

describe('the 2 % of max(60 s, 2 %) is of the longer length', () => {
  test('6000 s and 6122 s are one media (2 % of 6122 is 122.44 s), in either order', () => {
    // Of the shorter (120 s) they would be two.
    expect(sameLength(6000, 6122)).toBe(true);
    expect(sameLength(6122, 6000)).toBe(true);
    expect(sameLength(6000, 6123)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// A module that flips between a reading and null

describe('observations that name nothing neither count nor break the count', () => {
  test('a module answering a reading and null in turn binds on its second reading and loses no sample after', async () => {
    // Holding still counts the observations that name a key; a null answer names none, and its
    // samples are the bound viewing's (a reading of nothing of its own).
    const w = makeWorld();
    const episode: ServiceReading = {
      kind: mod('episode'),
      showTitle: mod('Show'),
      season: mod(1),
      episode: mod(2),
    };
    for (let i = 0; i <= 20; i += 1) {
      await play(w, i % 2 === 0 ? episode : null, i * 15, i * 15, { serviceId: 'netflix' });
    }
    expect(w.viewings.all()).toHaveLength(1);
    // Readings at 0 and 30: bound at 30, every sample after it counted, null ones included.
    expect(must(w.viewings.all()[0]).ranges).toEqual([[30, 300]]);
  });
});

// ---------------------------------------------------------------------------------------------
// The russian spelling in the Ukrainian table

describe('the Ukrainian label table holds Ukrainian words only', () => {
  test('"серія" is read; the russian spelling is not (no support of anything russian)', () => {
    expect(parseEpisodeLabel('Сезон 1, серія 2')).toEqual({ season: 1, episode: 2 });
    expect(parseEpisodeLabel('Сезон 1, серия 2')).toBeNull();
  });
});
