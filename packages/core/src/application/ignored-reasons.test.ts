/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Why a playing video went nowhere. The core keeps, per tab, the first gate a playing sample
// failed (`TabState.ignored`): it is set by a playing sample that reached no viewing, cleared by
// one that binds or reaches a viewing, and left alone by a paused or ended one.

import { describe, expect, test } from 'vitest';

import type { EntryVerdict } from '../domain/entry-rule';
import type { PlaybackSample } from '../domain/coverage';
import type { FrameReport } from '../domain/frames';
import { IGNORED_REASONS, ignoredOf } from '../domain/ignored';
import type { IgnoredReason } from '../domain/ignored';
import type { Field, ServiceReading } from '../domain/reading';
import { T0, episodeReading, filmReading, makeWorld, must } from './test-world';
import type { World } from './test-world';

const module_ = <T>(value: T): Field<T> => ({ value, confidence: 1, source: 'module' });

interface Page {
  readonly reading?: ServiceReading | null;
  readonly sample?: Partial<PlaybackSample>;
  readonly entry?: EntryVerdict;
  readonly serviceId?: string | null;
}

/** One observation at the clock's time (one second after the last), then the clock moves on. */
async function see(w: World, page: Page, stepMs = 15_000) {
  const sample: PlaybackSample = {
    at: w.clock.now(),
    position: 100,
    duration: 1000,
    paused: false,
    ended: false,
    rate: 1,
    adPlaying: false,
    muted: false,
    visibleArea: 1,
    ...page.sample,
  };
  const frame: FrameReport = {
    frameId: 0,
    isTop: true,
    sample,
    reading: page.reading ?? null,
    generic: [],
    ...(page.entry === undefined ? {} : { entry: page.entry }),
  };
  const result = await w.ingest.execute({
    tabId: 1,
    incognito: false,
    serviceId: page.serviceId ?? null,
    frames: [frame],
  });
  w.clock.advance(stepMs);
  return result;
}

const reasonOf = async (w: World) => ignoredOf((await w.viewings.tabState(1))?.ignored)?.reason;

describe('the reasons are one closed list, in the pipeline’s order', () => {
  test('eleven gates in order, then the one only the worker can tell', () => {
    expect(IGNORED_REASONS).toEqual([
      'tracking_paused',
      'incognito',
      'service_off',
      'not_player_page',
      'ad',
      'short',
      'muted',
      'page_silent',
      'series_no_episode',
      'no_title',
      'settling',
      'player_unreachable',
    ]);
  });

  test('a stored value that is not a reason with a time is no reason', () => {
    expect(ignoredOf(undefined)).toBeNull();
    expect(ignoredOf(null)).toBeNull();
    expect(ignoredOf({ reason: 'nonsense', at: 1 })).toBeNull();
    expect(ignoredOf({ reason: 'ad' })).toBeNull();
    expect(ignoredOf({ reason: 'ad', at: '1' })).toBeNull();
    expect(ignoredOf({ reason: 'ad', at: 5 })).toEqual({ reason: 'ad', at: 5 });
  });
});

describe('each gate the core owns', () => {
  test('an ad: the page says so and the page names no film', async () => {
    const w = makeWorld();
    const result = await see(w, { sample: { adPlaying: true } });
    expect(await reasonOf(w)).toBe('ad');
    expect(result.newlyIgnored).toBe('ad');
  });

  test('an ad a module reports counts as well as the element’s own signal', async () => {
    const w = makeWorld();
    await see(w, { reading: { adPlaying: true }, serviceId: 'x' });
    expect(await reasonOf(w)).toBe('ad');
  });

  test('media whose length is known and under two minutes is short', async () => {
    const w = makeWorld();
    await see(w, { reading: filmReading('Trailer'), sample: { duration: 119 } });
    expect(await reasonOf(w)).toBe('short');
  });

  test('two minutes exactly is content: the gate it fails is the next one', async () => {
    const w = makeWorld();
    await see(w, { reading: filmReading('Film'), sample: { duration: 120 } });
    expect(await reasonOf(w)).toBe('settling');
  });

  test('a length that is not known is not short', async () => {
    const w = makeWorld();
    await see(w, { reading: filmReading('Film'), sample: { duration: null } });
    expect(await reasonOf(w)).toBe('settling');
  });

  test('an element under two minutes with an ad signal is an ad, not short', async () => {
    const w = makeWorld();
    await see(w, { reading: filmReading('Film'), sample: { duration: 30, adPlaying: true } });
    expect(await reasonOf(w)).toBe('ad');
  });

  test('a muted element that may not open a viewing is muted, at once', async () => {
    const w = makeWorld();
    await see(w, { reading: filmReading('Film'), sample: { muted: true } });
    expect(await reasonOf(w)).toBe('muted');
    await see(w, { reading: filmReading('Film'), sample: { muted: true } });
    expect(await reasonOf(w)).toBe('muted');
    expect(w.viewings.all()).toEqual([]);
  });

  test('a site without a module whose page failed the entry rule is page_silent', async () => {
    const w = makeWorld();
    await see(w, { entry: 'silent' });
    expect(await reasonOf(w)).toBe('page_silent');
  });

  test('on a module’s site, a reading that names nothing is page_silent too', async () => {
    const w = makeWorld();
    await see(w, { serviceId: 'x', reading: null });
    expect(await reasonOf(w)).toBe('page_silent');
  });

  test('a series page whose address names no single episode is series_no_episode', async () => {
    const w = makeWorld();
    await see(w, { entry: 'series' });
    expect(await reasonOf(w)).toBe('series_no_episode');
  });

  test.each([
    ['a season and no episode', { season: module_(1) }],
    ['an episode and no season', { episode: module_(1) }],
    ['neither', {}],
  ])('an episode with %s, without a service id, is series_no_episode', async (_n, numbers) => {
    const w = makeWorld();
    await see(w, {
      reading: { kind: module_('episode'), showTitle: module_('Show'), ...numbers },
    });
    expect(await reasonOf(w)).toBe('series_no_episode');
  });

  test('a film with no title and no id is no_title', async () => {
    const w = makeWorld();
    await see(w, { reading: { kind: module_('movie') } });
    expect(await reasonOf(w)).toBe('no_title');
  });

  test('an episode with both numbers and no show title is no_title', async () => {
    const w = makeWorld();
    await see(w, {
      reading: { kind: module_('episode'), season: module_(1), episode: module_(2) },
    });
    expect(await reasonOf(w)).toBe('no_title');
  });

  test('a named reading that has not held still is settling, and binds on the second look', async () => {
    const w = makeWorld();
    const first = await see(w, { reading: episodeReading(1) });
    expect(await reasonOf(w)).toBe('settling');
    expect(first.newlyIgnored).toBe('settling');
    const second = await see(w, { reading: episodeReading(1) });
    // It bound: the reason is cleared.
    expect(second.viewing).not.toBeNull();
    expect(await reasonOf(w)).toBeUndefined();
    expect((await w.viewings.tabState(1))?.ignored).toBeNull();
  });
});

describe('the first gate wins', () => {
  test.each<[string, Page, IgnoredReason]>([
    [
      'ad over muted and silent',
      { sample: { adPlaying: true, muted: true }, entry: 'silent' },
      'ad',
    ],
    [
      'short over muted',
      { reading: filmReading('Film'), sample: { duration: 60, muted: true } },
      'short',
    ],
    ['short over a silent page', { entry: 'silent', sample: { duration: 60 } }, 'short'],
    ['muted over a silent page', { entry: 'silent', sample: { muted: true } }, 'muted'],
    [
      'muted over an unnumbered episode',
      { reading: { kind: module_('episode'), showTitle: module_('S') }, sample: { muted: true } },
      'muted',
    ],
    ['page_silent over settling', { entry: 'silent' }, 'page_silent'],
  ])('%s', async (_name, page, reason) => {
    const w = makeWorld();
    await see(w, page);
    expect(await reasonOf(w)).toBe(reason);
  });
});

describe('when the reason is set, kept and cleared', () => {
  test('it carries the time of the observation that set it, and is renewed by the next', async () => {
    const w = makeWorld();
    const t0 = w.clock.now();
    await see(w, { entry: 'silent' });
    expect((await w.viewings.tabState(1))?.ignored).toEqual({ reason: 'page_silent', at: t0 });
    await see(w, { entry: 'silent' });
    expect((await w.viewings.tabState(1))?.ignored).toEqual({
      reason: 'page_silent',
      at: t0 + 15_000,
    });
  });

  test('a change of reason is told once; the same reason again is not', async () => {
    const w = makeWorld();
    const first = await see(w, { entry: 'silent' });
    const again = await see(w, { entry: 'silent' });
    const other = await see(w, { entry: 'series' });
    expect(first.newlyIgnored).toBe('page_silent');
    expect(again.newlyIgnored).toBeUndefined();
    expect(other.newlyIgnored).toBe('series_no_episode');
  });

  test('a paused sample neither sets a reason nor clears the kept one', async () => {
    const w = makeWorld();
    await see(w, { entry: 'silent', sample: { paused: true } });
    expect(await reasonOf(w)).toBeUndefined();
    await see(w, { entry: 'silent' });
    const kept = (await w.viewings.tabState(1))?.ignored;
    expect(kept?.reason).toBe('page_silent');
    await see(w, { entry: 'silent', sample: { paused: true } });
    expect((await w.viewings.tabState(1))?.ignored).toEqual(kept);
  });

  test('beside a bound viewing, a paused or ended sample that goes nowhere leaves the kept reason', async () => {
    const w = makeWorld();
    const film = filmReading('Film', 2000);
    const other = filmReading('Other', 2001);
    for (let p = 0; p <= 60; p += 15) await see(w, { reading: film, sample: { position: p } });
    // Another film starts to load (a new length, from the start): it has not held still.
    await see(w, { reading: other, sample: { position: 0, duration: 2000 } });
    const kept = (await w.viewings.tabState(1))?.ignored;
    expect(kept?.reason).toBe('settling');
    const paused = await see(w, {
      reading: other,
      sample: { position: 30, duration: 2000, paused: true },
    });
    expect((await w.viewings.tabState(1))?.ignored).toEqual(kept);
    expect(paused.newlyIgnored).toBeUndefined();
    const ended = await see(w, {
      reading: other,
      sample: { position: 60, duration: 2000, paused: true, ended: true },
    });
    expect((await w.viewings.tabState(1))?.ignored).toEqual(kept);
    expect(ended.newlyIgnored).toBeUndefined();
  });

  test('an ended sample leaves the kept reason as it is', async () => {
    const w = makeWorld();
    await see(w, { entry: 'silent' });
    const kept = (await w.viewings.tabState(1))?.ignored;
    await see(w, { entry: 'silent', sample: { ended: true, paused: true } });
    expect((await w.viewings.tabState(1))?.ignored).toEqual(kept);
  });

  test('a sample that reaches the viewing clears it', async () => {
    const w = makeWorld();
    const film = filmReading('Film', 2000);
    await see(w, { entry: 'silent' });
    expect(await reasonOf(w)).toBe('page_silent');
    await see(w, { reading: film });
    await see(w, { reading: film });
    expect((await w.viewings.tabState(1))?.ignored).toBeNull();
  });
});

describe('what the bound viewing explains is not a reason', () => {
  async function bound(w: World) {
    const film = filmReading('Film', 2000);
    for (let p = 0; p <= 60; p += 15) await see(w, { reading: film, sample: { position: p } });
    expect((await w.viewings.tabState(1))?.ignored).toBeNull();
    return film;
  }

  test('ad time inside the sitting’s 75 seconds is the sitting’s ad break', async () => {
    const w = makeWorld();
    await bound(w);
    // The clock moved 15 s after the last taken sample; 59 s more is 74 s, inside the 75.
    w.clock.advance(59_000);
    const result = await see(w, { sample: { duration: 30, adPlaying: true } });
    expect(result.newlyIgnored).toBeUndefined();
    expect(await reasonOf(w)).toBeUndefined();
    expect((await w.viewings.tabState(1))?.ignored).toBeNull();
  });

  test('ad time outside it is an ad', async () => {
    const w = makeWorld();
    await bound(w);
    w.clock.advance(61_000);
    // 15 + 61 = 76 s after the last taken sample.
    await see(w, { sample: { duration: 30, adPlaying: true } });
    expect(await reasonOf(w)).toBe('ad');
  });

  test('an end screen that names nothing gives no reason', async () => {
    const w = makeWorld();
    await bound(w);
    const result = await see(w, {
      reading: { contentEnded: true },
      serviceId: null,
      sample: { position: 80 },
    });
    expect(result.newlyIgnored).toBeUndefined();
    expect((await w.viewings.tabState(1))?.ignored).toBeNull();
  });
});

describe('a playing sample the worker dropped before the core', () => {
  test('is kept as the tab’s reason, and told only when it is new', async () => {
    const w = makeWorld();
    const t0 = w.clock.now();
    expect(await w.ingest.ignore(1, 'not_player_page')).toBe(true);
    expect((await w.viewings.tabState(1))?.ignored).toEqual({ reason: 'not_player_page', at: t0 });
    expect(await w.ingest.ignore(1, 'not_player_page')).toBe(false);
    expect(await w.ingest.ignore(1, 'tracking_paused')).toBe(true);
  });

  test('keeps the tab’s other state', async () => {
    const w = makeWorld();
    const film = filmReading('Film', 2000);
    await see(w, { reading: film });
    await see(w, { reading: film });
    const before = must(await w.viewings.tabState(1));
    await w.ingest.ignore(1, 'not_player_page');
    const after = must(await w.viewings.tabState(1));
    expect(after.viewingId).toBe(before.viewingId);
    expect(after.stableCount).toBe(before.stableCount);
  });
});

describe('the gates before the core change nothing', () => {
  test('tracking paused: no reason is written, the tab is not even created', async () => {
    const w = makeWorld({ settings: { pausedUntil: T0 + 3_600_000 } });
    await see(w, { entry: 'silent' });
    expect(await w.viewings.tabState(1)).toBeNull();
  });

  test('a service the person turned off writes nothing', async () => {
    const w = makeWorld({ settings: { disabledServices: ['netflix'] } });
    await see(w, { serviceId: 'netflix', entry: 'silent' });
    expect(await w.viewings.tabState(1)).toBeNull();
  });
});
