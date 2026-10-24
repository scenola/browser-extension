/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseEpisodeLabel } from './labels';
import { addressNumbers } from './generic-readers/address';
import { findSubject } from './generic-readers/json-ld';
import { SERIES_OG_TYPES } from './generic-readers/open-graph';
import { isRecord } from './generic-readers/shared';
import type { Snapshot } from './snapshot';

const parses = (x: unknown): boolean => typeof x === 'string' && parseEpisodeLabel(x) !== null;

/**
 * The entry rule's verdict on a page: `passes`, `series` — a series
 * page whose address names no single episode — or `silent`, a page that names no film or episode
 * in a form the extension reads. The last two are why a playing video goes nowhere
 * (`series_no_episode`, `page_silent`).
 */
export type EntryVerdict = 'passes' | 'series' | 'silent';

/**
 * On a site without a module, a viewing starts only when the page says it is a film or an
 * episode: JSON-LD `Movie`/`TVEpisode`, Open Graph `video.movie`/`video.episode`, a season/episode
 * label in the title, the Media Session or a selector — or a series page (JSON-LD `TVSeries`, Open
 * Graph `video.tv_series`/`video.tv_show`) whose address names exactly one season and episode.
 * On a page that does not say it is a series, address numbers alone open nothing.
 */
export function entryVerdict(snapshot: Snapshot): EntryVerdict {
  const subject = findSubject(snapshot.jsonLd);
  if (subject !== null && subject.kind !== 'series') return 'passes';

  const og = snapshot.openGraph;
  const type = isRecord(og) ? og['og:type'] : undefined;
  if (type === 'video.movie' || type === 'video.episode') return 'passes';

  if (parses(snapshot.documentTitle)) return 'passes';

  const session = snapshot.mediaSession;
  if (isRecord(session) && [session.title, session.artist, session.album].some(parses)) {
    return 'passes';
  }

  const selectors = snapshot.selectors;
  if (isRecord(selectors)) {
    for (const values of Object.values(selectors)) {
      if (Array.isArray(values) && values.some(parses)) return 'passes';
    }
  }
  if (subject === null && !(typeof type === 'string' && SERIES_OG_TYPES.includes(type))) {
    return 'silent';
  }
  return addressNumbers(snapshot.url) === null ? 'series' : 'passes';
}

/** `entryVerdict(snapshot) === 'passes'`. */
export const passesEntryRule = (snapshot: Snapshot): boolean => entryVerdict(snapshot) === 'passes';
