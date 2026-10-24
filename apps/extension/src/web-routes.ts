/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The web app's paths the extension links to, as the web app serves them on 2026-10-21. A path
// here is joined to `WEB_APP_BASE_URL` (config.ts); nothing else in the extension spells one.

export const WEB_ROUTES = {
  /** The approval page the sign-in opens. */
  connectExtension: '/connect/extension',
  /** Settings, the *Connected services* tab: connections and their controls. */
  connections: '/settings?tab=connections',
  /** Up Next, where the plays waiting for the person's answer are a section. */
  upNext: '/today',
  /** Up Next, scrolled to the card of one question. A stale key just shows Up Next. */
  question: (key: string): string => `/today?question=${encodeURIComponent(key)}`,
  /** A recorded play's title, where a wrong one is fixed. */
  title: (id: string): string => `/title/${encodeURIComponent(id)}`,
  /** The privacy policy. */
  privacy: '/privacy',
} as const;
