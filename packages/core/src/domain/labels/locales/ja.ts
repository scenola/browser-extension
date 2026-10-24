/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LabelLocale } from '../grammar';

export const ja: LabelLocale = {
  id: 'ja',
  season: ['シーズン'],
  episode: ['エピソード'],
  patterns: [
    // A separator or a literal 第 must sit between the numbers, or "シーズン12話" splits into 1 and 2.
    /シーズン\s{0,3}(\d{1,3})(?:[\s,:.\-–—|]+第?\s{0,3}|第\s{0,3})(\d{1,4})\s{0,3}話/,
    /第\s{0,3}(\d{1,3})\s{0,3}期[\s,:.\-–—|]*第\s{0,3}(\d{1,4})\s{0,3}話/,
  ],
  // "第3話": the episode alone; "エピソード 3" is the episode word's.
  episodePatterns: [/第\s{0,3}(\d{1,4})\s{0,3}話/],
};
