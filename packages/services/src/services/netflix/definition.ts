/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The Netflix module. What it reads, and why, is in README.md beside it.

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
  parseEpisodeOnlyLabel,
} from '../../helpers';
import { MAX_SELECTOR_VALUES, defineService, matchPlayerRoute } from '../../sdk';
import type { ServiceReading, Snapshot } from '../../sdk';

/** The player: `/watch/<video id>`, with or without a locale segment (`/gb/`, `/de-en/`). */
const PLAYER_ROUTES: readonly RegExp[] = [/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?watch\/(\d+)/];

/** A video id as the route carries it: digits, well inside the wire's 200 characters. */
const VIDEO_ID = /^\d{1,20}$/;

/** The player's own title area, read through the label grammar: above every generic reader. */
const TITLE_AREA = 0.8;
/** The player's own metadata of the route's video (README.md, *Page state*). */
const PLAYER_STATE_CONFIDENCE = 0.95;

/** The player's state (`playerApp.getState()`), down to its video player. */
const VIDEO_PLAYER = [
  'netflix',
  'appContext',
  'state',
  'playerApp',
  { call: 'getState' },
  'videoPlayer',
] as const;

/**
 * The player's playback sessions, keyed by session id, each naming the video it plays — a
 * small object, unlike the per-video metadata beside it (README.md, *Page state*).
 */
const PLAYBACK_SESSIONS = [...VIDEO_PLAYER, 'playbackStateBySessionId'] as const;

/**
 * The metadata of the route's video — keyed by the id capture group 1 of the route holds, so no
 * other video's is read. **Unverified** (README.md): the place under `videoPlayer` is the one
 * prior art reports, not yet seen in a capture; where it is absent, nothing is read from it.
 */
const ROUTE_VIDEO = [
  ...VIDEO_PLAYER,
  'videoMetadata',
  { routeGroup: 1 },
  '_metadata',
  'video',
] as const;

/** The season that holds the route's episode: the first whose episodes name its id. */
const ROUTE_SEASON = [
  ...ROUTE_VIDEO,
  'seasons',
  { find: { key: ['episodes', '*', 'id'], routeGroup: 1 } },
] as const;

/**
 * The server-rendered Falcor cache's entry of the route's video (README.md, *Page state*; seen
 * on the real page): its `summary`, `runtime` and `creditsOffset` atoms, each
 * `{ $type: "atom", value }`. One entry for the three: a module reads at most four.
 * `creditsOffset` is the reading's credits start — where the story ends — and ends
 * nothing of its own.
 */
const ROUTE_FALCOR = [
  'netflix',
  'falcorCache',
  'videos',
  { routeGroup: 1 },
  { pick: ['summary', 'runtime', 'creditsOffset'] },
] as const;

/** The player's root, which names the video it plays even while the controls are hidden. */
const PLAYER_CSS = '[data-uia="player"]';

/** Sessions looked at: a player holds the one it plays and, at most, a preview or two. */
const MAX_SESSIONS = 16;
const MS_PER_SECOND = 1000;

/** The most of one page string `interpret` looks at, whatever the snapshot holds. */
const MAX_TEXT_INPUT = 1000;

/** The player's title area: the show (or the film) in an `h4`, label and episode in spans. */
const TITLE_AREA_CSS = '[data-uia="video-title"]';

/**
 * The end of the content, as Netflix shows it: the next-episode buttons of the credits
 * (the seamless one and its countdown), *Watch credits*, and the post-play screen.
 */
const END_OF_CONTENT = [
  '[data-uia="next-episode-seamless-button"]',
  '[data-uia="next-episode-seamless-button-draining"]',
  '[data-uia="watch-credits-seamless-button"]',
  '.postplay',
].join(', ');

type Fields = Omit<ServiceReading, 'providerIds' | 'contentEnded' | 'adPlaying'>;

/** A page string made a title: whitespace collapsed, trimmed, at most 200 code points. */
function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return clampTitle(value.slice(0, MAX_TEXT_INPUT).replace(/\s+/gu, ' '));
}

/** The non-blank texts the collector returned for a selector, at most five. */
function textsOf(snapshot: unknown, name: string): readonly string[] {
  const values = jsonAt(snapshot, ['selectors', name]);
  const items = Array.isArray(values) ? (values as readonly unknown[]) : [];
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

const inRange = (n: number, min: number, max: number): boolean =>
  Number.isInteger(n) && n >= min && n <= max;

/** A title-area label: where it is among the parts (`-1`: the heading), and its numbers. */
interface AreaLabel {
  readonly at: number;
  readonly season?: number;
  readonly episode: number;
}

/** A part that is a label of either form, and so never an episode's title. */
const isLabel = (part: string): boolean =>
  parseEpisodeLabel(part) !== null || parseEpisodeOnlyLabel(part) !== null;

/**
 * The title area's label: a part that is a season-and-episode label, else the heading as one,
 * else a part that is an episode-only label ("Еп. 3": a single-season show), whose
 * season stays unknown.
 */
function areaLabel(heading: string | undefined, parts: readonly string[]): AreaLabel | null {
  for (const [at, part] of parts.entries()) {
    const label = parseEpisodeLabel(part);
    if (label !== null) return { at, ...label };
  }
  const headingLabel = heading === undefined ? null : parseEpisodeLabel(heading);
  if (headingLabel !== null) return { at: -1, ...headingLabel };
  for (const [at, part] of parts.entries()) {
    const episode = parseEpisodeOnlyLabel(part);
    if (episode !== null) return { at, episode };
  }
  return null;
}

/**
 * What the title area says: an episode when one of its parts is a label — season and episode,
 * or the episode alone — the show in the heading and the episode's title in the part after the
 * label; a film when the heading stands alone. A heading beside parts that hold no label the
 * grammar reads is an episode whose numbers are not known — never a film of the show's name.
 */
function readTitleArea(snapshot: unknown): Fields {
  const heading = textsOf(snapshot, 'titleHeading')[0];
  const parts = textsOf(snapshot, 'titleParts').filter((part) => part !== heading);
  const show = heading === undefined || parseEpisodeLabel(heading) !== null ? undefined : heading;
  const label = areaLabel(heading, parts);

  if (label !== null) {
    // The episode's title follows its label; failing that, it is the one other part.
    const after = parts.slice(label.at + 1).find((part) => !isLabel(part));
    const others = parts.filter((_part, index) => index !== label.at);
    const episodeTitle = after ?? (others.length === 1 ? others[0] : undefined);
    const season =
      label.season !== undefined && inRange(label.season, 0, SEASON_NUMBER_MAX)
        ? label.season
        : undefined;
    const episode = inRange(label.episode, 1, EPISODE_NUMBER_MAX) ? label.episode : undefined;
    return {
      kind: field('episode', TITLE_AREA),
      ...(show === undefined ? {} : { showTitle: field(show, TITLE_AREA) }),
      ...(season === undefined ? {} : { season: field(season, TITLE_AREA) }),
      ...(episode === undefined ? {} : { episode: field(episode, TITLE_AREA) }),
      ...(episodeTitle === undefined ? {} : { episodeTitle: field(episodeTitle, TITLE_AREA) }),
    };
  }
  if (show === undefined) return {};
  if (parts.length === 0) {
    return { kind: field('movie', TITLE_AREA), title: field(show, TITLE_AREA) };
  }
  return { kind: field('episode', TITLE_AREA), showTitle: field(show, TITLE_AREA) };
}

/** A session's video id as the route spells it: digits, from a number or a string. */
function videoIdOf(session: unknown): string | undefined {
  const id = jsonAt(session, ['videoId']);
  if (typeof id === 'number') return Number.isSafeInteger(id) && id >= 0 ? String(id) : undefined;
  return typeof id === 'string' ? id : undefined;
}

/** A content length: from the shortest content to a week (a value in seconds would be less). */
const isContentLength = (seconds: number): boolean =>
  seconds >= MIN_CONTENT_SECONDS && seconds <= MAX_SECONDS;

/**
 * The content's length as the player states it, in whole seconds: the `duration` of the
 * session that plays the route's video, never another's (the previous episode's, a
 * preview's). Netflix's player counts milliseconds; a length outside the shortest content and
 * a week — a value in seconds would be one — or two sessions that disagree state nothing.
 */
function sessionLength(snapshot: unknown, videoId: string): number | undefined {
  const sessions = jsonAt(snapshot, ['pageState', 'playback']);
  if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) {
    return undefined;
  }
  let length: number | undefined;
  let examined = 0;
  for (const key in sessions) {
    if (examined === MAX_SESSIONS) break;
    examined += 1;
    const session = jsonAt(sessions, [key]);
    if (videoIdOf(session) !== videoId) continue;
    const duration = jsonAt(session, ['duration']);
    if (typeof duration !== 'number' || !Number.isFinite(duration)) continue;
    const seconds = Math.floor(duration / MS_PER_SECOND);
    if (!isContentLength(seconds)) continue;
    if (length !== undefined && length !== seconds) return undefined;
    length = seconds;
  }
  return length;
}

/** A Falcor atom's value in the route video's cache entry (`{ $type: "atom", value }`). */
const falcorAtom = (snapshot: unknown, name: string): unknown =>
  jsonAt(snapshot, ['pageState', 'falcor', name, 'value']);

/**
 * The content's length as Netflix states it, in whole seconds: the route's session's; failing
 * one, the `runtime` the server rendered for the route's video (seconds), in the same bounds.
 */
function statedLength(snapshot: unknown, videoId: string): number | undefined {
  const session = sessionLength(snapshot, videoId);
  if (session !== undefined) return session;
  const runtime = falcorAtom(snapshot, 'runtime');
  if (typeof runtime !== 'number' || !Number.isFinite(runtime)) return undefined;
  const seconds = Math.floor(runtime);
  return isContentLength(seconds) ? seconds : undefined;
}

/** An id as the page state spells it — a whole number or a string — in the route's digits. */
function idOf(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined;
  }
  return typeof value === 'string' && VIDEO_ID.test(value) ? value : undefined;
}

/** The cache entry's summary names the route's video: what the entry says is about it. */
const summaryIsRoute = (snapshot: unknown, videoId: string): boolean =>
  idOf(jsonAt(falcorAtom(snapshot, 'summary'), ['id'])) === videoId;

/**
 * Where the route video's credits start, in seconds, as the server rendered it
 * (`creditsOffset`): the story's end, stated only when the entry's summary names
 * the route's video. A value that is no position — not a finite number, negative,
 * past a week — states nothing; core keeps it only in the content's second half.
 */
function creditsStart(snapshot: unknown, videoId: string): number | undefined {
  if (!summaryIsRoute(snapshot, videoId)) return undefined;
  const offset = falcorAtom(snapshot, 'creditsOffset');
  if (typeof offset !== 'number' || !Number.isFinite(offset)) return undefined;
  return offset >= 0 && offset <= MAX_SECONDS ? offset : undefined;
}

/**
 * What the server-rendered summary says of the route's video (README.md, *Page state*), at
 * `0.95`; nothing when it is absent or about another video. Its numbers only where Netflix does
 * not hide them.
 */
function readSummary(snapshot: unknown, videoId: string, hidden: boolean): Fields {
  const summary = falcorAtom(snapshot, 'summary');
  if (!summaryIsRoute(snapshot, videoId)) return {};
  const type = jsonAt(summary, ['type']);
  if (type === 'movie') return { kind: field('movie', PLAYER_STATE_CONFIDENCE) };
  if (type !== 'episode') return {};
  const season = jsonAt(summary, ['season']);
  const episode = jsonAt(summary, ['episode']);
  return {
    kind: field('episode', PLAYER_STATE_CONFIDENCE),
    ...(!hidden && typeof season === 'number' && inRange(season, 0, SEASON_NUMBER_MAX)
      ? { season: field(season, PLAYER_STATE_CONFIDENCE) }
      : {}),
    ...(!hidden && typeof episode === 'number' && inRange(episode, 1, EPISODE_NUMBER_MAX)
      ? { episode: field(episode, PLAYER_STATE_CONFIDENCE) }
      : {}),
  };
}

/** What the page state says of the route's video, and the id of its show when it names one. */
interface StateReading {
  readonly fields: Fields;
  /** The show's own id (a video id in Netflix's numbering), never the route's. */
  readonly showId?: string;
}

const NOTHING_STATED: StateReading = { fields: {} };

/**
 * What the player's own metadata says of the route's video (README.md, *Page state*), at
 * `0.95`; nothing when the entries are absent or about another video. A film: its title and
 * year. An episode: its show's title and the show's own id (a show's id sits on the show),
 * and its own title when the entry of the route's episode was found. The numbers are the
 * summary's.
 */
function readPlayerState(snapshot: unknown, videoId: string): StateReading {
  const video = jsonAt(snapshot, ['pageState', 'video']);
  const type = jsonAt(video, ['type']);
  const name = cleanText(jsonAt(video, ['title']));
  if (type === 'movie') {
    if (idOf(jsonAt(video, ['id'])) !== videoId) return NOTHING_STATED;
    const year = jsonAt(video, ['year']);
    return {
      fields: {
        kind: field('movie', PLAYER_STATE_CONFIDENCE),
        ...(name === undefined ? {} : { title: field(name, PLAYER_STATE_CONFIDENCE) }),
        ...(typeof year === 'number' && isYear(year)
          ? { year: field(year, PLAYER_STATE_CONFIDENCE) }
          : {}),
      },
    };
  }
  if (type !== 'show') return NOTHING_STATED;
  const episode = jsonAt(snapshot, ['pageState', 'episode']);
  const found = idOf(jsonAt(episode, ['id'])) === videoId;
  if (!found && idOf(jsonAt(video, ['currentEpisode'])) !== videoId) return NOTHING_STATED;
  const episodeTitle = found ? cleanText(jsonAt(episode, ['title'])) : undefined;
  // The show's id is the entry's own; one that is the route's would name the episode twice.
  const showId = idOf(jsonAt(video, ['id']));
  return {
    fields: {
      kind: field('episode', PLAYER_STATE_CONFIDENCE),
      ...(name === undefined ? {} : { showTitle: field(name, PLAYER_STATE_CONFIDENCE) }),
      ...(episodeTitle === undefined
        ? {}
        : { episodeTitle: field(episodeTitle, PLAYER_STATE_CONFIDENCE) }),
    },
    ...(showId === undefined || showId === videoId ? {} : { showId }),
  };
}

/**
 * The route video's state: the server-rendered summary (seen on the real page) for the kind
 * and the numbers, the player's metadata (unverified) for the titles and the show's id. Where
 * the two name different kinds, the summary stands alone.
 */
function readState(snapshot: unknown, videoId: string, hidden: boolean): StateReading {
  const summary = readSummary(snapshot, videoId, hidden);
  const metadata = readPlayerState(snapshot, videoId);
  if (summary.kind === undefined) return metadata;
  const kind = metadata.fields.kind;
  if (kind !== undefined && kind.value !== summary.kind.value) return { fields: summary };
  return { ...metadata, fields: { ...metadata.fields, ...summary } };
}

/**
 * The player's state first, the title area for what it leaves out — and only what fits the
 * kind the state names, so a film's reading never takes the title area's episode fields, nor an
 * episode's the heading as a film title. Numbers Netflix hides are not taken from either.
 */
function combine(state: Fields, area: Fields, hidden: boolean): Fields {
  const kind = state.kind?.value;
  if (kind === undefined) return area;
  if (kind === 'movie') {
    return { ...(area.title === undefined ? {} : { title: area.title }), ...state };
  }
  return {
    ...(area.showTitle === undefined ? {} : { showTitle: area.showTitle }),
    ...(area.episodeTitle === undefined ? {} : { episodeTitle: area.episodeTitle }),
    ...(area.season === undefined || hidden ? {} : { season: area.season }),
    ...(area.episode === undefined || hidden ? {} : { episode: area.episode }),
    ...state,
  };
}

/**
 * The reading of one Netflix snapshot, total over any shape the snapshot takes. The title's
 * own id is the route's and nothing else's; the post-play screen says only that this title
 * ended, since what it shows is the next one.
 */
function interpret(snapshot: Snapshot): ServiceReading | null {
  const pathname = jsonAt(snapshot, ['url', 'pathname']);
  if (typeof pathname !== 'string') return null;
  const videoId = matchPlayerRoute(PLAYER_ROUTES, pathname)?.[1];
  if (videoId === undefined || !VIDEO_ID.test(videoId)) return null;
  // The player's root names the video it plays. Another than the route's is a switch under
  // way (the address moved first): nothing in this snapshot is about the route's video yet.
  const playing = textsOf(snapshot, 'playerVideoId')[0];
  if (playing !== undefined && playing !== videoId) return { contentEnded: false };
  const title = { level: 'title', key: 'videoId', value: videoId } as const;

  if (signalled(snapshot, 'endOfContent') && !signalled(snapshot, 'adPlaying')) {
    return { providerIds: [title], contentEnded: true };
  }
  const length = statedLength(snapshot, videoId);
  const credits = creditsStart(snapshot, videoId);
  const hidden = jsonAt(snapshot, ['pageState', 'video', 'hiddenEpisodeNumbers']) === true;
  const state = readState(snapshot, videoId, hidden);
  // Netflix numbers a show as a video, so its id is stated under the same key, a level up.
  const providerIds: NonNullable<ServiceReading['providerIds']> =
    state.showId === undefined
      ? [title]
      : [title, { level: 'show', key: 'videoId', value: state.showId }];
  return {
    ...combine(state.fields, readTitleArea(snapshot), hidden),
    ...(length === undefined ? {} : { contentDurationSeconds: length }),
    ...(credits === undefined ? {} : { creditsStartSeconds: credits }),
    providerIds,
    contentEnded: false,
  };
}

export const netflix = defineService({
  id: 'netflix',
  name: 'Netflix',
  version: '0.1.0',
  hosts: ['netflix.com'],
  verified: null,
  playerRoutes: PLAYER_ROUTES,
  collect: {
    selectors: {
      // Hidden controls are kept: identity is the route's, and the end screen is read apart.
      titleHeading: { css: `${TITLE_AREA_CSS} h4`, visibleOnly: false, max: 1 },
      titleParts: { css: `${TITLE_AREA_CSS} span`, visibleOnly: false, max: 4 },
      // In the page whether the controls show or not.
      playerVideoId: { css: PLAYER_CSS, attr: 'data-videoid', visibleOnly: false, max: 1 },
    },
    mediaSession: true,
    pageState: {
      playback: PLAYBACK_SESSIONS,
      video: [
        ...ROUTE_VIDEO,
        { pick: ['type', 'id', 'title', 'year', 'currentEpisode', 'hiddenEpisodeNumbers'] },
      ],
      episode: [
        ...ROUTE_SEASON,
        'episodes',
        { find: { key: ['id'], routeGroup: 1 } },
        { pick: ['id', 'title'] },
      ],
      falcor: ROUTE_FALCOR,
    },
    signals: { endOfContent: END_OF_CONTENT },
  },
  interpret,
});
