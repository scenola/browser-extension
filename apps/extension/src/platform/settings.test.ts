/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Settings version 3 drops the counting threshold version 2 added — the
// finish line is the account's. A version-1 or version-2 value migrates without it, keeping the
// rest, and nothing stored brings it back.

import { describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { ChromeSettings, closeToContentScripts } from './settings';

const VERSION_1 = {
  pausedUntil: null,
  trackIncognito: true,
  disabledServices: ['netflix'],
  excludedHosts: ['films.example'],
  allowedHosts: [],
  allSites: false,
  diagnostics: true,
  historyDays: 30,
};

describe('ChromeSettings version 3', () => {
  test('a version-2 value migrates to version 3 without its threshold, keeping the rest', async () => {
    await fakeBrowser.storage.local.set({
      settings: { ...VERSION_1, countAt: 0.7 },
      settings$: { v: 2 },
    });
    const value = await new ChromeSettings().get();
    expect(value).toEqual(VERSION_1);
    const stored = await fakeBrowser.storage.local.get(['settings', 'settings$']);
    expect(stored.settings).not.toHaveProperty('countAt');
    expect(stored.settings).toMatchObject({ trackIncognito: true });
    expect(stored.settings$).toEqual({ v: 3 });
  });

  test('a version-1 value written before versions were recorded migrates too', async () => {
    await fakeBrowser.storage.local.set({ settings: VERSION_1 });
    expect(await new ChromeSettings().get()).toEqual(VERSION_1);
    expect((await fakeBrowser.storage.local.get('settings$')).settings$).toEqual({ v: 3 });
  });

  test('a threshold stored beside version 3 is never read back', async () => {
    await fakeBrowser.storage.local.set({
      settings: { ...VERSION_1, countAt: 0.9 },
      settings$: { v: 3 },
    });
    expect(await new ChromeSettings().get()).not.toHaveProperty('countAt');
  });

  test('a migration of a damaged value never throws', async () => {
    await fakeBrowser.storage.local.set({ settings: 'garbage', settings$: { v: 2 } });
    expect((await new ChromeSettings().get()).trackIncognito).toBe(false);
  });
});

// Content scripts may read and write `storage.local` unless the extension says otherwise; the
// extension's never touch it, so a taken-over page's renderer gets nothing there.
describe('the settings area', () => {
  test('is closed to content scripts', async () => {
    const setAccessLevel = vi.fn(() => Promise.resolve());
    await closeToContentScripts({ setAccessLevel });
    expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });

  test('stays as it was, without a rejection, in a Chrome that cannot close it', async () => {
    const setAccessLevel = vi.fn(() => Promise.reject(new Error('not supported')));
    await expect(closeToContentScripts({ setAccessLevel })).resolves.toBeUndefined();
  });
});
