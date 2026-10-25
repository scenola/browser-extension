/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The composition root's toolbar: each tab's icon, title and badge, as the status presenter sets
// them and as Chrome receives them — across a pause, a restart of the worker, Track this site,
// and a viewing whose samples come and go. Through the harness (test-harness.ts).

import { DEFAULT_RULE, PAUSE_INDEFINITELY } from '@mt/core';
import type { HistoryEntry } from '@mt/core';
import { describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { ActionStatusDisplay } from '../platform/status-display';
import { createRoot } from './root';
import {
  DAY,
  EPISODE_A,
  NETFLIX_BROWSE,
  PRIME_FILM,
  ROOT_ACCOUNT,
  T0,
  askUi,
  drainMicrotasks,
  episodeSnapshot,
  everyFifteen,
  filmSnapshot,
  harness,
  netflixLike,
  playFilm,
  report,
  sampleAt,
  sender,
  settle,
  shownFor,
  snapshotOf,
  tabFacts,
  useRootTestEnvironment,
} from './test-harness';
import type { Harness, HarnessOptions, OpenTab } from './test-harness';

useRootTestEnvironment();

describe('the toolbar icon per tab', () => {
  const lastOf = (h: Harness, tabId: number) =>
    h.status.shown.filter((s) => s.tabId === tabId).at(-1)?.status;

  test('a tracked tab that finished loading is ready, without any bootstrap message', async () => {
    const h = harness();
    await h.root.onTabAt(5, PRIME_FILM, false);
    expect(lastOf(h, 5)?.icon).toBe('outline');
    expect(lastOf(h, 5)?.tooltip.key).toBe('status.idle');
  });

  test('a tab with no readable address stays dimmed (nothing is shown for it)', async () => {
    const h = harness();
    await h.root.onTabAt(5, undefined, false);
    await h.root.onTabAt(6, 'chrome://extensions', false);
    expect(lastOf(h, 5)).toBeUndefined();
    expect(lastOf(h, 6)).toBeUndefined();
  });

  test('a site that is not tracked is dimmed', async () => {
    const h = harness();
    await h.root.onTabAt(5, 'https://not-allowed.example/film', false);
    expect(lastOf(h, 5)?.icon).toBe('dimmed');
    expect(lastOf(h, 5)?.tooltip.key).toBe('status.blocked');
  });

  test('a service turned off is dimmed and says which', async () => {
    const h = harness({ settings: { disabledServices: ['prime_video'] } });
    await h.root.onTabAt(5, PRIME_FILM, false);
    expect(lastOf(h, 5)?.icon).toBe('dimmed');
    expect(lastOf(h, 5)?.tooltip.key).toBe('status.service_off');
    expect(lastOf(h, 5)?.tooltip.params).toEqual({ service: 'Prime Video' });
  });

  test('an incognito tab is dimmed while incognito is not tracked, ready once it is', async () => {
    const off = harness();
    await off.root.onTabAt(5, PRIME_FILM, true);
    expect(lastOf(off, 5)?.icon).toBe('dimmed');
    expect(lastOf(off, 5)?.tooltip.key).toBe('status.incognito_off');
    const on = harness({ settings: { trackIncognito: true } });
    await on.root.onTabAt(5, PRIME_FILM, true);
    expect(lastOf(on, 5)?.icon).toBe('outline');
  });

  test('a tab that loads another page is not repainted by a refresh until it is seen again', async () => {
    const h = harness();
    await h.root.onTabAt(5, PRIME_FILM, false);
    const shown = h.status.shown.length;
    h.root.onTabLoading(5);
    await h.root.onWake();
    expect(h.status.shown.slice(shown).some((s) => s.tabId === 5)).toBe(false);
    await h.root.onTabAt(5, PRIME_FILM, false);
    expect(h.status.shown.slice(shown).some((s) => s.tabId === 5)).toBe(true);
  });

  test('the bootstrap of a tracked page gives the tab its ready icon; a refused one, its reason', async () => {
    const h = harness({ settings: { disabledServices: ['prime_video'] } });
    const off = { tabId: 1, frameId: 0, url: PRIME_FILM };
    await h.root.onContentMessage({ v: 1, type: 'bootstrap/play' }, sender(off));
    expect(lastOf(h, 1)?.icon).toBe('dimmed');
    expect(lastOf(h, 1)?.tooltip.key).toBe('status.service_off');
    const on = harness();
    await on.root.onContentMessage({ v: 1, type: 'bootstrap/play' }, sender(off));
    expect(lastOf(on, 1)?.icon).toBe('outline');
  });
});

describe('the toolbar icon says whether a tab is tracked', () => {
  /** The mark name (`outline`, `recording`, `check`, `dimmed`) last set for a tab or the default. */
  function toolbar(options: HarnessOptions = {}) {
    const setIcon = vi.spyOn(fakeBrowser.action, 'setIcon').mockResolvedValue(undefined);
    const h = harness({
      ...options,
      overrides: { ...options.overrides, status: new ActionStatusDisplay(fakeBrowser.action) },
    });
    const mark = (tabId: number | null): string | null => {
      const call = setIcon.mock.calls.filter(([a]) => (a.tabId ?? null) === tabId).at(-1)?.[0];
      const path = Object.values((call?.path ?? {}) as Record<string, string>)[0] ?? '';
      return /mark-([a-z]+)/u.exec(path)?.[1] ?? null;
    };
    const title = (tabId: number | null): Promise<string> =>
      fakeBrowser.action.getTitle(tabId === null ? {} : { tabId });
    const badge = (tabId: number | null): Promise<string> =>
      fakeBrowser.action.getBadgeText(tabId === null ? {} : { tabId });
    return { h, setIcon, mark, title, badge };
  }

  test('the default every tab starts with is the dimmed mark, and says so', async () => {
    const t = toolbar();
    await t.h.root.onWake();
    expect(t.mark(null)).toBe('dimmed');
    expect(await t.title(null)).toBe("Scenola isn't tracking this page");
  });

  test('a tracked page that finished loading is the outline mark, with no video playing', async () => {
    const t = toolbar();
    await t.h.root.onTabAt(5, PRIME_FILM, false);
    expect(t.mark(5)).toBe('outline');
    expect(await t.title(5)).toBe('Scenola — nothing playing');
  });

  test('an address Chrome does not give leaves the tab on the default: nothing is set for it', async () => {
    const t = toolbar();
    await t.h.root.onWake();
    const sets = t.setIcon.mock.calls.length;
    await t.h.root.onTabAt(5, undefined, false);
    expect(t.mark(5)).toBeNull();
    expect(t.setIcon.mock.calls.length).toBe(sets);
  });

  test('a viewing open in the tab is the green recording mark', async () => {
    const t = toolbar();
    await playFilm(t.h, { tabId: 1, frameId: 0, url: PRIME_FILM }, everyFifteen(45));
    expect(t.mark(1)).toBe('recording');
    expect(await t.title(1)).toBe('Tracking: Arrival');
  });

  test('a service turned off is the dimmed mark, and says which', async () => {
    const t = toolbar({ settings: { disabledServices: ['prime_video'] } });
    await t.h.root.onTabAt(5, PRIME_FILM, false);
    expect(t.mark(5)).toBe('dimmed');
    expect(await t.title(5)).toBe('Prime Video is turned off in Settings');
  });

  test('an incognito window that is not tracked is dimmed, and says so; once it is, it is ready', async () => {
    const off = toolbar();
    await off.h.root.onTabAt(5, PRIME_FILM, true);
    expect(off.mark(5)).toBe('dimmed');
    expect(await off.title(5)).toBe('Not tracking in incognito windows');
    const on = toolbar({ settings: { trackIncognito: true } });
    await on.h.root.onTabAt(5, PRIME_FILM, true);
    expect(on.mark(5)).toBe('outline');
  });

  test('a site the extension does not run on is dimmed', async () => {
    const t = toolbar();
    await t.h.root.onTabAt(5, 'https://not-allowed.example/film', false);
    expect(t.mark(5)).toBe('dimmed');
  });

  test('while tracking is paused, every tab is dimmed, a recording one too; resuming restores them', async () => {
    const t = toolbar();
    await playFilm(t.h, { tabId: 1, frameId: 0, url: PRIME_FILM }, everyFifteen(45));
    await t.h.root.onTabAt(5, PRIME_FILM, false);
    expect([t.mark(1), t.mark(5)]).toEqual(['recording', 'outline']);

    await askUi(t.h, { type: 'ui/pause', until: PAUSE_INDEFINITELY });
    expect([t.mark(null), t.mark(1), t.mark(5)]).toEqual(['dimmed', 'dimmed', 'dimmed']);
    expect(await t.title(1)).toBe('Tracking paused until you turn it back on');
    expect(await t.title(5)).toBe('Tracking paused until you turn it back on');

    await askUi(t.h, { type: 'ui/pause', until: null });
    expect([t.mark(1), t.mark(5)]).toEqual(['recording', 'outline']);
  });

  test('a pause that ends on its own gives every tab its mark back', async () => {
    const t = toolbar();
    await t.h.root.onTabAt(5, PRIME_FILM, false);
    await askUi(t.h, { type: 'ui/pause', until: T0 + 3_600_000 });
    expect([t.mark(null), t.mark(5)]).toEqual(['dimmed', 'dimmed']);
    t.h.clock.set(T0 + 3_600_000 + 1_000);
    await t.h.root.onAlarm('status');
    expect(t.mark(5)).toBe('outline');
    expect(await t.title(5)).toBe('Scenola — nothing playing');
  });

  test('a tab that loads another page is left to Chrome’s default until its bootstrap reports', async () => {
    const t = toolbar();
    await t.h.root.onTabAt(5, PRIME_FILM, false);
    const sets = t.setIcon.mock.calls.length;
    t.h.root.onTabLoading(5);
    await t.h.root.onWake();
    await t.h.root.onAlarm('status');
    expect(t.setIcon.mock.calls.slice(sets).filter(([a]) => a.tabId === 5)).toEqual([]);
    // The bootstrap of the new page reports: a tracked page, ready.
    await t.h.root.onContentMessage(
      { v: 1, type: 'bootstrap/play' },
      sender({ tabId: 5, frameId: 0, url: PRIME_FILM }),
    );
    expect(t.mark(5)).toBe('outline');
  });

  test('the badge keeps its rules: a problem is a red ! over whatever the tab’s icon is', async () => {
    const setBadgeBackgroundColor = vi.spyOn(fakeBrowser.action, 'setBadgeBackgroundColor');
    const t = toolbar({
      check: {
        kind: 'ok',
        accountKey: ROOT_ACCOUNT,
        status: 'braked',
        expiresAt: T0 + 60 * DAY,
        rule: DEFAULT_RULE,
      },
    });
    await t.h.root.onUiOpened();
    await t.h.root.onTabAt(5, 'https://not-allowed.example/film', false);
    await t.h.root.onTabAt(6, PRIME_FILM, false);
    expect(t.mark(5)).toBe('dimmed');
    expect(t.mark(6)).toBe('outline');
    expect(await t.badge(5)).toBe('!');
    expect(await t.badge(6)).toBe('!');
    expect(setBadgeBackgroundColor.mock.calls.at(-1)?.[0].color).toBe('#cc272b');
  });

  test('a tab’s badge is still the count of what waits, over the dimmed mark', async () => {
    // (Tab 5 is a site the extension does not run on; one play waits for the person.)
    const entry = (id: string): HistoryEntry => ({
      playId: id,
      body: { kind: 'movie', title: 'Arrival', watched_at: '2026-10-20T21:40:00+02:00' },
      label: 'Arrival',
      sentAt: T0 - 60_000,
      scrobbleId: `s-${id}`,
      receipt: { state: 'needs_confirmation', reason: 'text_only', titleId: null },
      receiptReadAt: T0 - 50_000,
      receiptGoneAt: null,
    });
    const t = toolbar();
    await t.h.history.put(entry('0192f1a2-7b3c-7d4e-8f5a-6b7c8d9e0f20'));
    await t.h.root.onTabAt(5, 'https://not-allowed.example/film', false);
    expect(t.mark(5)).toBe('dimmed');
    expect(await t.badge(5)).toBe('1');
  });
});

describe('a worker that restarted still reaches the icons the one before it set', () => {
  // Chrome keeps a tab's own icon across a restart of the worker, until the tab loads another
  // page; the new worker starts knowing nothing of it.
  const READY_TAB: OpenTab = { tabId: 5, url: PRIME_FILM, frames: [] };
  const restarted = (h: Harness): Harness => ({ ...h, root: createRoot(h.deps) });

  async function shownThenRestarted(options: HarnessOptions = {}): Promise<Harness> {
    const h = harness({ tabUrl: PRIME_FILM, openTabs: [READY_TAB], ...options });
    await h.root.onTabAt(5, PRIME_FILM, false);
    expect(shownFor(h, 5)?.icon).toBe('outline');
    return restarted(h);
  }

  test('a pause dims the tab', async () => {
    const h = await shownThenRestarted();
    await askUi(h, { type: 'ui/pause', until: PAUSE_INDEFINITELY });
    expect(shownFor(h, 5)?.icon).toBe('dimmed');
    expect(shownFor(h, 5)?.tooltip.key).toBe('status.paused_indefinitely');
  });

  test('a service turned off in Settings dims the tab, and says which', async () => {
    const h = await shownThenRestarted();
    await askUi(h, { type: 'ui/settings', patch: { disabledServices: ['prime_video'] } });
    expect(shownFor(h, 5)?.icon).toBe('dimmed');
    expect(shownFor(h, 5)?.tooltip.key).toBe('status.service_off');
  });

  test('a timed pause that ends gives the tab its mark back', async () => {
    const h = harness({ tabUrl: PRIME_FILM, openTabs: [READY_TAB] });
    await h.root.onTabAt(5, PRIME_FILM, false);
    await askUi(h, { type: 'ui/pause', until: T0 + 3_600_000 });
    expect(shownFor(h, 5)?.icon).toBe('dimmed');
    const after = restarted(h);
    after.clock.set(T0 + 3_600_000 + 1_000);
    await after.root.onAlarm('status');
    expect(shownFor(after, 5)?.icon).toBe('outline');
  });

  test('an incognito tab is told by Chrome’s word on it, not taken as tracked', async () => {
    const h = await shownThenRestarted({
      overrides: tabFacts({ url: PRIME_FILM, audible: false, incognito: true }),
    });
    await h.root.onWake();
    expect(shownFor(h, 5)?.icon).toBe('dimmed');
    expect(shownFor(h, 5)?.tooltip.key).toBe('status.incognito_off');
  });
});

describe('Track this site gives the tab its icon at once', () => {
  test('the tab it was asked from is ready without a reload or a play', async () => {
    const url = 'https://films.example/arrival';
    // Chrome granted the origin and the settings mirror it (`reconcile`); the tab's address is
    // readable from now on.
    const h = harness({
      granted: ['https://films.example'],
      settings: { allowedHosts: ['films.example'] },
      openTabs: [{ tabId: 7, url, frames: [] }],
      tabUrl: url,
    });
    await askUi(h, { type: 'ui/track-site', origin: 'https://films.example' });
    expect(shownFor(h, 7)?.icon).toBe('outline');
  });

  test('a grant from anywhere gives every open tab of the site its icon', async () => {
    const url = 'https://films.example/arrival';
    const h = harness({
      settings: { allowedHosts: ['films.example'] },
      openTabs: [{ tabId: 7, url, frames: [] }],
      tabUrl: url,
    });
    await h.root.onPermissionsChanged(['https://films.example/*']);
    expect(shownFor(h, 7)?.icon).toBe('outline');
  });
});

describe('the green mark: samples from the tab reach its viewing now', () => {
  const FRAME = { tabId: 1, frameId: 0, url: PRIME_FILM };
  const PRIME_BROWSE = 'https://www.primevideo.com/browse';

  /** The film's page finished loading (Chrome says so), and the film plays to 45 s. */
  async function recording(): Promise<Harness> {
    const h = harness();
    await h.root.onTabAt(1, PRIME_FILM, false);
    await playFilm(h, FRAME, everyFifteen(45));
    expect(shownFor(h, 1)?.icon).toBe('recording');
    return h;
  }

  test('a pause: ready at once, and the popup still shows the viewing', async () => {
    const h = await recording();
    h.clock.set(T0 + 50_000);
    await report(h, FRAME, sampleAt(h.clock, 50, { paused: true }), filmSnapshot(PRIME_FILM));
    await settle();
    expect(shownFor(h, 1)?.icon).toBe('outline');
    expect((await h.root.uiState(1)).nowPlaying).toMatchObject({ state: 'tracking' });
  });

  test('samples that stop: green for 30 s after the last one, then ready on its own', async () => {
    const h = await recording();
    h.clock.set(T0 + 75_000);
    await h.root.onAlarm('status');
    expect(shownFor(h, 1)?.icon).toBe('recording');
    h.clock.set(T0 + 76_000);
    await vi.advanceTimersByTimeAsync(31_000);
    await drainMicrotasks();
    expect(shownFor(h, 1)?.icon).toBe('outline');
  });

  test('another page in the same document: ready at once, the viewing kept', async () => {
    const h = await recording();
    h.clock.advance(2_000);
    await h.root.onTabAt(1, PRIME_BROWSE, false);
    expect(shownFor(h, 1)?.icon).toBe('outline');
    expect(h.viewings.all()[0]?.state).toBe('open');
  });

  test('a page loaded in the tab: ready once it loads, green again once a sample reaches a viewing', async () => {
    const h = await recording();
    h.clock.advance(2_000);
    h.root.onTabLoading(1);
    await h.root.onTabAt(1, PRIME_BROWSE, false);
    expect(shownFor(h, 1)?.icon).toBe('outline');
    // Back on the film, whose samples go to its viewing again.
    await h.root.onTabAt(1, PRIME_FILM, false);
    await playFilm(h, FRAME, [60, 75], filmSnapshot(PRIME_FILM), 60);
    expect(shownFor(h, 1)?.icon).toBe('recording');
  });

  test('a query or a hash the page rewrites as it plays is no navigation', async () => {
    const h = await recording();
    h.clock.advance(2_000);
    await h.root.onTabAt(1, `${PRIME_FILM}#t=47`, false);
    await h.root.onTabAt(1, `${PRIME_FILM}?t=48`, false);
    expect(shownFor(h, 1)?.icon).toBe('recording');
  });

  test('back on Netflix’s browse page, a billboard that plays: ready, as the popup says', async () => {
    const h = harness({ interpret: netflixLike });
    await playFilm(
      h,
      { tabId: 1, frameId: 0, url: EPISODE_A },
      everyFifteen(45),
      episodeSnapshot(EPISODE_A),
    );
    expect(shownFor(h, 1)?.icon).toBe('recording');
    // The pushState to /browse, as the reports alone tell it (no address change was seen).
    await playFilm(
      h,
      { tabId: 1, frameId: 0, url: NETFLIX_BROWSE },
      [0, 15],
      snapshotOf(NETFLIX_BROWSE),
      60,
    );
    expect(shownFor(h, 1)?.icon).toBe('outline');
  });
});
