/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Chrome implementations of the settings, scheduler, status and site-permission ports, against WXT's fake browser (test/setup/fake-browser.ts). `permissions` and
// `scripting`, which the fake browser does not implement, are hand-written fakes here.

import { FakeClock } from '@mt/core/testing';
import type { Status } from '@mt/core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { MatchPattern } from 'wxt/utils/match-patterns';

import { AlarmScheduler } from './scheduler';
import { ChromeSettings } from './settings';
import { ChromeSitePermissions } from './site-permissions';
import { ActionStatusDisplay } from './status-display';

const T0 = Date.UTC(2026, 9, 20, 19, 40);

describe('ChromeSettings', () => {
  // An absent value migrates to the defaults: incognito off, diagnostics off, history 7 days,
  // the built-ins already on, all sites only from the switch.
  test('an absent value reads as the version-3 defaults', async () => {
    expect(await new ChromeSettings().get()).toEqual({
      // Version 3 drops the counting threshold version 2 added; the finish line is the
      // account's.
      pausedUntil: null,
      trackIncognito: false,
      disabledServices: [],
      excludedHosts: [],
      allowedHosts: [],
      allSites: false,
      diagnostics: false,
      historyDays: 7,
    });
  });

  test.each([1, 7, 30] as const)('a history kept %i days is stored and read back', async (days) => {
    await new ChromeSettings().patch({ historyDays: days });
    expect((await new ChromeSettings().get()).historyDays).toBe(days);
  });

  // The value lives in `chrome.storage.local` under the key `settings` and round-trips through it.
  test('a patch is stored under `settings` and read back by another instance', async () => {
    await new ChromeSettings().patch({ trackIncognito: true, excludedHosts: ['films.example'] });
    const stored = await fakeBrowser.storage.local.get('settings');
    expect(stored).toHaveProperty('settings');
    const again = await new ChromeSettings().get();
    expect(again.trackIncognito).toBe(true);
    expect(again.excludedHosts).toEqual(['films.example']);
    expect(again.diagnostics).toBe(false);
  });

  // Storage contents are hostile: a reader is total.
  test.each([
    ['garbage'],
    [42],
    [null],
    [{ trackIncognito: 'yes', excludedHosts: 'x', historyDays: 365 }],
  ])('a stored %j reads as valid settings, never a throw', async (stored) => {
    await fakeBrowser.storage.local.set({ settings: stored });
    const value = await new ChromeSettings().get();
    expect(value.trackIncognito).toBe(false);
    expect(value.excludedHosts).toEqual([]);
    // A length the page never offers reads as the default.
    expect(value.historyDays).toBe(7);
  });
});

describe('AlarmScheduler', () => {
  // `at` with a past time schedules at least 30 s ahead (`chrome.alarms` has a 30 s minimum
  // period).
  test('a past time is scheduled at least 30 s ahead', async () => {
    const clock = new FakeClock(T0);
    await new AlarmScheduler(fakeBrowser.alarms, clock).at('outbox', T0 - 60_000);
    const alarm = await fakeBrowser.alarms.get('outbox');
    expect(alarm?.scheduledTime).toBeGreaterThanOrEqual(T0 + 30_000);
  });

  // A time past the floor is kept.
  test('a time beyond 30 s is scheduled as asked', async () => {
    const clock = new FakeClock(T0);
    await new AlarmScheduler(fakeBrowser.alarms, clock).at('receipts', T0 + 600_000);
    expect((await fakeBrowser.alarms.get('receipts'))?.scheduledTime).toBe(T0 + 600_000);
  });

  // The earliest wins for a pending alarm of the same name.
  test('a pending earlier alarm is kept; an earlier one replaces a later', async () => {
    const clock = new FakeClock(T0);
    const scheduler = new AlarmScheduler(fakeBrowser.alarms, clock);
    await scheduler.at('outbox', T0 + 120_000);
    await scheduler.at('outbox', T0 + 600_000);
    expect((await fakeBrowser.alarms.get('outbox'))?.scheduledTime).toBe(T0 + 120_000);
    await scheduler.at('outbox', T0 + 60_000);
    expect((await fakeBrowser.alarms.get('outbox'))?.scheduledTime).toBe(T0 + 60_000);
  });

  // PAUSE_INDEFINITELY is never formatted or scheduled.
  test('an indefinite pause is never scheduled', async () => {
    const scheduler = new AlarmScheduler(fakeBrowser.alarms, new FakeClock(T0));
    await scheduler.at('status', Number.MAX_SAFE_INTEGER).catch(() => undefined);
    expect(await fakeBrowser.alarms.get('status')).toBeUndefined();
  });
});

describe('ActionStatusDisplay', () => {
  // The fake browser implements the badge and the title but not `setIcon`.
  beforeEach(() => {
    vi.spyOn(fakeBrowser.action, 'setIcon').mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const status = (s: Partial<Status>): Status => ({
    icon: 'outline',
    badge: null,
    tooltip: { key: 'status.idle', params: {} },
    ...s,
  });

  // `show` calls setBadgeText({ text: "3", tabId }) for a lamp badge (waiting: lamp `1`, `2`…).
  test('a lamp badge is set on its tab only', async () => {
    const display = new ActionStatusDisplay(fakeBrowser.action);
    await display.show(
      3,
      status({
        icon: 'recording',
        badge: { text: '3', tone: 'lamp' },
        tooltip: { key: 'status.waiting', params: { count: 3 } },
      }),
    );
    expect(await fakeBrowser.action.getBadgeText({ tabId: 3 })).toBe('3');
    expect(await fakeBrowser.action.getBadgeText({})).toBe('');
    expect(await fakeBrowser.action.getBadgeText({ tabId: 4 })).toBe('');
  });

  // A status is either per tab or global.
  test('a global status sets every tab’s default', async () => {
    const display = new ActionStatusDisplay(fakeBrowser.action);
    await display.show(
      null,
      status({
        badge: { text: '!', tone: 'danger' },
        tooltip: { key: 'status.disconnected', params: {} },
      }),
    );
    expect(await fakeBrowser.action.getBadgeText({})).toBe('!');
  });

  // A problem shows a red `!`.
  test('a danger badge is red', async () => {
    const setBadgeBackgroundColor = vi.spyOn(fakeBrowser.action, 'setBadgeBackgroundColor');
    await new ActionStatusDisplay(fakeBrowser.action).show(
      5,
      status({
        badge: { text: '!', tone: 'danger' },
        tooltip: { key: 'status.disconnected', params: {} },
      }),
    );
    const color = setBadgeBackgroundColor.mock.calls.at(-1)?.[0].color;
    expect(typeof color).toBe('string');
    const hex = String(color).replace('#', '');
    const channel = (i: number): number => Number.parseInt(hex.slice(i, i + 2), 16);
    const [r, g, b] = [channel(0), channel(2), channel(4)];
    expect(r).toBeGreaterThan(2 * g);
    expect(r).toBeGreaterThan(2 * b);
  });

  // The tooltip always says the state in words.
  test.each([
    [{ key: 'status.idle', params: {} }, 'MediaTracker — nothing playing'],
    [
      { key: 'status.tracking', params: { label: 'Breaking Bad · S1 E2' } },
      'Tracking: Breaking Bad · S1 E2',
    ],
    [
      { key: 'status.added', params: { label: 'Breaking Bad · S1 E2' } },
      'Added to your diary: Breaking Bad · S1 E2',
    ],
    [{ key: 'status.waiting', params: { count: 2 } }, '2 viewings to confirm in MediaTracker'],
  ] as const)('the tooltip of %j is “%s”', async (tooltip, words) => {
    await new ActionStatusDisplay(fakeBrowser.action).show(6, status({ tooltip }));
    expect(await fakeBrowser.action.getTitle({ tabId: 6 })).toBe(words);
  });

  // The marks (outline / green recording / filled with a check / dimmed)
  test.each([
    ['outline', 'mark-outline'],
    ['recording', 'mark-recording'],
    ['filled-check', 'mark-check'],
    ['dimmed', 'mark-dimmed'],
  ] as const)('the %s icon is the %s mark', async (icon, mark) => {
    const setIcon = vi.mocked(fakeBrowser.action.setIcon);
    await new ActionStatusDisplay(fakeBrowser.action).show(8, status({ icon }));
    const call = setIcon.mock.calls.at(-1)?.[0];
    expect(call?.tabId).toBe(8);
    const paths = Object.values((call?.path ?? {}) as Record<string, string>);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path).toContain(mark);
  });

  // The extension stays light on the browser: every observation refreshes the icon, and in a
  // service worker each `setIcon(path)` fetches and decodes the PNGs. What did not change is not
  // set again.
  describe('only what changed is set', () => {
    const tracking = status({
      icon: 'recording',
      tooltip: { key: 'status.tracking', params: { label: 'Breaking Bad · S1 E2' } },
    });

    test('the same status twice sets nothing the second time', async () => {
      const display = new ActionStatusDisplay(fakeBrowser.action);
      const setTitle = vi.spyOn(fakeBrowser.action, 'setTitle');
      const setBadgeText = vi.spyOn(fakeBrowser.action, 'setBadgeText');
      await display.show(9, tracking);
      await display.show(9, tracking);
      expect(vi.mocked(fakeBrowser.action.setIcon)).toHaveBeenCalledTimes(1);
      expect(setTitle).toHaveBeenCalledTimes(1);
      expect(setBadgeText).toHaveBeenCalledTimes(1);
    });

    test('a new tooltip sets the tooltip, not the icon', async () => {
      const display = new ActionStatusDisplay(fakeBrowser.action);
      await display.show(9, tracking);
      const later = status({
        icon: 'recording',
        tooltip: { key: 'status.tracking', params: { label: 'Breaking Bad · S1 E3' } },
      });
      await display.show(9, later);
      expect(vi.mocked(fakeBrowser.action.setIcon)).toHaveBeenCalledTimes(1);
      expect(await fakeBrowser.action.getTitle({ tabId: 9 })).toBe(
        'Tracking: Breaking Bad · S1 E3',
      );
    });

    test('a new icon or badge is set', async () => {
      const display = new ActionStatusDisplay(fakeBrowser.action);
      await display.show(9, tracking);
      await display.show(9, { ...tracking, icon: 'filled-check' });
      expect(vi.mocked(fakeBrowser.action.setIcon)).toHaveBeenCalledTimes(2);
      await display.show(9, {
        ...tracking,
        icon: 'filled-check',
        badge: { text: '2', tone: 'lamp' },
      });
      expect(await fakeBrowser.action.getBadgeText({ tabId: 9 })).toBe('2');
      expect(vi.mocked(fakeBrowser.action.setIcon)).toHaveBeenCalledTimes(2);
    });

    test('each tab and the default are their own', async () => {
      const display = new ActionStatusDisplay(fakeBrowser.action);
      await display.show(9, tracking);
      await display.show(10, tracking);
      await display.show(null, tracking);
      expect(vi.mocked(fakeBrowser.action.setIcon)).toHaveBeenCalledTimes(3);
    });

    // Chrome resets a tab's own icon, badge and title when the tab loads a new page: what was
    // set there before is forgotten, and the next show sets it all again.
    test('a tab forgotten (it navigated or closed) is set again in full', async () => {
      const display = new ActionStatusDisplay(fakeBrowser.action);
      await display.show(9, tracking);
      display.forget(9);
      await display.show(9, tracking);
      expect(vi.mocked(fakeBrowser.action.setIcon)).toHaveBeenCalledTimes(2);
    });

    test('a show that failed is tried again in full', async () => {
      const display = new ActionStatusDisplay(fakeBrowser.action);
      vi.mocked(fakeBrowser.action.setIcon).mockRejectedValueOnce(new Error('No tab with id: 9'));
      await display.show(9, tracking);
      await display.show(9, tracking);
      expect(vi.mocked(fakeBrowser.action.setIcon)).toHaveBeenCalledTimes(2);
      expect(await fakeBrowser.action.getTitle({ tabId: 9 })).toBe(
        'Tracking: Breaking Bad · S1 E2',
      );
    });
  });
});

describe('ChromeSitePermissions.reconcile', () => {
  /** What install grants: the built-ins and the development API. */
  const REQUIRED = [
    'netflix.com',
    'tv.apple.com',
    'primevideo.com',
    'disneyplus.com',
    'hbomax.com',
    'crunchyroll.com',
    'paramountplus.com',
  ]
    .flatMap((host) => [`https://*.${host}/*`, `https://${host}/*`])
    .concat(['http://localhost:8000/*']);

  interface Registered {
    readonly id: string;
    readonly js?: readonly string[];
    readonly matches?: readonly string[];
    readonly excludeMatches?: readonly string[];
    readonly persistAcrossSessions?: boolean;
  }

  function fakes(granted: readonly string[]) {
    let registered: Registered[] = [];
    const permissions = {
      getAll: vi.fn(() => Promise.resolve({ origins: [...REQUIRED, ...granted], permissions: [] })),
      contains: vi.fn(() => Promise.resolve(false)),
      request: vi.fn(() => Promise.resolve(false)),
      remove: vi.fn(() => Promise.resolve(true)),
    };
    const scripting = {
      getRegisteredContentScripts: vi.fn((filter?: { ids?: string[] }) =>
        Promise.resolve(registered.filter((s) => filter?.ids?.includes(s.id) ?? true)),
      ),
      registerContentScripts: vi.fn((scripts: Registered[]) => {
        registered = [...registered, ...scripts];
        return Promise.resolve();
      }),
      updateContentScripts: vi.fn((scripts: Registered[]) => {
        registered = registered.map((s) => scripts.find((n) => n.id === s.id) ?? s);
        return Promise.resolve();
      }),
      unregisterContentScripts: vi.fn((filter?: { ids?: string[] }) => {
        registered = registered.filter((s) => !(filter?.ids?.includes(s.id) ?? true));
        return Promise.resolve();
      }),
    };
    type Args = ConstructorParameters<typeof ChromeSitePermissions>;
    return {
      permissions: permissions as unknown as Args[0],
      scripting: scripting as unknown as Args[1],
      registered: () => registered,
    };
  }

  /** Whether the registration injects into `url`: matched and not excluded (Chrome's rule). */
  function injects(script: Registered | undefined, url: string): boolean {
    if (script === undefined) return false;
    const hit = (patterns: readonly string[] | undefined) =>
      (patterns ?? []).some((p) => new MatchPattern(p).includes(url));
    return hit(script.matches) && !hit(script.excludeMatches);
  }

  const sorted = (xs: readonly string[] | undefined) => [...(xs ?? [])].sort();

  // `reconcile()` registers exactly the granted origins minus blocked hosts, as the script
  // `mt-bootstrap-granted` with persistAcrossSessions. YouTube and russian domains are blocked.
  test('registers the bootstrap on exactly the granted origins minus the blocked hosts', async () => {
    const { permissions, scripting, registered } = fakes([
      'https://example.org/*',
      'https://films.example/*',
      'https://www.kinopoisk.ru/*',
      'https://*.youtube.com/*',
      'https://watch.example.ru/*',
    ]);
    const settings = new ChromeSettings();
    await new ChromeSitePermissions(permissions, scripting, settings).reconcile();

    const scripts = registered();
    expect(scripts).toHaveLength(1);
    const [script] = scripts;
    expect(script?.id).toBe('mt-bootstrap-granted');
    expect(script?.js).toEqual(['bootstrap.js']);
    expect(script?.persistAcrossSessions).toBe(true);
    expect(sorted(script?.matches)).toEqual(
      sorted(['https://example.org/*', 'https://films.example/*']),
    );
    expect(injects(script, 'https://www.kinopoisk.ru/film/1')).toBe(false);
    expect(injects(script, 'https://www.youtube.com/watch?v=x')).toBe(false);
  });

  // What is registered is the grants minus the block list and the person's exclusions.
  test('an excluded host is not injected into, even when granted', async () => {
    const { permissions, scripting, registered } = fakes([
      'https://example.org/*',
      'https://films.example/*',
    ]);
    const settings = new ChromeSettings();
    await settings.patch({ excludedHosts: ['films.example'] });
    await new ChromeSitePermissions(permissions, scripting, settings).reconcile();
    const [script] = registered();
    expect(injects(script, 'https://example.org/film')).toBe(true);
    expect(injects(script, 'https://films.example/film')).toBe(false);
  });

  // The built-ins are declared in the manifest, not registered again
  test('the built-in hosts and the API are not registered at run time', async () => {
    const { permissions, scripting, registered } = fakes(['https://example.org/*']);
    await new ChromeSitePermissions(permissions, scripting, new ChromeSettings()).reconcile();
    const [script] = registered();
    expect(injects(script, 'https://www.netflix.com/watch/70196253')).toBe(false);
    expect(sorted(script?.matches)).toEqual(['https://example.org/*']);
  });

  // Registration is for every granted optional origin: nothing granted, nothing registered.
  test('with nothing granted, nothing is registered', async () => {
    const { permissions, scripting, registered } = fakes([]);
    await new ChromeSitePermissions(permissions, scripting, new ChromeSettings()).reconcile();
    expect(registered()).toEqual([]);
  });

  // The granted permissions are the truth, mirrored into the settings by `reconcile()`.
  test('the grants are mirrored into allowedHosts and allSites', async () => {
    const { permissions, scripting } = fakes([
      'https://example.org/*',
      'https://*/*',
      'http://*/*',
    ]);
    const settings = new ChromeSettings();
    await new ChromeSitePermissions(permissions, scripting, settings).reconcile();
    const value = await settings.get();
    expect(value.allSites).toBe(true);
    expect(value.allowedHosts).toEqual(['example.org']);
  });
});
