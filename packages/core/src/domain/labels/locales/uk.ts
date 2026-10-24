/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { LabelLocale } from '../grammar';

// Ukrainian words only: the russian spelling of "episode" is not read — the content policy
// supports nothing russian.
export const uk: LabelLocale = {
  id: 'uk',
  season: ['сезон', 'с'],
  episode: ['серія', 'сер', 'еп', 'е'],
};
