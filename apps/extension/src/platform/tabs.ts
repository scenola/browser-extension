/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the worker may know of a tab without the `tabs` permission: its id, whether it is audible
// and incognito, and its URL only where the extension has access to the site — which is exactly
// where it tracks.

import type { Browser } from 'wxt/browser';

import type { TabFacts, TabsInfo } from '../composition/ports';

type Tabs = Pick<typeof Browser.tabs, 'query' | 'get'>;

export class ChromeTabs implements TabsInfo {
  readonly #tabs: Tabs;

  constructor(tabs: Tabs) {
    this.#tabs = tabs;
  }

  async active(): Promise<number | null> {
    const [tab] = await this.#tabs.query({ active: true, lastFocusedWindow: true });
    const id = tab?.id;
    return id === undefined || id < 0 ? null : id;
  }

  async get(tabId: number): Promise<TabFacts | null> {
    try {
      const tab = await this.#tabs.get(tabId);
      return {
        url: typeof tab.url === 'string' && tab.url !== '' ? tab.url : null,
        audible: tab.audible === true,
        incognito: tab.incognito,
      };
    } catch {
      return null;
    }
  }
}
