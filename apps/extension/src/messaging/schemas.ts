/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What crosses into the worker from code it does not trust — a content script's sample and
// snapshot, a sandboxed module's reading — validated on arrival. Strict objects (an unknown
// field is a refusal), bounded strings, arrays, records and JSON, so a message that passes is
// small and shaped as core expects. The bounds are the collector's and the module SDK's,
// spelled once in `SNAPSHOT_LIMITS` (messaging/limits.ts).

import { MAX_MARKER_SECONDS, MAX_SECONDS, READING_SOURCES } from '@mt/core';
import * as v from 'valibot';

import { MAX_DATE_MS } from '../values';
import { MAX_MEDIA_SECONDS, MAX_PLAYBACK_RATE, SNAPSHOT_LIMITS } from './limits';

/** A finite number within `[min, max]`. */
const numberIn = (min: number, max: number) =>
  v.pipe(v.number(), v.finite(), v.minValue(min), v.maxValue(max));

const text = (max: number) => v.pipe(v.string(), v.maxLength(max));

export const PlaybackSampleSchema = v.strictObject({
  at: numberIn(0, MAX_DATE_MS),
  position: numberIn(0, MAX_MEDIA_SECONDS),
  duration: v.nullable(v.pipe(v.number(), v.finite(), v.gtValue(0), v.maxValue(MAX_MEDIA_SECONDS))),
  paused: v.boolean(),
  ended: v.boolean(),
  rate: numberIn(0, MAX_PLAYBACK_RATE),
  adPlaying: v.boolean(),
  muted: v.boolean(),
  visibleArea: numberIn(0, 1),
});

/**
 * Whether `value` is plain JSON within `maxDepth` levels and `maxNodes` nodes and, written by
 * `JSON.stringify`, within `maxChars`. The walk is iterative and stops at the first excess, so
 * its work is bounded by `maxNodes` whatever arrives. Total: anything else answers `false`.
 */
export function withinJsonBudget(
  value: unknown,
  budget: { readonly maxDepth: number; readonly maxNodes: number; readonly maxChars: number },
): boolean {
  const stack: { readonly value: unknown; readonly depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    nodes += 1;
    if (nodes > budget.maxNodes) return false;
    const current = item.value;
    if (current === null || typeof current === 'boolean' || typeof current === 'string') continue;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return false;
      continue;
    }
    if (typeof current !== 'object' || item.depth >= budget.maxDepth) return false;
    const proto: unknown = Object.getPrototypeOf(current);
    if (!Array.isArray(current) && proto !== Object.prototype && proto !== null) return false;
    for (const member of Object.values(current)) {
      stack.push({ value: member, depth: item.depth + 1 });
      if (stack.length > budget.maxNodes) return false;
    }
  }
  try {
    return JSON.stringify(value).length <= budget.maxChars;
  } catch {
    return false;
  }
}

const L = SNAPSHOT_LIMITS;

export const SnapshotSchema = v.strictObject({
  url: v.strictObject({
    hostname: text(L.hostname),
    pathname: text(L.pathname),
    query: v.pipe(v.record(text(L.queryName), text(L.queryValue)), v.maxEntries(L.queryParams)),
    hash: text(L.hash),
  }),
  lang: v.nullable(text(L.lang)),
  documentTitle: text(L.documentTitle),
  selectors: v.pipe(
    v.record(
      text(L.selectorName),
      v.pipe(v.array(text(L.selectorValue)), v.maxLength(L.selectorValues)),
    ),
    v.maxEntries(L.selectorNames),
  ),
  jsonLd: v.pipe(
    v.array(v.unknown()),
    v.maxLength(L.jsonLdObjects),
    v.check((items) =>
      withinJsonBudget(items, {
        maxDepth: L.jsonLdDepth,
        maxNodes: L.jsonNodes,
        maxChars: L.jsonLdChars,
      }),
    ),
  ),
  mediaSession: v.nullable(
    v.strictObject({
      title: v.exactOptional(text(L.mediaSessionField)),
      artist: v.exactOptional(text(L.mediaSessionField)),
      album: v.exactOptional(text(L.mediaSessionField)),
    }),
  ),
  openGraph: v.pipe(
    v.record(text(L.openGraphName), text(L.openGraphValue)),
    v.maxEntries(L.openGraphEntries),
  ),
  pageState: v.pipe(
    v.record(text(L.selectorName), v.unknown()),
    v.maxEntries(L.pageStateEntries),
    v.check((state) =>
      Object.values(state).every((entry) =>
        withinJsonBudget(entry, {
          maxDepth: L.pageStateDepth,
          maxNodes: L.jsonNodes,
          maxChars: L.pageStateChars,
        }),
      ),
    ),
  ),
  signals: v.strictObject({ endOfContent: v.boolean(), adPlaying: v.boolean() }),
});

const confidence = numberIn(0, 1);

const field = <T extends v.GenericSchema>(value: T) =>
  v.strictObject({ value, confidence, source: v.picklist(READING_SOURCES) });

const wholeNumber = (min: number, max: number) =>
  v.pipe(v.number(), v.integer(), v.minValue(min), v.maxValue(max));

const StatedIdsSchema = v.strictObject({
  tmdb: v.exactOptional(wholeNumber(1, Number.MAX_SAFE_INTEGER)),
  imdb: v.exactOptional(v.pipe(v.string(), v.regex(/^tt\d{5,10}$/u))),
});

/**
 * A service module's answer, as the sandbox returns it (the interpreter validates with this).
 *
 * @public
 */
export const ServiceReadingSchema = v.strictObject({
  kind: v.exactOptional(field(v.picklist(['movie', 'episode']))),
  title: v.exactOptional(field(text(500))),
  showTitle: v.exactOptional(field(text(500))),
  episodeTitle: v.exactOptional(field(text(500))),
  season: v.exactOptional(field(wholeNumber(0, 10_000))),
  episode: v.exactOptional(field(wholeNumber(0, 100_000))),
  year: v.exactOptional(field(wholeNumber(1870, 2200))),
  showYear: v.exactOptional(field(wholeNumber(1870, 2200))),
  ids: v.exactOptional(field(StatedIdsSchema)),
  showIds: v.exactOptional(field(StatedIdsSchema)),
  providerIds: v.exactOptional(
    v.pipe(
      v.array(
        v.strictObject({
          level: v.picklist(['title', 'show']),
          key: text(64),
          value: text(200),
        }),
      ),
      v.maxLength(8),
    ),
  ),
  contentEnded: v.exactOptional(v.boolean()),
  adPlaying: v.exactOptional(v.boolean()),
  contentDurationSeconds: v.exactOptional(
    v.pipe(v.number(), v.finite(), v.gtValue(0), v.maxValue(MAX_SECONDS)),
  ),
  // Where the service says the credits start (Netflix's `creditsOffset`) and the intro ends,
  // in content seconds. The core bounds them again against the duration.
  creditsStartSeconds: v.exactOptional(
    v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(MAX_MARKER_SECONDS)),
  ),
  introEndSeconds: v.exactOptional(
    v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(MAX_MARKER_SECONDS)),
  ),
});
