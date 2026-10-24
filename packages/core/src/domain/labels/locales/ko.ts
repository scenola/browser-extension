/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LabelLocale } from '../grammar';

export const ko: LabelLocale = {
  id: 'ko',
  season: [],
  episode: [],
  patterns: [
    // A separator must sit between the numbers, or "시즌 12화" splits into 1 and 2.
    /시즌\s{0,3}(\d{1,3})[\s,:.\-–—|]+(\d{1,4})\s{0,3}화/,
    /(?<!\d)(\d{1,3})\s{0,3}시즌[\s,:.\-–—|]*(\d{1,4})\s{0,3}화/,
  ],
  // "3화": the episode alone.
  episodePatterns: [/(\d{1,4})\s{0,3}화/],
};
