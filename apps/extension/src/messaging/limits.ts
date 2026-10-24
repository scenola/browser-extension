/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The bounds of what a collector sends, spelled once: the collector builds within them
// (collector/sampler.ts, collector/snapshot.ts) and the worker refuses what exceeds them
// (messaging/schemas.ts). A module of their own, with no schema code, so the collector carries the
// numbers without the validator. The selector caps are the module SDK's, carried as data.

import { SITES } from '../sites';

/** The longest media a sample carries a position or a length for: 100 days. */
export const MAX_MEDIA_SECONDS = 100 * 24 * 3600;
/** The fastest playback rate a sample carries. */
export const MAX_PLAYBACK_RATE = 16;

export const SNAPSHOT_LIMITS = {
  hostname: 253,
  pathname: 2048,
  hash: 2048,
  queryParams: 8,
  queryName: 64,
  queryValue: 300,
  lang: 35,
  documentTitle: 1000,
  selectorNames: 16,
  selectorName: 32,
  selectorValues: SITES.limits.maxSelectorValues,
  selectorValue: SITES.limits.maxSelectorLength,
  jsonLdObjects: 20,
  jsonLdChars: 64 * 1024,
  jsonLdDepth: 32,
  mediaSessionField: 500,
  openGraphEntries: 32,
  openGraphName: 64,
  openGraphValue: 1000,
  pageStateEntries: 4,
  /** Per entry, as `JSON.stringify` writes it: the state-path reader's 32 KB. */
  pageStateChars: 32 * 1024,
  /** The reader clones to depth 6; two levels of slack for how depth is counted. */
  pageStateDepth: 8,
  /** Nodes examined in one JSON value before it is refused, whatever its size. */
  jsonNodes: 10_000,
} as const;
