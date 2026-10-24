/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment happy-dom

// `ScriptingBootstrapInjector`: the bootstrap into tabs open before it could run in
// them, through `chrome.tabs` and `chrome.scripting`, over hand-written fakes of both. What it
// must do: list only the tabs whose URL Chrome shows, ask every frame of a tab for its origin in
// one call, inject the bootstrap file by document, and answer for every failure without throwing.

import { describe, expect, test, vi } from 'vitest';

import { ScriptingBootstrapInjector } from './injection';

type Scripting = ConstructorParameters<typeof ScriptingBootstrapInjector>[0];
type Tabs = ConstructorParameters<typeof ScriptingBootstrapInjector>[1];
type Injection = Parameters<Scripting['executeScript']>[0];

function fakes(options: { results?: unknown; fail?: boolean; tabs?: unknown[] } = {}) {
  const injections: Injection[] = [];
  const scripting = {
    executeScript: vi.fn((injection: Injection) => {
      injections.push(injection);
      return options.fail === true
        ? Promise.reject(new Error('Cannot access contents of the page'))
        : Promise.resolve(options.results ?? []);
    }),
  };
  const tabs = {
    query: vi.fn(() =>
      options.fail === true ? Promise.reject(new Error('no')) : Promise.resolve(options.tabs ?? []),
    ),
  };
  const injector = new ScriptingBootstrapInjector(
    scripting as unknown as Scripting,
    tabs as unknown as Tabs,
  );
  return { injector, injections, scripting, tabs };
}

describe('ScriptingBootstrapInjector', () => {
  test('lists the open tabs whose URL Chrome shows, all of them or those matching patterns', async () => {
    const tabs = [
      { id: 1, url: 'https://www.netflix.com/browse' },
      { id: 2 }, // a site this extension may not see: no URL
      { id: 3, url: '' },
      { id: -1, url: 'https://www.netflix.com/' },
    ];
    const f = fakes({ tabs });
    expect(await f.injector.openTabs()).toEqual([
      { tabId: 1, url: 'https://www.netflix.com/browse' },
    ]);
    expect(f.tabs.query).toHaveBeenLastCalledWith({});
    await f.injector.openTabs(['https://films.example/*']);
    expect(f.tabs.query).toHaveBeenLastCalledWith({ url: ['https://films.example/*'] });
  });

  test('asks every frame of a tab for its origin in one call', async () => {
    const results = [
      { frameId: 0, documentId: 'top', result: 'https://www.netflix.com' },
      { frameId: 2, documentId: 'sandbox', result: 'null' },
      { frameId: 3, result: 42 },
    ];
    const f = fakes({ results });
    expect(await f.injector.framesOf(7)).toEqual([
      { frameId: 0, documentId: 'top', origin: 'https://www.netflix.com' },
      { frameId: 2, documentId: 'sandbox', origin: null },
      { frameId: 3, documentId: null, origin: null },
    ]);
    const [probe] = f.injections;
    expect(probe?.target).toEqual({ tabId: 7, allFrames: true });
    expect(probe?.injectImmediately).toBe(true);
    // The probe itself answers the frame's origin (an `about:blank` frame's is its creator's).
    const func = (probe as { func?: () => unknown } | undefined)?.func;
    expect(func?.()).toBe(location.origin);
  });

  test('injects the bootstrap file into one document', async () => {
    const f = fakes();
    expect(await f.injector.inject({ tabId: 7, frameId: 1, documentId: 'doc-1' })).toBe(true);
    expect(f.injections[0]).toMatchObject({
      target: { tabId: 7, documentIds: ['doc-1'] },
      files: ['bootstrap.js'],
      injectImmediately: true,
    });
  });

  test('answers for every failure: no tabs, no frames, not injected', async () => {
    const f = fakes({ fail: true });
    expect(await f.injector.openTabs()).toEqual([]);
    expect(await f.injector.framesOf(7)).toEqual([]);
    expect(await f.injector.inject({ tabId: 7, frameId: 0, documentId: null })).toBe(false);
  });
});
