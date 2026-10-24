/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Snapshot } from '../snapshot';

/** A blank page; a test names only what it is about. For tests only. */
export function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    url: { hostname: 'example.com', pathname: '/watch', query: {}, hash: '' },
    lang: 'en',
    documentTitle: '',
    selectors: {},
    jsonLd: [],
    mediaSession: null,
    openGraph: {},
    pageState: {},
    signals: { endOfContent: false, adPlaying: false },
    ...over,
  };
}
