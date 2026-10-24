/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The places in Settings another page may open it at: `options.html#<anchor>`. The settings page
// puts each on the heading it names, and scrolls to and focuses it on open.

import { browser } from 'wxt/browser';

export const SETTINGS_ANCHORS = {
  /** *Capture page sample*, in Diagnostics. */
  capture: 'capture',
  /** The built-in services' switches, in Sites. */
  services: 'services',
} as const;

export type SettingsAnchor = (typeof SETTINGS_ANCHORS)[keyof typeof SETTINGS_ANCHORS];

/**
 * Opens Settings at `anchor` in a tab, and closes the popup behind it. `openOptionsPage` takes no
 * anchor, so this is a tab of its own.
 */
export function openSettingsAt(anchor: SettingsAnchor): void {
  void browser.tabs.create({ url: `/options.html#${anchor}` }).finally(() => {
    window.close();
  });
}

/**
 * The settings page's own part: the heading the address's anchor names — a section's, or the one
 * an anchor is put on — scrolled to and focused, so a keyboard or screen-reader user starts
 * there, when the page opens and whenever the anchor changes. An anchor that names nothing
 * changes nothing.
 */
export function followAnchor(): () => void {
  const go = (): void => {
    const id = location.hash.slice(1);
    const target = id === '' ? null : document.getElementById(id);
    if (target === null) return;
    const heading = target.tagName === 'SECTION' ? (target.querySelector('h2') ?? target) : target;
    if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
    target.scrollIntoView({ block: 'start' });
    heading.focus({ preventScroll: true });
  };
  go();
  window.addEventListener('hashchange', go);
  return () => {
    window.removeEventListener('hashchange', go);
  };
}
