/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EPISODE_NUMBER_MAX, SEASON_NUMBER_MAX } from '../play';
import type { ServiceReading, StatedIds } from '../reading';
import type { Snapshot } from '../snapshot';
import {
  asArray,
  boundedInt,
  field,
  isRecord,
  orNull,
  titleText,
  workFields,
  yearOf,
} from './shared';

/** Objects looked at per page: a page with more is a catalogue, not a player. */
const MAX_OBJECTS = 20;
/** Nodes looked at, objects or not: the bound on work, as MAX_OBJECTS is on output. */
const MAX_EXAMINED = 200;

const IMDB_TITLE = /^https?:\/\/(?:www\.)?imdb\.com\/title\/(tt\d{5,10})(?!\d)/iu;

/**
 * The fields of a JSON-LD node this reader reads — and `findSubject`, which the entry rule asks —
 * spelled once. The collector cuts every node of the page's JSON-LD to them, at any
 * depth (`cutJsonLd`), so no image link, no description and no page link is held. A test holds
 * the list to what the reader reads, both ways.
 */
export const JSON_LD_FIELDS = [
  '@type',
  '@graph',
  'name',
  'datePublished',
  'dateCreated',
  'sameAs',
  'url',
  'episodeNumber',
  'partOfSeason',
  'seasonNumber',
  'partOfSeries',
  'startDate',
] as const;

/** The IMDb title id a link holds, lowercase; nothing for any other value. */
function imdbIdOf(x: unknown): string | undefined {
  const match = typeof x === 'string' ? IMDB_TITLE.exec(x.trim()) : null;
  return match?.[1]?.toLowerCase();
}

/**
 * What the cut keeps of an IMDb link: the bare title link of its id. Whatever the page wrote past
 * the id — a query, a hash, a sub-page — is not read, and a tracking query names the visit.
 */
const imdbTitleLink = (id: string): string => `https://www.imdb.com/title/${id}/`;

/**
 * A JSON-LD value cut to what this reader reads: every object keeps only the fields
 * of `JSON_LD_FIELDS`, at any depth, and `sameAs` and `url` keep only the IMDb title ids their
 * values hold — the one thing read from them — each as its bare title link. Total over any JSON
 * value; its depth is the input's.
 */
export function cutJsonLd(value: unknown): unknown {
  if (Array.isArray(value)) return (value as unknown[]).map(cutJsonLd);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of JSON_LD_FIELDS) {
    if (!Object.hasOwn(value, key)) continue;
    const member = value[key];
    if (key !== 'sameAs' && key !== 'url') {
      out[key] = cutJsonLd(member);
      continue;
    }
    const ids = (Array.isArray(member) ? (member as unknown[]) : [member])
      .map(imdbIdOf)
      .filter((id) => id !== undefined);
    const [first] = ids;
    if (first === undefined) continue;
    out[key] = Array.isArray(member) ? ids.map(imdbTitleLink) : imdbTitleLink(first);
  }
  return out;
}

function typesOf(node: Record<string, unknown>): readonly string[] {
  const type = node['@type'];
  if (typeof type === 'string') return [type];
  return asArray(type).filter((t): t is string => typeof t === 'string');
}

/**
 * The objects of a JSON-LD block, breadth first: top-level entries, arrays in
 * place, and `@graph` members, at most `MAX_OBJECTS` in all. Total over any input.
 */
function* objectsOf(jsonLd: unknown): Generator<Record<string, unknown>> {
  if (!Array.isArray(jsonLd)) return;
  // Nothing is enqueued past the examination budget, so work is bounded
  // by MAX_EXAMINED whatever the page holds (a million nulls included).
  const queue: unknown[] = [];
  const enqueue = (items: readonly unknown[]): void => {
    for (let i = 0; i < items.length && queue.length < MAX_EXAMINED; i += 1) {
      queue.push(items[i]);
    }
  };
  enqueue(jsonLd);
  const seen = new Set<unknown>();
  let yielded = 0;
  for (let head = 0; head < queue.length && yielded < MAX_OBJECTS; head += 1) {
    const node = queue[head];
    if (Array.isArray(node)) {
      if (!seen.has(node)) {
        seen.add(node);
        enqueue(asArray(node));
      }
      continue;
    }
    if (!isRecord(node) || seen.has(node)) continue;
    seen.add(node);
    yielded += 1;
    yield node;
    enqueue(asArray(node['@graph']));
  }
}

/**
 * The first `Movie` or `TVEpisode` the page declares; else its first `TVSeries` (a series page),
 * which names the show and no episode.
 */
export function findSubject(jsonLd: unknown): {
  readonly kind: 'movie' | 'episode' | 'series';
  readonly node: Record<string, unknown>;
} | null {
  let series: Record<string, unknown> | undefined;
  for (const node of objectsOf(jsonLd)) {
    const types = typesOf(node);
    if (types.includes('TVEpisode')) return { kind: 'episode', node };
    if (types.includes('Movie')) return { kind: 'movie', node };
    if (types.includes('TVSeries')) series ??= node;
  }
  return series === undefined ? null : { kind: 'series', node: series };
}

/** An IMDb title id from `sameAs` (a string or an array) and `url`. */
function imdbOf(node: Record<string, unknown>): StatedIds | undefined {
  const sameAs = Array.isArray(node.sameAs) ? asArray(node.sameAs) : [node.sameAs];
  for (const candidate of [...sameAs, node.url]) {
    const id = imdbIdOf(candidate);
    if (id !== undefined) return { imdb: id };
  }
  return undefined;
}

const first = (x: unknown): Record<string, unknown> | undefined =>
  isRecord(x) ? x : asArray(x).find(isRecord);

export function readJsonLd(snapshot: Snapshot): ServiceReading | null {
  const subject = findSubject(snapshot.jsonLd);
  if (subject === null) return null;
  const { kind, node } = subject;
  const src = 'json-ld';
  const ids = imdbOf(node);

  // Every value within the wire's bounds: titles cut to 200 code points, a number past the
  // server's limit no number. A film's and a show's names are a work's titles (`workFields`): a
  // trailing year is the year where the page states none.
  if (kind === 'movie') {
    return orNull({
      kind: field(src, 'movie'),
      ...workFields(
        src,
        node.name,
        ['title', 'year'],
        yearOf(node.datePublished) ?? yearOf(node.dateCreated),
      ),
      ...(ids !== undefined ? { ids: field(src, ids) } : {}),
    });
  }

  // A series page names the show and no episode: its numbers, if any, are the address's.
  const series = kind === 'series' ? node : first(node.partOfSeries);
  const showIds = series === undefined ? undefined : imdbOf(series);
  const show: ServiceReading = {
    ...workFields(src, series?.name, ['showTitle', 'showYear'], yearOf(series?.startDate)),
    ...(showIds !== undefined ? { showIds: field(src, showIds) } : {}),
  };
  if (kind === 'series') return orNull(show);

  const episodeTitle = titleText(node.name);
  const episode = boundedInt(node.episodeNumber, EPISODE_NUMBER_MAX);
  const season = boundedInt(first(node.partOfSeason)?.seasonNumber, SEASON_NUMBER_MAX);
  return orNull({
    kind: field(src, 'episode'),
    ...(episodeTitle !== undefined ? { episodeTitle: field(src, episodeTitle) } : {}),
    ...(episode !== undefined ? { episode: field(src, episode) } : {}),
    ...(season !== undefined ? { season: field(src, season) } : {}),
    ...show,
    ...(ids !== undefined ? { ids: field(src, ids) } : {}),
  });
}
