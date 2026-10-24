/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { PlayedRanges } from './coverage';
import type { IgnoredReason } from './ignored';
import type { ProviderId, StatedIds } from './reading';
import type { EpochMs } from './time';
import { playedSeconds, storySeconds } from './viewing';
import type { Viewing } from './viewing';

export interface ProviderEntry {
  namespace: string;
  key: string;
  value: string;
}

interface PlayIds {
  tmdb?: number;
  imdb?: string;
  provider?: ProviderEntry[];
}

/**
 * What every report says of the item and of how far it played: a viewing's and a start's. The
 * builder always states all four numbers; they are optional here because a body stored by an
 * earlier version, still waiting in the outbox, may lack the last two.
 */
interface Evidence {
  kind: 'movie' | 'episode';
  ids?: PlayIds;
  title?: string;
  year?: number;
  show?: { ids?: PlayIds; title?: string; year?: number };
  season_number?: number;
  episode_number?: number;
  /** The running time. */
  duration_seconds?: number;
  /** How far the player got. */
  furthest_position_seconds?: number;
  /** The story: the running time without the intro and the end credits. */
  story_seconds?: number;
  /** The story's seconds played at least once: what the account's lines are measured by. */
  played_seconds?: number;
}

/**
 * A viewing, reported the moment it reached the account's finish line: when that was, and
 * whether the title itself had played out by then (`ended`: the element reached its end, or the
 * service showed its end).
 */
export interface ViewingBody extends Evidence {
  report?: never;
  watched_at: string;
  ended?: boolean;
}

/**
 * A film begun. The server refuses any other shape: it is a film's, it carries both numbers, and
 * it never says when the viewing finished or that it ended, because it has not.
 */
export interface StartBody extends Evidence {
  report: 'start';
  kind: 'movie';
  duration_seconds: number;
  furthest_position_seconds: number;
  watched_at?: never;
  ended?: never;
}

/**
 * The domain's own mirror of the wire body of `POST /v1/integrations/plays`. The api package
 * proves it assignable to the generated `PlayEvidence`.
 */
export type PlayBody = ViewingBody | StartBody;

/** The body says a film was begun, not that a viewing counted. */
export const isStart = (body: PlayBody): body is StartBody => body.report === 'start';

export const MAX_PROVIDER_ENTRIES = 8;
export const MAX_TITLE_CODE_POINTS = 200;
export const MAX_BODY_BYTES = 16 * 1024;
// The server's bounds on an episode's numbers.
export const SEASON_NUMBER_MAX = 10_000;
export const EPISODE_NUMBER_MAX = 100_000;
/** A week: the cap on `duration_seconds` and `furthest_position_seconds`. */
export const MAX_SECONDS = 7 * 24 * 3600;

const NAMESPACE = /^[a-z][a-z0-9._-]*$/;
const KEY = /^[a-z][A-Za-z0-9._-]*$/;
const VALUE = /^[\x20-\x7e]+$/;
const IMDB = /^tt[0-9]{5,10}$/;

export const isProviderNamespace = (s: string): boolean => s.length <= 64 && NAMESPACE.test(s);
export const isProviderKey = (s: string): boolean => s.length <= 64 && KEY.test(s);
/** Printable ASCII without `"` or `\`, 1 to 200 characters. */
export const isProviderValue = (s: string): boolean =>
  s.length <= 200 && VALUE.test(s) && !s.includes('"') && !s.includes('\\');
export const isYear = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 1870 && n <= 2200;
export const isImdbId = (s: unknown): s is string => typeof s === 'string' && IMDB.test(s);

/** Trimmed, at most 200 code points; empty is absent. */
export function clampTitle(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const clamped = Array.from(s.trim()).slice(0, MAX_TITLE_CODE_POINTS).join('').trim();
  return clamped === '' ? undefined : clamped;
}

const isPositiveInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n > 0;

/** An integer in `0..max`: TMDB numbers its specials season 0. */
const inRange = (n: unknown, max: number): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max;

function providerEntries(
  serviceId: string | null,
  ids: readonly ProviderId[] | undefined,
  level: ProviderId['level'],
): ProviderEntry[] {
  if (serviceId === null || ids === undefined) return [];
  const namespace = `provider.${serviceId}`;
  if (!isProviderNamespace(namespace)) return [];
  const out: ProviderEntry[] = [];
  for (const id of ids) {
    if (id.level !== level) continue;
    if (!isProviderKey(id.key) || !isProviderValue(id.value)) continue;
    if (out.some((e) => e.key === id.key && e.value === id.value)) continue;
    out.push({ namespace, key: id.key, value: id.value });
    if (out.length === MAX_PROVIDER_ENTRIES) break;
  }
  return out;
}

function idsOf(stated: StatedIds | undefined, provider: ProviderEntry[]): PlayIds | undefined {
  const ids: PlayIds = {};
  if (isPositiveInt(stated?.tmdb)) ids.tmdb = stated.tmdb;
  if (isImdbId(stated?.imdb)) ids.imdb = stated.imdb;
  if (provider.length > 0) ids.provider = provider;
  return Object.keys(ids).length > 0 ? ids : undefined;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** ISO 8601 to the second, in the viewer's local offset (minutes east of UTC). */
function isoWithOffset(at: EpochMs, offsetMinutes: number): string {
  if (!Number.isFinite(at) || !Number.isFinite(offsetMinutes)) {
    throw new RangeError('buildPlay: watchedAt and offsetMinutes must be finite');
  }
  const local = new Date(Math.floor(at / 1000) * 1000 + offsetMinutes * 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return (
    `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** UTF-8 length of the serialised body (core has no `TextEncoder`: it has no DOM types). */
export function bodyBytes(b: PlayBody): number {
  let bytes = 0;
  for (const ch of JSON.stringify(b)) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function withoutProviders<B extends PlayBody>(body: B): B {
  const strip = (ids: PlayIds | undefined): PlayIds | undefined => {
    const out: PlayIds = {};
    if (ids?.tmdb !== undefined) out.tmdb = ids.tmdb;
    if (ids?.imdb !== undefined) out.imdb = ids.imdb;
    return Object.keys(out).length > 0 ? out : undefined;
  };
  const out: B = { ...body };
  delete out.ids;
  delete out.show;
  const bodyIds = strip(body.ids);
  if (bodyIds !== undefined) out.ids = bodyIds;
  if (body.show !== undefined) {
    const show: NonNullable<PlayBody['show']> = {};
    if (body.show.title !== undefined) show.title = body.show.title;
    if (body.show.year !== undefined) show.year = body.show.year;
    const showIds = strip(body.show.ids);
    if (showIds !== undefined) show.ids = showIds;
    out.show = show;
  }
  return out;
}

/**
 * Why `buildPlay` refuses a viewing's reading, in the order of `IGNORED_REASONS`:
 * an episode with neither number (`series_no_episode`), or one without its show's title, a film
 * with no title and no id (`no_title`); `null` when its reading would make a play. Without its
 * series' title or a number the server cannot place an episode; it would only wait in the app as
 * text_only / numbering_unknown, so it stays local.
 */
export function playRefusal(
  v: Viewing,
): Extract<IgnoredReason, 'series_no_episode' | 'no_title'> | null {
  const r = v.reading;
  if (r.kind === 'episode') {
    if (!inRange(r.season, SEASON_NUMBER_MAX) && !inRange(r.episode, EPISODE_NUMBER_MAX)) {
      return 'series_no_episode';
    }
    return clampTitle(r.showTitle) === undefined ? 'no_title' : null;
  }
  return clampTitle(r.title) === undefined &&
    idsOf(r.ids, providerEntries(v.serviceId, r.providerIds, 'title')) === undefined
    ? 'no_title'
    : null;
}

/** The viewing's length as a report sends it: whole seconds, 1 to `MAX_SECONDS`; else unknown. */
function sentDurationSeconds(v: Viewing): number | null {
  const duration = v.durationSeconds === null ? NaN : Math.floor(v.durationSeconds);
  return Number.isFinite(duration) && duration >= 1 && duration <= MAX_SECONDS ? duration : null;
}

/** The end of the furthest played range as a report sends it: whole seconds, within the length. */
function sentFurthestSeconds(v: Viewing, duration: number): number {
  const furthest = Math.floor(PlayedRanges.fromJSON(v.ranges).furthest());
  return Math.min(Math.max(furthest, 0), duration);
}

/** Evidence with its four numbers, as every report sends it. */
interface Measured extends Evidence {
  duration_seconds: number;
  furthest_position_seconds: number;
  story_seconds: number;
  played_seconds: number;
}

/**
 * What a viewing's play and its start both say: the item as the page named it and how much of it
 * played — the running time, the furthest position, the story and the story seconds played. Ids
 * only when the page stated them, nothing that identifies the person, the page or the account,
 * and every value checked against the server's rules so nothing is sent to be refused. `null`
 * when the result could not be accepted anyway (`playRefusal`), and while the length is unknown:
 * without a story nothing can be judged. One builder for both, so a number the server comes to
 * take is added once.
 */
function evidenceOf(v: Viewing): Measured | null {
  const r = v.reading;
  const kind = r.kind;
  if ((kind !== 'movie' && kind !== 'episode') || playRefusal(v) !== null) return null;
  const duration = sentDurationSeconds(v);
  const story = storySeconds(v);
  if (duration === null || story === null) return null;

  const body: Evidence = { kind };

  const ids = idsOf(r.ids, providerEntries(v.serviceId, r.providerIds, 'title'));
  if (ids !== undefined) body.ids = ids;
  // An episode's own title only: `title` may hold the show's name. A top-level year is a film's
  // only: on an episode's reading `year` comes from a title read as a work's — a Media Session
  // title with no label, whose kind another reader gave — so it is the show's, and goes on the
  // show where the reading states no show year of its own.
  const title = clampTitle(kind === 'episode' ? r.episodeTitle : r.title);
  if (title !== undefined) body.title = title;
  if (kind === 'movie' && isYear(r.year)) body.year = r.year;

  if (kind === 'episode') {
    const showTitle = clampTitle(r.showTitle) ?? '';
    const season = inRange(r.season, SEASON_NUMBER_MAX) ? r.season : undefined;
    const episode = inRange(r.episode, EPISODE_NUMBER_MAX) ? r.episode : undefined;

    const show: NonNullable<Evidence['show']> = { title: showTitle };
    const showIds = idsOf(r.showIds, providerEntries(v.serviceId, r.providerIds, 'show'));
    if (showIds !== undefined) show.ids = showIds;
    const showYear = isYear(r.showYear) ? r.showYear : r.year;
    if (isYear(showYear)) show.year = showYear;
    body.show = show;
    if (season !== undefined) body.season_number = season;
    if (episode !== undefined) body.episode_number = episode;
  }

  return {
    ...body,
    duration_seconds: duration,
    furthest_position_seconds: sentFurthestSeconds(v, duration),
    // The story lies inside the content, so it is never longer than the running time sent.
    story_seconds: Math.min(story, duration),
    played_seconds: Math.min(playedSeconds(v), story, duration),
  };
}

/** The body within the server's cap: as built, else without the service's ids; else `null`. */
function withinCap<B extends PlayBody>(body: B): B | null {
  if (bodyBytes(body) <= MAX_BODY_BYTES) return body;
  const slim = withoutProviders(body);
  return bodyBytes(slim) <= MAX_BODY_BYTES ? slim : null;
}

/**
 * The one constructor of a play. What it returns is what reaches the person's diary as evidence
 * (`evidenceOf`), with when it reached the finish line and whether the title had played out by
 * then. `null` when the result could not be accepted anyway (`playRefusal`): nothing identifies
 * it, an episode lacks its show's title or both numbers, or the length is unknown.
 */
export function buildPlay(
  v: Viewing,
  watchedAt: EpochMs,
  offsetMinutes: number,
): ViewingBody | null {
  const evidence = evidenceOf(v);
  if (evidence === null) return null;
  const { kind, ...rest } = evidence;
  return withinCap({
    kind,
    watched_at: isoWithOffset(watchedAt, offsetMinutes),
    ...rest,
    // Only what the player or the service saw: the element reached its end, or the service
    // showed its credits or post-play screen. The server counts any play that says so, so the
    // extension's own estimate of the credits, and a stated credits start, never do.
    ended: v.contentEnded,
  });
}

/**
 * The start of a film begun: the evidence its play would carry, without when it was watched and
 * whether it ended, which a film still playing cannot say. `null` for anything but a film whose
 * length is known, or one whose play could not be built either.
 */
export function buildStart(v: Viewing): StartBody | null {
  const evidence = evidenceOf(v);
  if (evidence?.kind !== 'movie') return null;
  return withinCap({ report: 'start', ...evidence, kind: 'movie' });
}

/**
 * The words a play is shown by, as the toolbar says them: `Show · S1 E2` for
 * an episode, the title for a film. `null` when the play names nothing in words.
 */
export function playLabel(body: PlayBody): string | null {
  if (body.kind === 'movie') return body.title ?? null;
  const show = body.show?.title;
  if (show === undefined) return null;
  const numbers = [
    body.season_number === undefined ? null : `S${String(body.season_number)}`,
    body.episode_number === undefined ? null : `E${String(body.episode_number)}`,
  ].filter((n) => n !== null);
  return numbers.length === 0 ? show : `${show} · ${numbers.join(' ')}`;
}
