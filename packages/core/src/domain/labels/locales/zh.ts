/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LabelLocale } from '../grammar';

export const zh: LabelLocale = {
  id: 'zh',
  season: [],
  episode: [],
  patterns: [/第\s{0,3}(\d{1,3})\s{0,3}季[\s,:.\-–—|]*第\s{0,3}(\d{1,4})\s{0,3}[集话話]/],
  // "第3集": the episode alone.
  episodePatterns: [/第\s{0,3}(\d{1,4})\s{0,3}[集话話]/],
};
