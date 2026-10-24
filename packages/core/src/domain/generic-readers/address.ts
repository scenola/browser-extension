/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { alternation } from '../labels';
import { EPISODE_NUMBER_MAX, SEASON_NUMBER_MAX } from '../play';
import type { ServiceReading } from '../reading';
import type { Snapshot } from '../snapshot';
import { field, isRecord } from './shared';

/**
 * One language's words for "season" and "episode" in an address, or one way of writing the pair
 * that words cannot express. Data: a form arrives as an entry of `ADDRESS_FORMS`, with its tests,
 * and the reader is not touched for it.
 *
 * - `season` and `episode` are words read on either side of their number: `season-1/episode-2`,
 *   `season/1/episode/2`, `season1episode2`, and `1-season/2-episode`.
 * - `seasonShort` and `episodeShort` (`s`, `ep`, `cap`) are read before their number only:
 *   `s1e2`, `season1-ep2`. After a number, a letter or two is anybody's (`1080p`, `4k`).
 * - Any language's season word pairs with any language's episode word, and every word, short or
 *   not, is also a parameter's name in the query or the hash: `season=1&episode=2`, `s=1&e=2`.
 * - A `pattern` is a form words cannot express (`1x02`): group 1 is the season's number, group 2
 *   the episode's, and it states its own edges. It is read in any case.
 *
 * A word is written in lowercase, as the language spells it; a spelling without its accents that
 * addresses use is a word of its own (`épisode`, `episode`). A word that addresses use for the
 * show itself (`series`, `serie`) is never a season word: `/series/123/episode/4` names show 123,
 * not its season 123.
 */
export type AddressForm =
  | {
      readonly id: string;
      readonly season: readonly string[];
      readonly episode: readonly string[];
      readonly seasonShort?: readonly string[];
      readonly episodeShort?: readonly string[];
    }
  | { readonly id: string; readonly pattern: RegExp };

export const ADDRESS_FORMS: readonly AddressForm[] = [
  {
    id: 'en',
    season: ['season'],
    episode: ['episode'],
    seasonShort: ['s', 'se', 'ss'],
    episodeShort: ['ep', 'e', 'epi'],
  },
  {
    id: 'es',
    season: ['temporada'],
    episode: ['episodio', 'capítulo', 'capitulo'],
    seasonShort: ['temp'],
    episodeShort: ['cap'],
  },
  {
    id: 'pt',
    season: ['temporada'],
    episode: ['episódio', 'episodio', 'capítulo', 'capitulo'],
    seasonShort: ['temp'],
    episodeShort: ['cap'],
  },
  { id: 'fr', season: ['saison'], episode: ['épisode', 'episode'] },
  { id: 'de', season: ['staffel'], episode: ['folge', 'episode'] },
  { id: 'it', season: ['stagione'], episode: ['episodio', 'puntata'] },
  { id: 'pl', season: ['sezon'], episode: ['odcinek'] },
  { id: 'nl', season: ['seizoen'], episode: ['aflevering'] },
  { id: 'tr', season: ['sezon'], episode: ['bölüm', 'bolum'] },
  // Ukrainian words, and the Latin spellings addresses give them. No russian spelling is read:
  // the content policy supports nothing russian.
  {
    id: 'uk',
    season: ['сезон', 'sezon'],
    episode: ['серія', 'епізод', 'seriya', 'seriia', 'seria', 'epizod'],
  },
  // `1x02`, `12x10`: a season of one or two digits, an episode of exactly two. A resolution
  // (`1280x720`, `1920x1080`) has three or four digits a side, and a codec (`x264`) no number
  // before it, so neither is ever read.
  { id: 'nxmm', pattern: /(?<![\p{L}\p{N}])(\d{1,2})x(\d{2})(?![\p{L}\p{N}])/u },
];

const WORDS = ADDRESS_FORMS.flatMap((form) => ('pattern' in form ? [] : [form]));
const SEASON_NAMES = WORDS.flatMap((w) => [...w.season, ...(w.seasonShort ?? [])]);
const EPISODE_NAMES = WORDS.flatMap((w) => [...w.episode, ...(w.episodeShort ?? [])]);

/**
 * The query parameters the address reader reads: every word of `ADDRESS_FORMS`, each language's
 * season words before its episode words. A site without a module declares none, so the worker
 * keeps these in its snapshot's query: numbers only ever leave the browser, never the address.
 */
export const ADDRESS_QUERY_PARAMS: readonly string[] = [
  ...new Set(
    WORDS.flatMap((w) => [
      ...w.season,
      ...(w.seasonShort ?? []),
      ...w.episode,
      ...(w.episodeShort ?? []),
    ]),
  ),
];

/** One of `words`, as a group that captures nothing. */
const oneOf = (words: readonly string[]): string => `(?:${alternation([...new Set(words)])})`;
/** No letter or digit on either side: a form is never the end of a longer word or number. */
const BEFORE = '(?<![\\p{L}\\p{N}])';
const AFTER = '(?![\\p{L}\\p{N}])';
/** Up to six digits are read; the wire's bounds then decide. */
const NUMBER = '(\\d{1,6})';
/** Between a word and its number: `season-1`, `s:1`, `s=1`, `season/1`, or nothing. */
const AT = '[-_.:=/]?';
/** Between the season's half and the episode's: `s1-e2`, `s1/e2`, `s1.e2`, or nothing. */
const BETWEEN = '[-_./:]?';

const PATTERNS: readonly RegExp[] = [
  // Each word before its number.
  new RegExp(
    `${BEFORE}${oneOf(SEASON_NAMES)}${AT}${NUMBER}${BETWEEN}${oneOf(EPISODE_NAMES)}${AT}${NUMBER}${AFTER}`,
    'giu',
  ),
  // Each number before its word: whole words only.
  new RegExp(
    `${BEFORE}${NUMBER}[-_.]?${oneOf(WORDS.flatMap((w) => w.season))}${BETWEEN}` +
      `${NUMBER}[-_.]?${oneOf(WORDS.flatMap((w) => w.episode))}${AFTER}`,
    'giu',
  ),
  ...ADDRESS_FORMS.flatMap((form) =>
    'pattern' in form ? [new RegExp(form.pattern.source, 'giu')] : [],
  ),
];

/** `name=<digits>` for any of `names`, in any case, as one parameter of a query or a hash. */
const param = (names: readonly string[]): RegExp =>
  new RegExp(`(?<=[?#&;])${oneOf(names)}=${NUMBER}(?![^#&;])`, 'giu');
const SEASON_PARAM = param(SEASON_NAMES);
const EPISODE_PARAM = param(EPISODE_NAMES);

/** The most of a path or a hash looked at: the collector's own bound. */
const MAX_PART_CHARS = 2048;
/** The most query parameters looked at. */
const MAX_QUERY_PARAMS = 16;

const part = (x: unknown): string => (typeof x === 'string' ? x.slice(0, MAX_PART_CHARS) : '');

/**
 * An address part as the forms read it: its percent-escapes decoded where they are UTF-8
 * (`%C3%A9` is `é`; a broken run stays as written), and its accents composed, so a word reads
 * however the address escaped it.
 */
const readable = (s: string): string =>
  s
    .replace(/(?:%[\da-f]{2})+/giu, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    })
    .normalize('NFC');

/**
 * The season and the episode the frame's address names: exactly one pair, read by
 * every form of `ADDRESS_FORMS` in the path, the query and the hash; `null` when it names none,
 * two different ones, or a number past the wire's bounds. Season 0 (specials) stands; episode 0 is
 * no episode, as in the label grammar. Total over any input, and bounded: at most
 * `MAX_PART_CHARS` of the path and of the hash, and `MAX_QUERY_PARAMS` parameters, are looked at.
 */
export function addressNumbers(url: unknown): { season: number; episode: number } | null {
  if (!isRecord(url)) return null;
  const query = (isRecord(url.query) ? Object.entries(url.query) : [])
    .slice(0, MAX_QUERY_PARAMS)
    .map(([k, v]) => `${k}=${part(v)}`);
  // The query's parameters, then the hash's: `#season=5&episode=1`, `#/watch?s=5&e=1`.
  const params = readable(`?${query.join('&')}${part(url.hash)}`);
  const address = readable(part(url.pathname)) + params;
  const pairs = new Set<string>();
  const add = (season: unknown, episode: unknown): void => {
    pairs.add(`${String(Number(season))}:${String(Number(episode))}`);
  };
  for (const pattern of PATTERNS) {
    for (const [, s, e] of address.matchAll(pattern)) add(s, e);
  }
  for (const [, s] of params.matchAll(SEASON_PARAM)) {
    for (const [, e] of params.matchAll(EPISODE_PARAM)) add(s, e);
  }
  const [only, ...more] = pairs;
  if (only === undefined || more.length > 0) return null;
  const [season = NaN, episode = NaN] = only.split(':').map(Number);
  return season <= SEASON_NUMBER_MAX && episode >= 1 && episode <= EPISODE_NUMBER_MAX
    ? { season, episode }
    : null;
}

/**
 * The page's address, the least trusted reader: an episode by the season and the
 * episode it names, and nothing else — no title, no id. On a site without a module it counts only
 * on a page that says it is a series (the entry rule, `entryVerdict`).
 */
export function readAddress(snapshot: Snapshot): ServiceReading | null {
  const numbers = addressNumbers(snapshot.url);
  if (numbers === null) return null;
  return {
    kind: field('address', 'episode'),
    season: field('address', numbers.season),
    episode: field('address', numbers.episode),
  };
}
