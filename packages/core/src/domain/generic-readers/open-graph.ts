/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ServiceReading } from '../reading';
import type { Snapshot } from '../snapshot';
import { field, isRecord, orNull, text, titleText, workFields, yearOf } from './shared';

/**
 * The Open Graph properties the generic readers read — this reader and the entry rule — spelled
 * once. The collector gathers these and no other tag, so no image link, no
 * description and no page link is ever held. A test holds the list to what the readers read, both
 * ways: a property read and not listed, or listed and not read, fails it.
 */
export const OPEN_GRAPH_PROPERTIES = [
  'og:type',
  'og:title',
  'video:series',
  'video:release_date',
] as const;

/** The `og:type`s of a series page: its `og:title` is the show's. */
export const SERIES_OG_TYPES: readonly string[] = ['video.tv_series', 'video.tv_show'];

/**
 * `video:series` as a show's name. Open Graph makes it a reference to the series' own page, so a
 * page may write that page's link there: a link is no name, and it would name the site in a play.
 */
const seriesName = (x: unknown): unknown =>
  typeof x === 'string' && /^\s*(?:[a-z][a-z\d+.-]*:\/\/|\/)/iu.test(x) ? undefined : x;

export function readOpenGraph(snapshot: Snapshot): ServiceReading | null {
  const og = snapshot.openGraph;
  if (!isRecord(og)) return null;
  const src = 'open-graph';
  const type = text(og['og:type']);
  const kind = type === 'video.movie' ? 'movie' : type === 'video.episode' ? 'episode' : undefined;
  // A series page's title is the show's; its numbers, if any, are the address's.
  if (type !== undefined && SERIES_OG_TYPES.includes(type)) {
    return orNull(workFields(src, og['og:title'], ['showTitle', 'showYear']));
  }
  return orNull({
    ...(kind !== undefined ? { kind: field(src, kind) } : {}),
    // A film's title is a work's; an episode's, or one of no kind, is kept as the page writes it,
    // cut to the wire's 200 code points. An episode's release date is when it aired, not the
    // year of the work.
    ...(kind === 'movie'
      ? workFields(src, og['og:title'], ['title', 'year'], yearOf(og['video:release_date']))
      : titleField(titleText(og['og:title']))),
    ...workFields(src, seriesName(og['video:series']), ['showTitle', 'showYear']),
  });
}

const titleField = (title: string | undefined): ServiceReading =>
  title === undefined ? {} : { title: field('open-graph', title) };
