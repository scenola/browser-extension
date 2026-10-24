/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Apple TV module. What it reads, and why, is in README.md beside it.

import {
  EPISODE_NUMBER_MAX,
  MAX_SECONDS,
  MIN_CONTENT_SECONDS,
  SEASON_NUMBER_MAX,
  clampTitle,
  field,
  isYear,
  jsonAt,
  parseEpisodeLabel,
} from '../../helpers';
import { MAX_SELECTOR_VALUES, defineService, matchPlayerRoute } from '../../sdk';
import type { ServiceReading, Snapshot } from '../../sdk';

/**
 * An episode's or a film's page, where the long-form player opens:
 * `/<storefront>/episode/<slug>/umc.cmc.<id>`, `/<storefront>/movie/<slug>/umc.cmc.<id>`.
 * Group 1 is the kind the page is about, group 2 its content id.
 */
const PLAYER_ROUTES: readonly RegExp[] = [
  /^(?:\/[a-z]{2})?\/(episode|movie)\/[^/]+\/(umc\.cmc\.[a-z0-9]{1,64})(?=\/|$)/,
];

/** An Apple content id: well inside the wire's 200 printable characters. */
const CONTENT_ID = /^umc\.cmc\.[a-z0-9]{1,64}$/;
/** The content id a JSON-LD `url` or `@id` names, as a whole path segment. */
const CONTENT_ID_IN_URL = /\/(umc\.cmc\.[a-z0-9]{1,64})(?=[/?#]|$)/;

/** JSON-LD checked to be about the route's own item. */
const STATED = 0.95;
/** The player's metadata and the media session, read through the label grammar. */
const PLAYED = 0.8;

/** The most of one page string `interpret` looks at, whatever the snapshot holds. */
const MAX_TEXT_INPUT = 1000;
const MAX_URL_INPUT = 2048;
/** JSON-LD nodes looked at (the bound on work) and objects kept (the bound on output). */
const MAX_LD_EXAMINED = 200;
const MAX_LD_OBJECTS = 20;
/** Entries of one JSON-LD list looked at: its `@type`s, its seasons or its series. */
const MAX_LD_LIST = 8;
/** A part of the subtitle that is a label and nothing else ("S1, E2") is short. */
const MAX_BARE_LABEL = 32;

/** The long-form player: Apple's promotional videos play outside it. */
const PLAYER_CSS = '[data-testid="video-player"]';

/** The end of the content inside the player: the up-next card's button, *Skip credits*. */
const END_OF_CONTENT = [
  `${PLAYER_CSS} [class*="up-next" i] button`,
  `${PLAYER_CSS} [class*="skip-credits" i]`,
].join(', ');

/**
 * What joins a label to a title in the player's subtitle ("S1, E2 · Pilot"), in text whose
 * whitespace is already collapsed. Captured, so a split keeps the separators between the
 * other parts.
 */
const PART_SEPARATOR = /( [·•|–—-] |: )/u;

/** The suffix that joins a show's name to an episode's in a JSON-LD `name`. */
const NAME_JOINERS: readonly string[] = [' - ', ' – ', ' — ', ': '];

/** An IMDb title page in a JSON-LD `sameAs`: an id the page itself states. */
const IMDB_TITLE = /^https?:\/\/(?:www\.)?imdb\.com\/title\/(tt\d{5,10})(?!\d)/iu;

const ISO_DURATION =
  /^P(?:(\d{1,2})D)?(?:T(?:(\d{1,3})H)?(?:(\d{1,4})M)?(?:(\d{1,6})(?:[.,]\d{1,9})?S)?)?$/u;
const LEADING_YEAR = /^(\d{4})(?!\d)/u;
const DIGITS = /^\s*(\d{1,6})\s*$/u;

type Kind = 'movie' | 'episode';
type Field<T> = ReturnType<typeof field<T>>;

interface Label {
  readonly season: number;
  readonly episode: number;
}

/** What JSON-LD about the route's own item states. */
interface Subject {
  readonly kind: Kind;
  /** The film's title, or the episode's own. */
  readonly title?: string;
  readonly showTitle?: string;
  readonly season?: number;
  readonly episode?: number;
  readonly year?: number;
  readonly showYear?: number;
  readonly durationSeconds?: number;
  /** The item's and its series' IMDb ids, from `sameAs`. */
  readonly imdb?: string;
  readonly showImdb?: string;
  /** The series' own content id, from `partOfSeries.url` / `@id`. */
  readonly showId?: string;
}

/** What the player (or the media session) shows is playing. */
interface Playing {
  readonly label?: Label;
  readonly showTitle?: string;
  readonly episodeTitle?: string;
  /** The player's title when it holds no label: a film's. */
  readonly title?: string;
}

const isRecord = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asList = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? (value as readonly unknown[]) : [];

/** A record, or the first record of a list. */
function firstRecord(value: unknown): unknown {
  if (isRecord(value)) return value;
  const items = asList(value);
  for (let index = 0; index < items.length && index < MAX_LD_LIST; index += 1) {
    if (isRecord(items[index])) return items[index];
  }
  return undefined;
}

/** A page string made a title: whitespace collapsed, trimmed, at most 200 code points. */
function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return clampTitle(value.slice(0, MAX_TEXT_INPUT).replace(/\s+/gu, ' '));
}

/** The non-blank texts the collector returned for a selector, at most five. */
function textsOf(snapshot: unknown, name: string): readonly string[] {
  const items = asList(jsonAt(snapshot, ['selectors', name]));
  const texts: string[] = [];
  for (let index = 0; index < items.length && index < MAX_SELECTOR_VALUES; index += 1) {
    const text = cleanText(items[index]);
    if (text !== undefined) texts.push(text);
  }
  return texts;
}

/** Whether the collector saw a signal's element: `true` and nothing else counts. */
const signalled = (snapshot: unknown, name: 'endOfContent' | 'adPlaying'): boolean =>
  jsonAt(snapshot, ['signals', name]) === true;

/** A whole number in `min..max`, from a number or a digit string. */
function wholeNumber(value: unknown, min: number, max: number): number | undefined {
  const raw = typeof value === 'string' ? DIGITS.exec(value.slice(0, 16))?.[1] : value;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/** A year from a date's leading `YYYY` (or a bare number), within the wire's 1870–2200. */
function yearOf(value: unknown): number | undefined {
  const raw = typeof value === 'string' ? LEADING_YEAR.exec(value.slice(0, 32))?.[1] : value;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  return isYear(n) ? n : undefined;
}

/**
 * An ISO 8601 duration (`PT1H58M`) in whole seconds, from the shortest content to a week.
 * A stated length wins over the element's, so a shorter one would keep the viewing from
 * ever being reported: it is dropped instead.
 */
function durationOf(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = ISO_DURATION.exec(value.slice(0, 40).trim());
  if (match === null) return undefined;
  const [, days, hours, minutes, whole] = match;
  const part = (digits: string | undefined): number => Number(digits ?? '0');
  const seconds = part(days) * 86_400 + part(hours) * 3600 + part(minutes) * 60 + part(whole);
  return Number.isInteger(seconds) && seconds >= MIN_CONTENT_SECONDS && seconds <= MAX_SECONDS
    ? seconds
    : undefined;
}

/**
 * The objects of the page's JSON-LD, breadth first: top-level entries, arrays in place and
 * `@graph` members. Nothing is enqueued past `MAX_LD_EXAMINED`, so the work is bounded
 * whatever the page holds, a cycle included.
 */
function ldObjects(snapshot: unknown): readonly unknown[] {
  const queue: unknown[] = [];
  const enqueue = (value: unknown): void => {
    const items = asList(value);
    for (let index = 0; index < items.length && queue.length < MAX_LD_EXAMINED; index += 1) {
      queue.push(items[index]);
    }
  };
  enqueue(jsonAt(snapshot, ['jsonLd']));
  const objects: unknown[] = [];
  for (let head = 0; head < queue.length && objects.length < MAX_LD_OBJECTS; head += 1) {
    const node = queue[head];
    if (Array.isArray(node)) {
      enqueue(node);
    } else if (isRecord(node)) {
      objects.push(node);
      enqueue(jsonAt(node, ['@graph']));
    }
  }
  return objects;
}

/** The kind a JSON-LD node declares: `TVEpisode` or `Episode`, `Movie`; else `null`. */
function kindOf(node: unknown): Kind | null {
  const declared = jsonAt(node, ['@type']);
  const types: readonly unknown[] =
    typeof declared === 'string' ? [declared] : asList(declared).slice(0, MAX_LD_LIST);
  if (types.includes('TVEpisode') || types.includes('Episode')) return 'episode';
  if (types.includes('Movie')) return 'movie';
  return null;
}

/**
 * Whether a JSON-LD node is about the item `id`: the content ids its `url` and `@id` name
 * are all `id`; a node that names none is the page's own only when the page's
 * `apple:content_id` is `id`. A page Apple's app moved away from keeps its first item's
 * JSON-LD, so a node about another item is never this one's.
 */
function isAbout(node: unknown, id: string, pageId: string | undefined): boolean {
  const named: string[] = [];
  for (const key of ['url', '@id'] as const) {
    const ref = jsonAt(node, [key]);
    const match =
      typeof ref === 'string' ? CONTENT_ID_IN_URL.exec(ref.slice(0, MAX_URL_INPUT)) : null;
    if (match?.[1] !== undefined) named.push(match[1]);
  }
  return named.length > 0 ? named.every((each) => each === id) : pageId === id;
}

/**
 * The one content id a series node's `url` and `@id` name: the series' own id, the
 * show level's. Two different ids, or none, name nothing.
 */
function seriesIdOf(series: unknown): string | undefined {
  let named: string | undefined;
  for (const key of ['url', '@id'] as const) {
    const ref = jsonAt(series, [key]);
    const match =
      typeof ref === 'string' ? CONTENT_ID_IN_URL.exec(ref.slice(0, MAX_URL_INPUT)) : null;
    const id = match?.[1];
    if (id === undefined) continue;
    if (named !== undefined && named !== id) return undefined;
    named = id;
  }
  return named;
}

/** The IMDb title id a node's `sameAs` (a string or a list) points at. */
function imdbOf(node: unknown): string | undefined {
  const sameAs = jsonAt(node, ['sameAs']);
  const refs = typeof sameAs === 'string' ? [sameAs] : asList(sameAs).slice(0, MAX_LD_LIST);
  for (const ref of refs) {
    const match = typeof ref === 'string' ? IMDB_TITLE.exec(ref.slice(0, MAX_URL_INPUT)) : null;
    if (match?.[1] !== undefined) return match[1].toLowerCase();
  }
  return undefined;
}

/** An episode's own title out of a JSON-LD `name` that may lead with the show's. */
function episodeTitleOf(name: string | undefined, show: string | undefined): string | undefined {
  if (name === undefined || name === show) return undefined;
  if (show === undefined) return name;
  for (const joiner of NAME_JOINERS) {
    if (name.startsWith(show + joiner)) return cleanText(name.slice(show.length + joiner.length));
  }
  return name;
}

/** The first JSON-LD node about the route's item, of the route's kind, read. */
function subjectOf(snapshot: unknown, id: string, kind: Kind): Subject | null {
  const pageId = textsOf(snapshot, 'contentId')[0];
  for (const node of ldObjects(snapshot)) {
    if (kindOf(node) !== kind || !isAbout(node, id, pageId)) continue;
    const name = cleanText(jsonAt(node, ['name']));
    const durationSeconds = durationOf(jsonAt(node, ['duration']));
    const imdb = imdbOf(node);
    const stated = {
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
      ...(imdb === undefined ? {} : { imdb }),
    };
    if (kind === 'movie') {
      const year = yearOf(jsonAt(node, ['datePublished'])) ?? yearOf(jsonAt(node, ['dateCreated']));
      return {
        kind,
        ...(name === undefined ? {} : { title: name }),
        ...(year === undefined ? {} : { year }),
        ...stated,
      };
    }
    const series = firstRecord(jsonAt(node, ['partOfSeries']));
    const showTitle = cleanText(jsonAt(series, ['name']));
    const showYear = yearOf(jsonAt(series, ['startDate']));
    const showImdb = imdbOf(series);
    const showId = seriesIdOf(series);
    const title = episodeTitleOf(name, showTitle);
    const seasonValue = jsonAt(node, ['partOfSeason']);
    const seasonNode = firstRecord(seasonValue);
    const season = wholeNumber(
      seasonNode === undefined ? seasonValue : jsonAt(seasonNode, ['seasonNumber']),
      0,
      SEASON_NUMBER_MAX,
    );
    const episode = wholeNumber(jsonAt(node, ['episodeNumber']), 1, EPISODE_NUMBER_MAX);
    return {
      kind,
      ...(title === undefined ? {} : { title }),
      ...(showTitle === undefined ? {} : { showTitle }),
      ...(season === undefined ? {} : { season }),
      ...(episode === undefined ? {} : { episode }),
      ...(showYear === undefined ? {} : { showYear }),
      ...(showImdb === undefined ? {} : { showImdb }),
      ...(showId === undefined ? {} : { showId }),
      ...stated,
    };
  }
  return null;
}

/** A label the wire can carry: season 0 (specials) to 10,000, episode 1 to 100,000. */
function labelOf(text: string): Label | null {
  const label = parseEpisodeLabel(text);
  if (label === null) return null;
  const season = wholeNumber(label.season, 0, SEASON_NUMBER_MAX);
  const episode = wholeNumber(label.episode, 1, EPISODE_NUMBER_MAX);
  return season === undefined || episode === undefined ? null : { season, episode };
}

/** A part of a text that is a label and nothing else. */
const bareLabel = (part: string | undefined): Label | null =>
  part === undefined || part.length > MAX_BARE_LABEL ? null : labelOf(part);

/**
 * The label in `text` and, when the label stands apart at either end ("S1, E2 · Pilot",
 * "Pilot · S1, E2"), the rest of it — the episode's title. A label run into a title cannot
 * be cut out without its position, so it gives the numbers alone.
 */
function splitLabelled(text: string): { readonly label: Label; readonly rest?: string } | null {
  const pieces = text.split(PART_SEPARATOR);
  if (pieces.length >= 3) {
    const head = bareLabel(pieces[0]);
    if (head !== null) return withRest(head, pieces.slice(2).join(''));
    const tail = bareLabel(pieces[pieces.length - 1]);
    if (tail !== null) return withRest(tail, pieces.slice(0, -2).join(''));
  }
  const label = labelOf(text);
  return label === null ? null : { label };
}

function withRest(label: Label, text: string): { readonly label: Label; readonly rest?: string } {
  const rest = cleanText(text);
  return rest === undefined || labelOf(rest) !== null ? { label } : { label, rest };
}

/** A text that is not itself a label: a title. */
const titleOnly = (text: string | undefined): string | undefined =>
  text === undefined || labelOf(text) !== null ? undefined : text;

/**
 * What is playing, as the player's metadata says (the show and the label with the episode's
 * title, in either of its two lines), else the media session's label.
 */
function playingOf(snapshot: unknown): Playing {
  const title = textsOf(snapshot, 'playerTitle')[0];
  const subtitle = textsOf(snapshot, 'playerSubtitle')[0];
  for (const [line, other] of [
    [subtitle, title],
    [title, subtitle],
  ] as const) {
    const split = line === undefined ? null : splitLabelled(line);
    if (split === null) continue;
    const show = titleOnly(other);
    return {
      label: split.label,
      ...(show === undefined ? {} : { showTitle: show }),
      ...(split.rest === undefined ? {} : { episodeTitle: split.rest }),
    };
  }
  for (const key of ['title', 'artist', 'album'] as const) {
    const text = cleanText(jsonAt(snapshot, ['mediaSession', key]));
    const label = text === undefined ? null : labelOf(text);
    if (label !== null) return { label };
  }
  return title === undefined ? {} : { title };
}

/**
 * The player shows another item than the route's: it numbers an episode on a film's page,
 * or other numbers than the JSON-LD of the route's episode — Apple's player moved on (an
 * autoplay) and left the address where it was.
 */
function movedOn(routeKind: Kind, subject: Subject | null, playing: Playing): boolean {
  const label = playing.label;
  if (label === undefined) return false;
  if (routeKind === 'movie') return true;
  if (subject === null) return false;
  return (
    (subject.season !== undefined && subject.season !== label.season) ||
    (subject.episode !== undefined && subject.episode !== label.episode)
  );
}

/**
 * The ids the page states for an item, as this module checked them. Every reading states
 * them, empty when it knows none: the generic JSON-LD reader takes the first node it finds,
 * whichever item that node is about, and its ids would fill the gap — the strongest evidence
 * there is, of another title, once Apple's app moved on from the page it loaded.
 */
const statedIds = (imdb: string | undefined) => field(imdb === undefined ? {} : { imdb }, STATED);

const NO_STATED_IDS = { ids: statedIds(undefined), showIds: statedIds(undefined) } as const;

/** What the player alone says of an episode it moved on to: no id, no JSON-LD. */
function playedEpisode(label: Label, playing: Playing): ServiceReading {
  return {
    kind: field('episode', PLAYED),
    season: field(label.season, PLAYED),
    episode: field(label.episode, PLAYED),
    ...(playing.showTitle === undefined ? {} : { showTitle: field(playing.showTitle, PLAYED) }),
    ...(playing.episodeTitle === undefined
      ? {}
      : { episodeTitle: field(playing.episodeTitle, PLAYED) }),
    ...NO_STATED_IDS,
    contentEnded: false,
  };
}

/** A field from what JSON-LD stated about the item, else from what the player showed. */
function either<T>(stated: T | undefined, played: T | undefined): Field<T> | undefined {
  if (stated !== undefined) return field(stated, STATED);
  return played === undefined ? undefined : field(played, PLAYED);
}

/**
 * The route's id at the title level and, for an episode, its series' id at the show level: the
 * one the address's `showId` and the JSON-LD about the episode (`partOfSeries`) name — either,
 * or both when they agree. Two that disagree are a conflict, and a conflict states nothing;
 * a series id that is the episode's own is none.
 */
function providerIdsOf(
  snapshot: unknown,
  id: string,
  kind: Kind,
  subject: Subject | null,
): NonNullable<ServiceReading['providerIds']> {
  const query = jsonAt(snapshot, ['url', 'query', 'showId']);
  const queried = typeof query === 'string' && CONTENT_ID.test(query) ? query : undefined;
  const stated = subject?.showId;
  const showId =
    queried !== undefined && stated !== undefined && queried !== stated
      ? undefined
      : (queried ?? stated);
  const show =
    kind === 'episode' && showId !== undefined && showId !== id
      ? [{ level: 'show', key: 'contentId', value: showId } as const]
      : [];
  return [{ level: 'title', key: 'contentId', value: id }, ...show];
}

/** The player route's item: its content id and whether the route names an episode or a film. */
function routeItem(snapshot: Snapshot): { readonly id: string; readonly kind: Kind } | null {
  const pathname = jsonAt(snapshot, ['url', 'pathname']);
  if (typeof pathname !== 'string') return null;
  const match = matchPlayerRoute(PLAYER_ROUTES, pathname);
  const word = match?.[1];
  const id = match?.[2];
  if (word === undefined || id === undefined || !CONTENT_ID.test(id)) return null;
  return { id, kind: word === 'episode' ? 'episode' : 'movie' };
}

/** What the route's film reading carries beside its kind: the film's title, year and ids. */
function filmReading(subject: Subject | null, playing: Playing): ServiceReading {
  const title = either(subject?.title, playing.title);
  const year = either(subject?.year, undefined);
  return {
    ...(title === undefined ? {} : { title }),
    ...(year === undefined ? {} : { year }),
    ids: statedIds(subject?.imdb),
  };
}

/** What the route's episode reading carries beside its kind: the show, the numbers, the ids. */
function episodeReading(subject: Subject | null, playing: Playing): ServiceReading {
  const showTitle = either(subject?.showTitle, playing.showTitle);
  const season = either(subject?.season, playing.label?.season);
  const episode = either(subject?.episode, playing.label?.episode);
  const episodeTitle = either(subject?.title, playing.episodeTitle);
  const showYear = either(subject?.showYear, undefined);
  return {
    ...(showTitle === undefined ? {} : { showTitle }),
    ...(season === undefined ? {} : { season }),
    ...(episode === undefined ? {} : { episode }),
    ...(episodeTitle === undefined ? {} : { episodeTitle }),
    ...(showYear === undefined ? {} : { showYear }),
    ids: statedIds(subject?.imdb),
    showIds: statedIds(subject?.showImdb),
  };
}

/**
 * The reading of one Apple TV snapshot, total over any shape the snapshot takes. The item's
 * own id is the route's and nothing else's, and JSON-LD counts only when it is about that
 * item; when the player shows another item, the route's id and JSON-LD are left out.
 */
function interpret(snapshot: Snapshot): ServiceReading | null {
  const item = routeItem(snapshot);
  if (item === null) return null;
  const { id, kind: routeKind } = item;
  const subject = subjectOf(snapshot, id, routeKind);
  const runtime =
    subject?.durationSeconds === undefined
      ? {}
      : { contentDurationSeconds: subject.durationSeconds };

  // No long-form player: what plays is a promotional video (a trailer in the page's header).
  // It is not the content, so its end is not the content's end nor its length the title's.
  if (textsOf(snapshot, 'player').length === 0) {
    return { adPlaying: true, ...NO_STATED_IDS, ...runtime };
  }

  // The up-next card names what comes next: of what played it says only that it ended.
  if (signalled(snapshot, 'endOfContent') && !signalled(snapshot, 'adPlaying')) {
    return { contentEnded: true, ...NO_STATED_IDS };
  }

  const playing = playingOf(snapshot);
  if (playing.label !== undefined && movedOn(routeKind, subject, playing)) {
    return playedEpisode(playing.label, playing);
  }

  const kind = subject?.kind ?? routeKind;
  return {
    kind: field(kind, subject === null ? PLAYED : STATED),
    ...(kind === 'movie' ? filmReading(subject, playing) : episodeReading(subject, playing)),
    ...runtime,
    providerIds: providerIdsOf(snapshot, id, kind, subject),
    contentEnded: false,
  };
}

export const appleTv = defineService({
  id: 'apple_tv',
  name: 'Apple TV',
  version: '0.1.1',
  hosts: ['tv.apple.com'],
  verified: null,
  playerRoutes: PLAYER_ROUTES,
  collect: {
    selectors: {
      // Present while the long-form player is open; its value is only the test id.
      player: { css: PLAYER_CSS, attr: 'data-testid', visibleOnly: false, max: 1 },
      // The player's two lines, kept while its controls are hidden: identity is checked
      // against them whenever they are there.
      playerTitle: {
        css: `${PLAYER_CSS} [data-testid="player-metadata-title"]`,
        visibleOnly: false,
        max: 1,
      },
      playerSubtitle: {
        css: `${PLAYER_CSS} [data-testid="player-metadata-subtitle"]`,
        visibleOnly: false,
        max: 1,
      },
      // The item the server rendered the page for: JSON-LD without a URL is checked by it.
      contentId: {
        css: 'meta[name="apple:content_id"]',
        attr: 'content',
        visibleOnly: false,
        max: 1,
      },
    },
    jsonLd: true,
    mediaSession: true,
    openGraph: true,
    queryParams: ['showId'],
    signals: { endOfContent: END_OF_CONTENT },
  },
  interpret,
});
