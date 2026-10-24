/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'vitest';

import { PlayedRanges } from '../domain/coverage';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../domain/time';
import type { Viewing } from '../domain/viewing';
import { STABLE_OBSERVATIONS } from './ingest-observation';
import {
  T0,
  episodeReading,
  filmReading,
  makeWorld,
  must,
  observation,
  observe,
  watch,
} from './test-world';
import type { World } from './test-world';

const E1 = 'ep:show:1:1';
const E2 = 'ep:show:1:2';

const viewingOf = async (w: World, key: string): Promise<Viewing> =>
  must(await w.viewings.open(key));

const coverage = (v: Viewing): number => PlayedRanges.fromJSON(v.ranges).total();

describe('binding: a reading must hold still before a viewing starts', () => {
  test('the first observation binds nothing; the second, with the same reading, does', async () => {
    expect(STABLE_OBSERVATIONS).toBe(2);
    const w = makeWorld();
    const first = await observe(w, episodeReading(1), 0);
    // A playing sample that went nowhere says why — here, it has not held still.
    expect(first).toEqual({ viewing: null, reported: false, newlyIgnored: 'settling' });
    expect(w.viewings.all()).toEqual([]);
    expect((await w.viewings.tabState(1))?.stableCount).toBe(1);

    const second = await observe(w, episodeReading(1), 15);
    expect(second.viewing?.key).toBe(E1);
    // A sitting starts from the sample that binds it.
    expect(second.viewing?.ranges).toEqual([]);
    const third = await observe(w, episodeReading(1), 30);
    expect(third.viewing?.ranges).toEqual([[15, 30]]);
  });

  test('a reading that changes between two observations binds neither', async () => {
    const w = makeWorld();
    await observe(w, episodeReading(1), 0);
    await observe(w, episodeReading(2), 15);
    expect(w.viewings.all()).toEqual([]);
    const bound = await observe(w, episodeReading(2), 30);
    expect(bound.viewing?.key).toBe(E2);
  });

  test('a viewing never starts from an end screen', async () => {
    const w = makeWorld();
    await observe(w, episodeReading(1, { contentEnded: true }), 0);
    await observe(w, episodeReading(1, { contentEnded: true }), 15);
    expect(w.viewings.all()).toEqual([]);
    const bound = await observe(w, episodeReading(1), 30);
    expect(bound.viewing?.contentEnded).toBe(false);
  });
});

describe('autoplay and identity changes', () => {
  test('(b) episode 1 finishes and is reported once; episode 2 starts empty on the same element', async () => {
    const w = makeWorld();
    const results = await watch(w, episodeReading(1), 0, 960);
    expect(results.filter((r) => r.reported)).toHaveLength(1);
    const e1 = must(results.at(-1)?.viewing);
    expect(e1.state).toBe('reported');
    // Reported where its 630 s played reach the 616 s line (the 645 s sample), so its coverage
    // stops there.
    expect(coverage(e1)).toBe(630);

    // The player rolls into episode 2: a new length, from the start.
    await observe(w, episodeReading(2), 0, { sample: { duration: 1100 } });
    const split = await observe(w, episodeReading(2), 15, { sample: { duration: 1100 } });
    expect(split.viewing?.key).toBe(E2);
    expect(split.viewing?.ranges).toEqual([]);
    expect(split.viewing?.state).toBe('open');
    await observe(w, episodeReading(2), 30, { sample: { duration: 1100 } });

    expect(w.outbox.entries()).toHaveLength(1);
    expect(w.outbox.entries()[0]?.viewingId).toBe(e1.id);
    // The line, at 645 s, was the moment it was recorded.
    expect((await w.viewings.byId(e1.id))?.ranges).toEqual([[15, 645]]);
    expect((await viewingOf(w, E2)).ranges).toEqual([[15, 30]]);
  });

  test('(c) a reading change before episode 1 finished leaves it open and unreported', async () => {
    const w = makeWorld();
    await watch(w, episodeReading(1), 0, 495);
    const e1 = await viewingOf(w, E1);

    await observe(w, episodeReading(2), 0, { sample: { duration: 1100 } });
    await observe(w, episodeReading(2), 15, { sample: { duration: 1100 } });

    const after = await w.viewings.byId(e1.id);
    expect(after?.state).toBe('open');
    expect(after?.ranges).toEqual([[15, 495]]);
    expect((await viewingOf(w, E2)).id).not.toBe(e1.id);
    expect(w.outbox.entries()).toEqual([]);
    expect((await w.viewings.tabState(1))?.viewingId).toBe((await viewingOf(w, E2)).id);
  });

  test('stale samples at a post-play countdown never start the next episode', async () => {
    const w = makeWorld();
    const long = { sample: { duration: 1100 } };
    await watch(w, episodeReading(1), 0, 990, long);
    expect((await w.viewings.tabState(1))?.addedAt).not.toBeNull();

    // The countdown names episode 2 while the element still plays episode 1's last seconds.
    for (const p of [1005, 1020, 1035, 1050, 1065]) await observe(w, episodeReading(2), p, long);
    expect(await w.viewings.open(E2)).toBeNull();

    // Episode 2 loads: another length, from the start.
    const short = { sample: { duration: 900 } };
    for (const p of [2, 17, 32]) await observe(w, episodeReading(2), p, short);
    const e2 = await viewingOf(w, E2);
    expect(e2.ranges).toEqual([[2, 32]]);
    expect(PlayedRanges.fromJSON(e2.ranges).furthest()).toBe(32);
    expect(e2.contentEnded).toBe(false);
    expect(e2.durationSeconds).toBe(900);
    expect(w.outbox.entries()).toHaveLength(1);
  });

  test('stale samples are released by a position under 60 s, even at the old length', async () => {
    const w = makeWorld();
    await watch(w, episodeReading(1), 0, 960);
    await observe(w, episodeReading(2), 975);
    await observe(w, episodeReading(2), 990);
    expect(await w.viewings.open(E2)).toBeNull();
    await observe(w, episodeReading(2), 3);
    await observe(w, episodeReading(2), 18);
    const e2 = await viewingOf(w, E2);
    expect(e2.ranges).toEqual([[3, 18]]);
    expect(e2.state).toBe('open');
  });

  test('a film of another year is a new identity: the old viewing keeps its ranges', async () => {
    const w = makeWorld();
    await watch(w, filmReading('Film', 1984), 0, 300);
    const old = await viewingOf(w, 'mv:film:1984');

    // The remake, loaded in the same tab.
    const remake = { sample: { duration: 1200 } };
    await observe(w, filmReading('Film', 2021), 0, remake);
    await observe(w, filmReading('Film', 2021), 15, remake);

    const fresh = await viewingOf(w, 'mv:film:2021');
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.ranges).toEqual([]);
    const kept = await w.viewings.byId(old.id);
    expect(kept?.state).toBe('open');
    expect(kept?.ranges).toEqual([[15, 300]]);
  });

  test('another title on the bound media’s own continuing playback stays with that viewing', async () => {
    const w = makeWorld();
    await watch(w, filmReading('Film'), 0, 300);
    const old = await viewingOf(w, 'mv:film:');
    // The page names another title mid-film; the element plays on, the same media.
    await watch(w, filmReading('Other'), 315, 450);
    expect(await w.viewings.open('mv:other:')).toBeNull();
    expect((await w.viewings.byId(old.id))?.ranges).toEqual([[15, 450]]);
  });
});

describe('one title, named more or less finely', () => {
  const film = { sample: { duration: 7200 } };

  test('a year that appears early, then a pause: one play, with both halves', async () => {
    const w = makeWorld();
    await watch(w, filmReading('Film'), 0, 45, film);
    await watch(w, filmReading('Film', 2000), 60, 3600, film);
    w.clock.advance(5 * MINUTE_MS);
    await watch(w, filmReading('Film', 2000), 3615, 7200, film);

    expect(w.viewings.all()).toHaveLength(1);
    const v = must(w.viewings.all()[0]);
    expect(v.key).toBe('mv:film:2000');
    expect(v.state).toBe('reported');
    // Recorded at the line, 4436 s of the 6336 s story: 3585 s played before the pause, so the
    // second half reaches it at 4470 s.
    expect(v.ranges).toEqual([
      [15, 3600],
      [3615, 4470],
    ]);
    expect(w.outbox.entries().map((e) => [e.body.title, e.body.year])).toEqual([['Film', 2000]]);
  });

  test('a reading that loses the year keeps the viewing, whatever the pause', async () => {
    const w = makeWorld();
    await watch(w, filmReading('Film', 2000), 0, 300);
    const v = await viewingOf(w, 'mv:film:2000');
    w.clock.advance(5 * MINUTE_MS);
    await watch(w, filmReading('Film'), 300, 450);
    expect(w.viewings.all()).toHaveLength(1);
    const after = must(await w.viewings.byId(v.id));
    expect(after.key).toBe('mv:film:2000');
    expect(after.reading.year).toBe(2000);
    expect(after.ranges).toEqual([[15, 450]]);
  });

  test('the service’s own title id, gained and then lost, keeps one viewing', async () => {
    const w = makeWorld();
    const netflix = { serviceId: 'netflix' };
    const withId = episodeReading(1, {
      providerIds: [{ level: 'title', key: 'videoId', value: '81' }],
    });
    await watch(w, episodeReading(1), 0, 300, netflix);
    const v = await viewingOf(w, `netflix/${E1}`);
    await watch(w, withId, 315, 450, netflix);
    expect(await w.viewings.open(`netflix/${E1}`)).toBeNull();
    expect((await w.viewings.open('svc:netflix:81'))?.id).toBe(v.id);
    w.clock.advance(5 * MINUTE_MS);
    await watch(w, episodeReading(1), 450, 600, netflix);
    expect(w.viewings.all()).toHaveLength(1);
    expect(must(await w.viewings.byId(v.id)).key).toBe('svc:netflix:81');
    expect(must(await w.viewings.byId(v.id)).ranges).toEqual([[15, 600]]);
  });

  test('a later sitting finds the viewing however finely its first reading names it (same length)', async () => {
    const w = makeWorld();
    await watch(w, filmReading('Film'), 0, 45, film);
    await watch(w, filmReading('Film', 2000), 60, 3600, film);
    await w.viewings.dropTab(1);
    w.clock.advance(DAY_MS);

    // The next evening the page again names the year only after a minute.
    await watch(w, filmReading('Film'), 3600, 3645, { ...film, tabId: 2 });
    await watch(w, filmReading('Film', 2000), 3660, 7200, { ...film, tabId: 2 });
    expect(w.viewings.all()).toHaveLength(1);
    expect(must(w.viewings.all()[0]).state).toBe('reported');
    expect(w.outbox.entries()).toHaveLength(1);
  });
});

describe('a refinement joins only when the media lengths agree', () => {
  // Dune (1984) runs 137 minutes; Dune (2021) runs 155.
  const dune1984 = { sample: { duration: 8220 } };
  const dune2021 = { sample: { duration: 9300 } };

  test('a yearless film, then a remake of its title with its year, in one tab: two films', async () => {
    const w = makeWorld();
    await watch(w, filmReading('Dune'), 0, 300, dune1984);
    const first = await viewingOf(w, 'mv:dune:');

    await watch(w, filmReading('Dune', 2021), 0, 30, dune2021);
    expect(w.viewings.all()).toHaveLength(2);
    const kept = must(await w.viewings.byId(first.id));
    expect(kept.key).toBe('mv:dune:');
    expect(kept.reading.year).toBeUndefined();
    expect(kept.ranges).toEqual([[15, 300]]);
    const remake = await viewingOf(w, 'mv:dune:2021');
    expect(remake.id).not.toBe(first.id);
    expect(remake.ranges).toEqual([[15, 30]]);
  });

  test('a film with its year, then a yearless page of the older film, in one tab: two films', async () => {
    const w = makeWorld();
    await watch(w, filmReading('Dune', 2021), 0, 300, dune2021);
    const first = await viewingOf(w, 'mv:dune:2021');

    await watch(w, filmReading('Dune'), 0, 30, dune1984);
    expect(w.viewings.all()).toHaveLength(2);
    const kept = must(await w.viewings.byId(first.id));
    expect(kept.reading.year).toBe(2021);
    expect(kept.ranges).toEqual([[15, 300]]);
    const older = await viewingOf(w, 'mv:dune:');
    expect(older.id).not.toBe(first.id);
    expect(older.ranges).toEqual([[15, 30]]);
  });

  test('a later sitting of the remake does not join the yearless film found by its title', async () => {
    const w = makeWorld();
    await watch(w, filmReading('Dune'), 0, 300, dune1984);
    const first = await viewingOf(w, 'mv:dune:');
    await w.viewings.dropTab(1);
    w.clock.advance(DAY_MS);

    await watch(w, filmReading('Dune', 2021), 0, 30, { ...dune2021, tabId: 2 });
    expect(w.viewings.all()).toHaveLength(2);
    expect(must(await w.viewings.byId(first.id)).ranges).toEqual([[15, 300]]);
    expect((await viewingOf(w, 'mv:dune:2021')).ranges).toEqual([[15, 30]]);
  });

  test('the same film whose year appears mid-play, at the same length: one viewing', async () => {
    const w = makeWorld();
    await watch(w, filmReading('Dune'), 0, 1800, dune1984);
    // The service states a length half a minute off the element's: within the tolerance.
    const dated = { ...filmReading('Dune', 1984), contentDurationSeconds: 8190 };
    await watch(w, dated, 1815, 1845, dune1984);
    expect(w.viewings.all()).toHaveLength(1);
    const v = must(w.viewings.all()[0]);
    expect(v.key).toBe('mv:dune:1984');
    expect(v.ranges).toEqual([[15, 1845]]);
  });

  test('an unknown seen length decides nothing (it cannot tell the film from a remake): a year on a stream that reports none re-keys and records nothing until a length shows', async () => {
    const w = makeWorld();
    const live = { sample: { duration: null } };
    await watch(w, filmReading('Film'), 0, 300, live);
    await watch(w, filmReading('Film', 2000), 315, 345, live);
    expect(w.viewings.all()).toHaveLength(1);
    const v = must(w.viewings.all()[0]);
    expect(v.key).toBe('mv:film:');
    expect(v.ranges).toEqual([[15, 300]]);
    // A length shows: the viewing has none to object with, so it agrees; the year held still
    // all along, so it re-keys at once, and the playback bridges the undecided seconds.
    await watch(w, filmReading('Film', 2000), 360, 390, { sample: { duration: 7200 } });
    expect(w.viewings.all()).toHaveLength(1);
    expect(must(w.viewings.all()[0]).key).toBe('mv:film:2000');
    expect(must(w.viewings.all()[0]).ranges).toEqual([[15, 390]]);
  });

  test('one tab: a yearless film, then the remake’s page opening with a pre-roll: two films', async () => {
    for (const preRoll of [
      { sample: { adPlaying: true, duration: 30 } },
      // Unflagged: too short to be the film, so no length to decide by either.
      { sample: { duration: 30 } },
    ]) {
      const w = makeWorld();
      await watch(w, filmReading('Dune'), 0, 3000, dune1984);
      const first = await viewingOf(w, 'mv:dune:');
      for (const p of [0, 10, 20]) await observe(w, filmReading('Dune', 2021), p, preRoll);
      // The pre-roll decided nothing: the yearless viewing is as it was.
      expect(must(await w.viewings.byId(first.id))).toMatchObject({
        key: 'mv:dune:',
        ranges: [[15, 3000]],
      });

      await watch(w, filmReading('Dune', 2021), 0, 3000, dune2021);
      expect(w.viewings.all()).toHaveLength(2);
      const kept = must(await w.viewings.byId(first.id));
      expect(kept.key).toBe('mv:dune:');
      expect(kept.reading.year).toBeUndefined();
      expect(kept.ranges).toEqual([[15, 3000]]);
      expect((await viewingOf(w, 'mv:dune:2021')).ranges).toEqual([[0, 3000]]);
    }
  });

  test('a later sitting of the remake that binds during a pre-roll does not join the open yearless film', async () => {
    // The yearless film is played short of its line (5064 s of its 7233 s story), so it stays open.
    const w = makeWorld();
    await watch(w, filmReading('Dune'), 0, 4500, dune1984);
    const first = await viewingOf(w, 'mv:dune:');
    await w.viewings.dropTab(1);
    w.clock.advance(DAY_MS);

    const preRoll = { tabId: 2, sample: { adPlaying: true, duration: 30 } };
    for (const p of [0, 10, 20]) await observe(w, filmReading('Dune', 2021), p, preRoll);
    // It waits: no title candidate joined, no viewing started.
    expect(w.viewings.all()).toHaveLength(1);
    expect((await w.viewings.tabState(2))?.viewingId).toBeNull();

    await watch(w, filmReading('Dune', 2021), 0, 9300, { ...dune2021, tabId: 2 });
    expect(w.viewings.all()).toHaveLength(2);
    expect(must(await w.viewings.byId(first.id))).toMatchObject({
      key: 'mv:dune:',
      state: 'open',
      ranges: [[15, 4500]],
    });
    expect(w.outbox.entries().map((e) => [e.body.title, e.body.year])).toEqual([['Dune', 2021]]);
    expect(w.outbox.entries()[0]?.viewingId).not.toBe(first.id);
  });

  test('a skipped yearless film does not swallow a later fully watched remake: the remake is reported', async () => {
    const w = makeWorld();
    await watch(w, filmReading('Dune'), 0, 600, dune1984);
    const skipped = await viewingOf(w, 'mv:dune:');
    await w.skip.execute(skipped.id);
    await w.viewings.dropTab(1);
    w.clock.advance(2 * DAY_MS);

    // An unflagged pre-roll, then the whole film.
    const preRoll = { tabId: 2, sample: { duration: 25 } };
    for (const p of [0, 10, 20]) await observe(w, filmReading('Dune', 2021), p, preRoll);
    const results = await watch(w, filmReading('Dune', 2021), 0, 9300, { ...dune2021, tabId: 2 });

    expect(results.filter((r) => r.reported)).toHaveLength(1);
    expect(must(await w.viewings.byId(skipped.id))).toMatchObject({
      key: 'mv:dune:',
      state: 'skipped',
      ranges: [[15, 600]],
    });
    expect(w.outbox.entries().map((e) => [e.body.title, e.body.year])).toEqual([['Dune', 2021]]);
  });

  test('a year that appears during an ad on the bound media: its samples stay the viewing’s, and nothing is re-keyed until the film shows again', async () => {
    const w = makeWorld();
    const film = { sample: { duration: 7200 } };
    await watch(w, filmReading('Film'), 0, 300, film);
    // A stitched ad break flagged on the film's own element: the element is still the film's.
    await watch(w, filmReading('Film', 2000), 315, 345, {
      sample: { duration: 7200, adPlaying: true },
    });
    expect(must(w.viewings.all()[0])).toMatchObject({ key: 'mv:film:', ranges: [[15, 300]] });
    await watch(w, filmReading('Film', 2000), 360, 390, film);
    expect(w.viewings.all()).toHaveLength(1);
    // The ad's samples went to the viewing (an ad counts no coverage), so its seconds are not
    // bridged as if the film had played through them.
    expect(must(w.viewings.all()[0])).toMatchObject({
      key: 'mv:film:2000',
      ranges: [
        [15, 300],
        [360, 390],
      ],
    });
  });

  test('a year that appears during a mid-roll ad is judged by no length: one viewing', async () => {
    const w = makeWorld();
    await watch(w, filmReading('Film'), 0, 300, dune1984);
    // Two observations of the ad (long enough to look like content) with the year.
    const ad = { sample: { adPlaying: true, duration: 150 } };
    await observe(w, filmReading('Film', 2000), 5, ad);
    await observe(w, filmReading('Film', 2000), 20, ad);
    await watch(w, filmReading('Film', 2000), 315, 345, dune1984);
    expect(w.viewings.all()).toHaveLength(1);
    expect(must(w.viewings.all()[0]).key).toBe('mv:film:2000');
  });

  test('a pre-roll binds no viewing, and the film whose year appears as it starts is one viewing', async () => {
    // Media under 120 s is ad time and binds nothing: the pre-roll must not bind a yearless
    // viewing of 30 s that the film would then have to re-key.
    const w = makeWorld();
    const preRoll = { sample: { adPlaying: true, duration: 30 } };
    for (const p of [0, 10, 20]) await observe(w, filmReading('Film'), p, preRoll);
    expect(w.viewings.all()).toEqual([]);

    await watch(w, filmReading('Film', 2000), 0, 45, dune1984);
    expect(w.viewings.all()).toHaveLength(1);
    const v = must(w.viewings.all()[0]);
    expect(v.key).toBe('mv:film:2000');
    // The year is a new name: it holds still for two observations, and the sitting starts there.
    expect(v.ranges).toEqual([[15, 45]]);
  });
});

describe('a finer name re-keys only once it held still', () => {
  const dune = { sample: { duration: 8220 } };

  test('one observation naming 2021, then 87 minutes of 1984: reported as 1984', async () => {
    const w = makeWorld();
    await watch(w, filmReading('Dune'), 0, 3000, dune);
    // One observation whose merged reading carries another year (a related title, a transient).
    await observe(w, filmReading('Dune', 2021), 3015, dune);
    // Its sample is the viewing's; its name is not.
    expect((await viewingOf(w, 'mv:dune:')).ranges).toEqual([[15, 3015]]);

    await watch(w, filmReading('Dune', 1984), 3030, 8220, dune);
    expect(w.viewings.all()).toHaveLength(1);
    expect(must(w.viewings.all()[0]).key).toBe('mv:dune:1984');
    expect(w.outbox.entries().map((e) => [e.body.title, e.body.year])).toEqual([['Dune', 1984]]);
  });

  test('a name that flickers never re-keys and loses no sample', async () => {
    const w = makeWorld();
    await watch(w, filmReading('Film'), 0, 300, dune);
    for (let p = 315; p <= 600; p += 15) {
      await observe(w, filmReading('Film', p % 30 === 0 ? 2000 : undefined), p, dune);
    }
    expect(w.viewings.all()).toHaveLength(1);
    expect(must(w.viewings.all()[0])).toMatchObject({ key: 'mv:film:', ranges: [[15, 600]] });
  });

  test('a coarser name needs no hold: what it says carries at once', async () => {
    const w = makeWorld();
    const netflix = { serviceId: 'netflix' };
    const withId = episodeReading(1, {
      providerIds: [{ level: 'title', key: 'videoId', value: '81' }],
    });
    await watch(w, withId, 0, 300, netflix);
    const pilot = episodeReading(1, {
      episodeTitle: { value: 'Pilot', confidence: 1, source: 'module' },
    });
    await observe(w, pilot, 315, netflix);
    const v = await viewingOf(w, 'svc:netflix:81');
    expect(v.reading.episodeTitle).toBe('Pilot');
    expect(v.ranges).toEqual([[15, 315]]);
  });
});

describe('a next-episode screen ends the episode it follows', () => {
  test('a countdown that names the next episode and says the content ended is this one’s end', async () => {
    const w = makeWorld();
    // 585 s of the 880 s story the estimate draws: short of its 616 s line.
    await watch(w, episodeReading(1), 0, 600);
    expect(w.outbox.entries()).toEqual([]);
    // The credits begin at 615 s and the module declares the end: the story ends there, and the
    // 600 s played pass its 431 s line.
    const ended = await observe(w, episodeReading(2, { contentEnded: true }), 615);
    expect(ended.reported).toBe(true);
    expect(ended.viewing?.key).toBe(E1);
    expect(w.outbox.entries().map((e) => [e.viewingId, e.body.ended])).toEqual([
      [ended.viewing?.id, true],
    ]);
    expect(await w.viewings.open(E2)).toBeNull();
  });

  test('without an end flag, the next episode still inherits nothing of the last one', async () => {
    const w = makeWorld();
    await watch(w, episodeReading(1), 0, 600);
    const e1 = await viewingOf(w, E1);
    // A countdown from 615 that names episode 2 but says nothing of the end; the element plays
    // episode 1 on to its end, which reaches its line on the way.
    await watch(w, episodeReading(2), 615, 990);
    await observe(w, episodeReading(2), 1000, { sample: { ended: true, paused: true } });
    expect(await w.viewings.open(E2)).toBeNull();
    const done = must(await w.viewings.byId(e1.id));
    expect(done.state).toBe('reported');

    // Episode 2 loads, shorter, and is watched to half of it, short of its line.
    const short = { sample: { duration: 900 } };
    await watch(w, episodeReading(2), 2, 452, short);
    const e2 = await viewingOf(w, E2);
    expect(e2.ranges).toEqual([[2, 452]]);
    expect(e2.contentEnded).toBe(false);
    expect(e2.durationSeconds).toBe(900);
    expect(e2.state).toBe('open');
    expect(PlayedRanges.fromJSON(e2.ranges).furthest()).toBe(452);
    expect(w.outbox.entries().map((e) => e.viewingId)).toEqual([e1.id]);
  });
});

describe('a viewing is one service’s', () => {
  test('two services that name the title alike never share a viewing, and each keeps its own ids', async () => {
    const w = makeWorld();
    const alpha = episodeReading(1, {
      providerIds: [{ level: 'show', key: 'showId', value: 'A1' }],
    });
    const beta = episodeReading(1, {
      providerIds: [{ level: 'show', key: 'showId', value: 'B9' }],
    });
    await watch(w, alpha, 0, 300, { serviceId: 'alpha' });
    const first = await viewingOf(w, `alpha/${E1}`);
    await w.viewings.dropTab(1);
    await watch(w, beta, 0, 945, { tabId: 2, serviceId: 'beta' });

    expect(w.viewings.all()).toHaveLength(2);
    expect(must(await w.viewings.byId(first.id))).toMatchObject({
      serviceId: 'alpha',
      state: 'open',
      ranges: [[15, 300]],
      reading: { providerIds: [{ level: 'show', key: 'showId', value: 'A1' }] },
    });
    expect(w.outbox.entries().map((e) => [e.viewingId === first.id, e.body.show?.ids])).toEqual([
      [false, { provider: [{ namespace: 'provider.beta', key: 'showId', value: 'B9' }] }],
    ]);
  });

  test('a Netflix viewing of S1E2, then a generic, id-less reading of S1E2 a day later: two viewings', async () => {
    const w = makeWorld();
    const netflix = episodeReading(2, {
      providerIds: [{ level: 'title', key: 'videoId', value: '81' }],
    });
    await watch(w, netflix, 0, 600, { serviceId: 'netflix' });
    const first = await viewingOf(w, 'svc:netflix:81');
    await w.viewings.dropTab(1);
    w.clock.advance(DAY_MS);

    // A site without a module: the same title, numbers and length, no ids.
    await watch(w, episodeReading(2), 600, 945, { tabId: 2 });
    expect(w.viewings.all()).toHaveLength(2);
    expect(must(await w.viewings.byId(first.id))).toMatchObject({ ranges: [[15, 600]] });
    expect((await viewingOf(w, E2)).ranges).toEqual([[615, 945]]);
    expect(w.outbox.entries()).toEqual([]);
  });

  test('and the other way: a generic viewing is not joined by a service’s sitting', async () => {
    const w = makeWorld();
    await watch(w, episodeReading(2), 0, 600);
    const first = await viewingOf(w, E2);
    await w.viewings.dropTab(1);
    w.clock.advance(DAY_MS);
    await watch(w, episodeReading(2), 600, 945, { tabId: 2, serviceId: 'netflix' });
    expect(w.viewings.all()).toHaveLength(2);
    expect(must(await w.viewings.byId(first.id)).ranges).toEqual([[15, 600]]);
    expect((await viewingOf(w, `netflix/${E2}`)).ranges).toEqual([[615, 945]]);
  });

  test('two sites without a module are one service: a later sitting joins on the title and the length', async () => {
    const w = makeWorld();
    await watch(w, filmReading('Film'), 0, 300, { sample: { duration: 7200 } });
    const first = await viewingOf(w, 'mv:film:');
    await w.viewings.dropTab(1);
    w.clock.advance(DAY_MS);
    await watch(w, filmReading('Film', 2000), 300, 600, { tabId: 2, sample: { duration: 7200 } });
    expect(w.viewings.all()).toHaveLength(1);
    expect(must(await w.viewings.byId(first.id))).toMatchObject({ key: 'mv:film:2000' });
  });

  test('a tab that moves to another service: a reading of nothing there does not end this viewing', async () => {
    // Played short of its line, so only an end could close it.
    const w = makeWorld();
    await watch(w, episodeReading(1), 0, 600, { serviceId: 'netflix' });
    // The tab now shows another service's end screen, which names nothing of its own.
    await observe(w, { contentEnded: true }, 615, { serviceId: 'apple-tv' });
    expect(must(w.viewings.all()[0])).toMatchObject({ state: 'open', contentEnded: false });
    expect(w.outbox.entries()).toEqual([]);
  });

  test('two services’ own ids are two viewings: Netflix S1E2 (81), then Apple TV S1E2 (zz) a day later, each reported under its own namespace', async () => {
    const w = makeWorld();
    const netflix = episodeReading(2, {
      providerIds: [{ level: 'title', key: 'videoId', value: '81' }],
    });
    const appleTv = episodeReading(2, {
      providerIds: [{ level: 'title', key: 'id', value: 'zz' }],
    });
    const length = { sample: { duration: 1320 } };
    await watch(w, netflix, 0, 600, { ...length, serviceId: 'netflix' });
    const first = await viewingOf(w, 'svc:netflix:81');
    await w.viewings.dropTab(1);
    w.clock.advance(DAY_MS);

    await watch(w, appleTv, 0, 1320, { ...length, tabId: 2, serviceId: 'apple-tv' });
    expect(w.viewings.all()).toHaveLength(2);
    expect(must(await w.viewings.byId(first.id))).toMatchObject({
      state: 'open',
      ranges: [[15, 600]],
    });
    // Netflix's is finished there later.
    await w.viewings.dropTab(2);
    await watch(w, netflix, 600, 1320, { ...length, tabId: 3, serviceId: 'netflix' });

    expect(w.outbox.entries().map((e) => [e.viewingId === first.id, e.body.ids])).toEqual([
      [false, { provider: [{ namespace: 'provider.apple-tv', key: 'id', value: 'zz' }] }],
      [true, { provider: [{ namespace: 'provider.netflix', key: 'videoId', value: '81' }] }],
    ]);
  });

  test('two show years that disagree are two shows: a sitting that names its id does not join the other show’s episode', async () => {
    const w = makeWorld();
    const year = (value: number) => ({
      showYear: { value, confidence: 1, source: 'module' as const },
    });
    await watch(w, episodeReading(2, year(2004)), 0, 300, { serviceId: 'netflix' });
    const first = await viewingOf(w, `netflix/${E2}`);
    await w.viewings.dropTab(1);
    w.clock.advance(DAY_MS);

    const other = episodeReading(2, {
      ...year(1978),
      providerIds: [{ level: 'title', key: 'videoId', value: '81' }],
    });
    await watch(w, other, 0, 300, { tabId: 2, serviceId: 'netflix' });
    expect(w.viewings.all()).toHaveLength(2);
    expect(must(await w.viewings.byId(first.id)).ranges).toEqual([[15, 300]]);
    expect((await viewingOf(w, 'svc:netflix:81')).reading.showYear).toBe(1978);
  });
});

describe('overlapping observations of one viewing', () => {
  // Bound at 15 s, an episode reaches its 616 s line at the 645 s sample: 615 s are played at
  // 630 s, one short. The crossing observation is the one delivered twice.
  test('one crossing observation delivered twice at once is one play', async () => {
    const w = makeWorld();
    await watch(w, episodeReading(1), 0, 630);
    await Promise.all([
      w.ingest.execute(observation(w, episodeReading(1), 645)),
      w.ingest.execute(observation(w, episodeReading(1), 645)),
    ]);
    expect(w.outbox.entries()).toHaveLength(1);
    expect(w.ids.playId()).toBe('play-2');
    expect(must(w.viewings.all()[0]).ranges).toEqual([[15, 645]]);
  });

  test('two tabs on one viewing keep both their ranges', async () => {
    const w = makeWorld();
    await watch(w, episodeReading(1), 0, 600);
    await watch(w, episodeReading(1), 700, 715, { tabId: 2 });
    const v = await viewingOf(w, E1);
    expect(v.ranges).toEqual([[15, 600]]);

    await Promise.all([
      w.ingest.execute(observation(w, episodeReading(1), 615)),
      w.ingest.execute(observation(w, episodeReading(1), 730, { tabId: 2 })),
    ]);
    expect((await viewingOf(w, E1)).ranges).toEqual([
      [15, 615],
      [715, 730],
    ]);
  });

  // The crossing samples are at 645 s, the first whose played seconds reach the line.
  test('two tabs crossing the line of one viewing at once report it once', async () => {
    const w = makeWorld();
    await watch(w, episodeReading(1), 0, 630);
    await watch(w, episodeReading(1), 615, 630, { tabId: 2 });
    const results = await Promise.all([
      w.ingest.execute(observation(w, episodeReading(1), 645)),
      w.ingest.execute(observation(w, episodeReading(1), 645, { tabId: 2 })),
    ]);
    expect(results.filter((r) => r.reported)).toHaveLength(1);
    expect(w.outbox.entries()).toHaveLength(1);
    expect(must(w.viewings.all()[0]).ranges).toEqual([[15, 645]]);
  });

  // The periodic sample at 645 s is the first whose played seconds reach the line.
  test('a periodic sample and an ended sample in flight at once report once', async () => {
    const w = makeWorld();
    await watch(w, episodeReading(1), 0, 630);
    await Promise.all([
      w.ingest.execute(observation(w, episodeReading(1), 645)),
      w.ingest.execute(
        observation(w, episodeReading(1), 1000, { sample: { ended: true, paused: true } }),
      ),
    ]);
    expect(w.outbox.entries()).toHaveLength(1);
    expect(must(w.viewings.all()[0]).ranges).toEqual([[15, 645]]);
  });
});

describe('a reading that names nothing of its own', () => {
  test('goes to the tab’s viewing, whose fields it carries', async () => {
    const w = makeWorld();
    await watch(w, episodeReading(1), 0, 600);
    const result = await observe(w, { contentEnded: true }, 615);
    expect(result.viewing?.key).toBe(E1);
    expect(result.viewing?.contentEnded).toBe(true);
    expect(result.viewing?.reading.showTitle).toBe('Show');
    expect(w.viewings.all()).toHaveLength(1);
  });

  test('starts nothing when no viewing is bound', async () => {
    const w = makeWorld();
    for (let i = 0; i < 4; i++) await observe(w, null, i * 15);
    for (let i = 4; i < 8; i++) await observe(w, { contentEnded: true }, i * 15);
    expect(w.viewings.all()).toEqual([]);
  });
});

describe('a player that is not playing', () => {
  test('the element’s ended ends the content past a skipped credit roll, and sends nothing by itself', async () => {
    const w = makeWorld();
    // 585 s played, short of the 616 s line; then a skip to the end.
    await watch(w, episodeReading(1), 0, 600);
    const ended = await observe(w, episodeReading(1), 1000, {
      sample: { ended: true, paused: true },
    });
    expect(ended.reported).toBe(false);
    expect(ended.viewing).toMatchObject({ state: 'open', contentEnded: true });
    expect(w.outbox.entries()).toEqual([]);
  });

  test('a pause closes the stretch played up to it, and is the sample the resume is measured from', async () => {
    // The media played up to the pause; nothing counts from it.
    const w = makeWorld();
    await watch(w, episodeReading(1), 0, 300);
    const paused = await observe(w, episodeReading(1), 305, { sample: { paused: true } });
    expect(paused.viewing?.ranges).toEqual([[15, 305]]);
    expect((await w.viewings.tabState(1))?.lastSample).toMatchObject({
      position: 305,
      paused: true,
    });
    const resumed = await observe(w, episodeReading(1), 305);
    expect(resumed.viewing?.ranges).toEqual([[15, 305]]);
  });

  test('a stopped player starts nothing', async () => {
    const w = makeWorld();
    await observe(w, episodeReading(1), 1000, { sample: { ended: true, paused: true } });
    await observe(w, episodeReading(1), 1000, { sample: { ended: true, paused: true } });
    expect(w.viewings.all()).toEqual([]);
  });
});

describe('what is not allowed', () => {
  test('(d) while tracking is paused, nothing changes', async () => {
    const w = makeWorld({ settings: { pausedUntil: T0 + HOUR_MS } });
    const result = await observe(w, episodeReading(1), 0);
    await observe(w, episodeReading(1), 15);
    expect(result).toEqual({ viewing: null, reported: false });
    expect(w.viewings.writes).toEqual({ put: 0, putTabState: 0, dropTab: 0, remove: 0 });
    expect(await w.viewings.tabState(1)).toBeNull();
  });

  test('(d) a pause in the middle of a viewing freezes it', async () => {
    const w = makeWorld();
    await watch(w, episodeReading(1), 0, 300);
    const before = await viewingOf(w, E1);
    await w.pause.execute(w.clock.now() + HOUR_MS);
    await watch(w, episodeReading(1), 315, 960);
    expect(await viewingOf(w, E1)).toEqual(before);
    expect(w.outbox.entries()).toEqual([]);
  });

  test('an incognito tab is not tracked unless the setting is on', async () => {
    const off = makeWorld();
    await observe(off, episodeReading(1), 0, { incognito: true });
    await observe(off, episodeReading(1), 15, { incognito: true });
    expect(off.viewings.writes.put + off.viewings.writes.putTabState).toBe(0);

    const on = makeWorld({ settings: { trackIncognito: true } });
    await observe(on, episodeReading(1), 0, { incognito: true });
    const bound = await observe(on, episodeReading(1), 15, { incognito: true });
    expect(bound.viewing?.incognito).toBe(true);
  });

  test('a service the person turned off is not tracked', async () => {
    const w = makeWorld({ settings: { disabledServices: ['netflix'] } });
    await observe(w, episodeReading(1), 0, { serviceId: 'netflix' });
    await observe(w, episodeReading(1), 15, { serviceId: 'netflix' });
    expect(w.viewings.all()).toEqual([]);
  });

  test('(e) a skipped viewing joined by a later sitting never reports', async () => {
    const w = makeWorld();
    await watch(w, episodeReading(1), 0, 300);
    const skipped = await viewingOf(w, E1);
    await w.skip.execute(skipped.id);
    await w.viewings.dropTab(1);
    w.clock.advance(DAY_MS);

    const results = await watch(w, episodeReading(1), 300, 1000, { tabId: 2 });
    expect(results.some((r) => r.reported)).toBe(false);
    const joined = must(await w.viewings.byId(skipped.id));
    expect(joined.state).toBe('skipped');
    expect(coverage(joined)).toBe(960);
    expect(w.viewings.all()).toHaveLength(1);
    expect(w.outbox.entries()).toEqual([]);
  });
});

describe('sittings', () => {
  // Neither sitting alone reaches the 70 % line, the account's: together they do.
  test('(f) two sittings a day apart reach the line in the second, and report once there', async () => {
    const w = makeWorld({ rule: { finishThresholdPercent: 70 } });
    const first = await watch(w, episodeReading(1), 0, 435);
    expect(first.some((r) => r.reported)).toBe(false);
    const viewing = await viewingOf(w, E1);
    await w.viewings.dropTab(1);
    w.clock.advance(DAY_MS);

    // 420 s played in the first; the second binds at 600 s and adds the 196 s still short of
    // the 616 s line at 796 s: the sample at 810 s.
    const second = await watch(w, episodeReading(1), 585, 885, { tabId: 2 });
    expect(second.flatMap((r, i) => (r.reported ? [585 + i * 15] : []))).toEqual([810]);
    const reported = must(await w.viewings.byId(viewing.id));
    expect(reported.state).toBe('reported');
    expect(coverage(reported)).toBe(630);
    expect(w.outbox.entries()).toHaveLength(1);
    expect(w.outbox.entries()[0]?.body.furthest_position_seconds).toBe(810);
  });

  test('the sitting that reported keeps its viewing until the playback stops', async () => {
    const w = makeWorld();
    await watch(w, episodeReading(1), 0, 960);
    const e1 = (await w.viewings.tabState(1))?.viewingId;
    expect(w.viewings.all()).toHaveLength(1);
    expect((await w.viewings.tabState(1))?.viewingId).toBe(e1);
  });

  test('a later sitting of a reported viewing starts a new one', async () => {
    const w = makeWorld();
    await watch(w, episodeReading(1), 0, 960);
    const reported = (await w.viewings.tabState(1))?.viewingId;
    w.clock.advance(10 * MINUTE_MS);

    const again = await watch(w, episodeReading(1), 0, 30);
    const rewatch = again.at(-1)?.viewing;
    expect(rewatch?.id).not.toBe(reported);
    expect(rewatch?.state).toBe('open');
    expect(rewatch?.ranges).toEqual([[0, 30]]);
    expect(w.outbox.entries()).toHaveLength(1);
  });
});
