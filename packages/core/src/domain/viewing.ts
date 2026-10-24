/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { MAX_SAMPLE_GAP_S, PlayedRanges, SEEK_ALLOWANCE_S, SEEK_SLACK, advance } from './coverage';
import type { Interval, PlaybackSample } from './coverage';
import { READING_SOURCES, isMarker, titleKey, titleProviderId, viewingKey } from './reading';
import type { MergedReading, ViewingKey } from './reading';
import { normalizeTitle } from './titles';
import { DAY_MS } from './time';
import type { EpochMs } from './time';

/**
 * Where nothing says where the credits start, the story ends at
 * `duration − min(CREDITS_ESTIMATE_SHARE × duration, CREDITS_ESTIMATE_MAX_S)`: long end titles
 * must not stop a viewing from counting.
 */
export const CREDITS_ESTIMATE_SHARE = 0.12;
export const CREDITS_ESTIMATE_MAX_S = 20 * 60;
/**
 * A skipped intro, where nothing says where it ends: one forward seek that starts in the first
 * `INTRO_WITHIN_SHARE` of the content and spans at most
 * `min(INTRO_MAX_SHARE × duration, INTRO_MAX_S)`.
 */
export const INTRO_WITHIN_SHARE = 0.15;
export const INTRO_MAX_SHARE = 0.15;
export const INTRO_MAX_S = 20 * 60;
export const MIN_CONTENT_SECONDS = 120;
export const VIEWING_IDLE_MS = 7 * DAY_MS;
/** Share of the viewport a muted player must fill to count as watched on purpose. */
export const ENGAGED_AREA = 0.25;

export interface Viewing {
  readonly id: string;
  readonly key: ViewingKey;
  readonly serviceId: string | null;
  readonly reading: MergedReading;
  readonly ranges: readonly Interval[];
  /** The content's length: the service's statement when there is one, else the element's. */
  readonly durationSeconds: number | null;
  /**
   * The latest length a service module stated that is a content's (at least
   * `MIN_CONTENT_SECONDS`); it wins over the element's. A shorter statement is unknown, never
   * trusted: one bad statement must not make a viewing unreportable.
   */
  readonly statedDurationSeconds: number | null;
  /** The largest element duration that two consecutive samples agreed on. */
  readonly elementDurationSeconds: number | null;
  /** The previous sample's element duration, to see whether the next one agrees. */
  readonly lastElementDuration: number | null;
  /**
   * The latest valid credits start a service stated; absent in a viewing stored before it
   * existed, which reads as none.
   */
  readonly creditsStartSeconds?: number | null;
  /**
   * The position of the viewing's media at which the service's credits or post-play signal
   * (`contentEnded`) first appeared: the credits start where the service states none. Absent or `null`: not seen yet.
   */
  readonly creditsSignalSeconds?: number | null;
  /** The latest valid intro end a service stated; absent reads as none. */
  readonly introEndSeconds?: number | null;
  /**
   * The one skipped intro seen in this viewing: the forward seek's `[from, to]`,
   * kept with the viewing so a worker restart keeps it. Absent or `null`: none yet.
   */
  readonly skippedIntro?: Interval | null;
  readonly contentEnded: boolean;
  readonly firstSeenAt: EpochMs;
  readonly lastSampleAt: EpochMs;
  readonly incognito: boolean;
  readonly engaged: boolean;
  readonly state: 'open' | 'reported' | 'skipped' | 'expired';
  readonly reportedPlayId: string | null;
  /**
   * The id the viewing's start goes under, reserved before it is queued, so a worker that stops
   * between the two writes queues the same start again rather than a second one. Absent or
   * `null`: none yet.
   */
  readonly startPlayId?: string | null;
  /** When the viewing's start was queued: one start per viewing. Absent or `null`: not yet. */
  readonly startSentAt?: EpochMs | null;
  /**
   * The account it was recorded for, as `OutboxEntry.accountKey`: `null` or absent when none
   * was known.
   */
  readonly accountKey?: string | null;
}

const isUsableDuration = (d: number | null | undefined): d is number =>
  d !== null && d !== undefined && Number.isFinite(d) && d > 0;

/** The stretch of the content a viewing is measured over, in content seconds. */
export interface Story {
  /** The end of a skipped intro, else `0`. */
  readonly start: number;
  /** The start of the credits. */
  readonly end: number;
}

/** A marker as stored or stated, when it is a valid one (`isMarker`); else none. */
const markerOf = (x: number | null | undefined): number | null => (isMarker(x) ? x : null);

/**
 * Where the story ends: the credits start the service stated; else the position at which its
 * credits or post-play signal first appeared — each only while it lies in the
 * content's second half (one bad statement must not end a viewing at its first minute, nor
 * past its end); else the estimate `duration − min(12 % of it, 20 min)`.
 */
function creditsStartOf(v: Viewing, duration: number): number {
  for (const marker of [markerOf(v.creditsStartSeconds), markerOf(v.creditsSignalSeconds)]) {
    if (marker !== null && marker >= duration / 2 && marker <= duration) return marker;
  }
  return duration - Math.min(CREDITS_ESTIMATE_SHARE * duration, CREDITS_ESTIMATE_MAX_S);
}

/** A forward seek `from → to` that is a skipped intro of content `duration` seconds long. */
function isIntroSkip(from: number, to: number, duration: number): boolean {
  return (
    Number.isFinite(from) &&
    Number.isFinite(to) &&
    from >= 0 &&
    to > from &&
    from <= INTRO_WITHIN_SHARE * duration &&
    to - from <= Math.min(INTRO_MAX_SHARE * duration, INTRO_MAX_S)
  );
}

/** A stored skipped intro, when it is a pair of finite numbers; else none (storage is hostile). */
function skippedIntroOf(v: Viewing): Interval | null {
  // Read as stored, whatever its declared shape says.
  const skipped: unknown = v.skippedIntro;
  if (!Array.isArray(skipped) || skipped.length !== 2) return null;
  const [from, to] = skipped as readonly unknown[];
  return typeof from === 'number' &&
    typeof to === 'number' &&
    Number.isFinite(from) &&
    Number.isFinite(to)
    ? [from, to]
    : null;
}

/**
 * Where the story starts: the intro end the service stated, inside the first half and before
 * the credits; else the end of the viewing's one skipped intro; else the content's start.
 */
function introEndOf(v: Viewing, duration: number, end: number): number {
  const stated = markerOf(v.introEndSeconds);
  if (stated !== null && stated <= duration / 2 && stated < end) return stated;
  const skipped = skippedIntroOf(v);
  if (skipped !== null && isIntroSkip(skipped[0], skipped[1], duration) && skipped[1] < end) {
    return skipped[1];
  }
  return 0;
}

/**
 * The viewing's story: from the end of a skipped intro to the start of the
 * credits — a stretch of at least the content's second half less the credits, never empty.
 * `null` while the duration is unknown.
 */
export function storyOf(v: Viewing): Story | null {
  const duration = v.durationSeconds;
  if (!isUsableDuration(duration)) return null;
  const end = creditsStartOf(v, duration);
  return { start: introEndOf(v, duration, end), end };
}

/** The share of the story played, `0` to `1` whatever the ranges hold; `0` without a story. */
export function storyCoverage(v: Viewing): number {
  const story = storyOf(v);
  if (story === null) return 0;
  const covered = PlayedRanges.fromJSON(v.ranges).within(story.start, story.end);
  return Math.min(Math.max(covered / (story.end - story.start), 0), 1);
}

/**
 * The story's length as a report sends it: whole seconds, at least one; `null` while the
 * length is unknown, so nothing can be judged. Never more than the length rounded down, since
 * the story lies inside the content.
 */
export function storySeconds(v: Viewing): number | null {
  const story = storyOf(v);
  if (story === null) return null;
  const seconds = Math.floor(story.end - story.start);
  return Number.isFinite(seconds) && seconds >= 1 ? seconds : null;
}

/**
 * The seconds of the story played at least once, as a report sends them: whole seconds, never
 * more than `storySeconds`. Skipped time is not played, so a skip ahead adds nothing here.
 */
export function playedSeconds(v: Viewing): number {
  const story = storyOf(v);
  const length = storySeconds(v);
  if (story === null || length === null) return 0;
  const covered = Math.floor(PlayedRanges.fromJSON(v.ranges).within(story.start, story.end));
  return Math.min(Math.max(covered, 0), length);
}

/**
 * `percent` of `length` seconds, rounded up to a whole second: where a share line falls. The
 * server draws its lines the same way, from the same whole numbers a report sends.
 */
export const shareLine = (percent: number, length: number): number =>
  Math.ceil((percent * length) / 100);

/**
 * The skipped intro between two samples, or `null`: both playing and ad-free, a
 * gap of one stretch of playback, a forward jump larger than playback explains (what
 * `advance` refuses as a seek), and `isIntroSkip` of the duration.
 */
function introSkipBetween(
  previous: PlaybackSample | null,
  next: PlaybackSample,
  duration: number | null,
  adShowing: boolean,
): Interval | null {
  if (previous === null || !isUsableDuration(duration)) return null;
  if (previous.paused || next.paused || previous.adPlaying || adShowing) return null;
  const elapsed = (next.at - previous.at) / 1000;
  if (!(elapsed > 0 && elapsed <= MAX_SAMPLE_GAP_S)) return null;
  const jump = next.position - previous.position;
  if (!(jump > next.rate * elapsed * SEEK_SLACK + SEEK_ALLOWANCE_S)) return null;
  return isIntroSkip(previous.position, next.position, duration)
    ? [previous.position, next.position]
    : null;
}

/** The one constructor of a viewing: open, empty, keyed by its reading; `null` when unkeyed. */
export function newViewing(input: {
  readonly id: string;
  readonly serviceId: string | null;
  readonly reading: MergedReading;
  readonly at: EpochMs;
  readonly incognito: boolean;
}): Viewing | null {
  const key = viewingKey(input.serviceId, input.reading);
  if (key === null) return null;
  return {
    id: input.id,
    key,
    serviceId: input.serviceId,
    reading: input.reading,
    ranges: [],
    durationSeconds: null,
    statedDurationSeconds: null,
    elementDurationSeconds: null,
    lastElementDuration: null,
    contentEnded: false,
    firstSeenAt: input.at,
    lastSampleAt: input.at,
    incognito: input.incognito,
    engaged: false,
    state: 'open',
    reportedPlayId: null,
  };
}

/** The reading carried over the viewing's, or `null` when the result names another viewing. */
function carriedFor(v: Viewing, reading: MergedReading): MergedReading | null {
  const carried = carryReading(v.reading, reading);
  return viewingKey(v.serviceId, carried) === v.key ? carried : null;
}

/** Whether `applySample(v, …, reading)` would accept the reading (it throws when not). */
export function readingJoins(v: Viewing, reading: MergedReading): boolean {
  return carriedFor(v, reading) !== null;
}

/** Two lengths are one media's when they differ by at most the larger of this… */
export const SAME_LENGTH_FLOOR_S = 60;
/** …and this share of the longer of the two. */
export const SAME_LENGTH_SHARE = 0.02;

/**
 * `a` and `b` can be one media's length: they differ by at most
 * `max(SAME_LENGTH_FLOOR_S, SAME_LENGTH_SHARE × the longer)`.
 */
export const sameLength = (a: number, b: number): boolean =>
  Math.abs(a - b) <= Math.max(SAME_LENGTH_FLOOR_S, SAME_LENGTH_SHARE * Math.max(a, b));

/** The media's length as one observation shows it; `null` where it says nothing usable. */
export interface MediaLength {
  /** The service's statement (`contentDurationSeconds`). */
  readonly stated: number | null;
  /** The element's, while no ad is showing. */
  readonly element: number | null;
}

/**
 * A length that can be a content's: usable, and long enough to be content. Anything shorter
 * than `MIN_CONTENT_SECONDS` is an ad's (a pre-roll agreed on twice is one) or a clip's that
 * is never reported either way — so a refinement is never judged by it, and a service's
 * statement of it is no statement.
 */
const contentLength = (d: number | null | undefined): number | null =>
  isUsableDuration(d) && d >= MIN_CONTENT_SECONDS ? d : null;

/** What `sample` and `reading` say of the media's length. An ad's length is not the content's. */
export function mediaLength(sample: PlaybackSample, reading: MergedReading): MediaLength {
  const adShowing = sample.adPlaying || reading.adPlaying === true;
  return {
    stated: contentLength(reading.contentDurationSeconds),
    element: adShowing ? null : contentLength(sample.duration),
  };
}

/**
 * The sample's element plays media too short to be content: its length is known and under
 * `MIN_CONTENT_SECONDS`, and previews and ads are never reported. That is **ad time** — a
 * pre-roll or a mid-roll in its own element, a muted preview, a billboard trailer — and,
 * like the ad a module reports, it is nobody's: it adds no coverage, ends nothing and opens
 * nothing. Nothing that short is ever reported anyway (`too_short`), so nothing is lost.
 */
export function isAdTime(sample: PlaybackSample): boolean {
  const d = sample.duration;
  return isUsableDuration(d) && d < MIN_CONTENT_SECONDS;
}

/**
 * The sample's element plays `v`'s own media: its length is a content's and is
 * one media's (`sameLength`) with the length `v` already knew of its media before this sample —
 * the element's, which two samples agreed on, else the service's statement. A viewing that
 * knows neither has nothing to vouch for the element with, so it does not.
 *
 * This is what lets an element's `ended` end a viewing. It never lapses, unlike the sitting's
 * length (`fromOtherMedia`): a wrong end makes the play say the title played out, which the
 * server counts whatever was played, while a missed one costs nothing — the play is still
 * judged by the story seconds played.
 */
function playsViewingMedia(v: Viewing, sample: PlaybackSample): boolean {
  const seen = contentLength(sample.duration);
  const own = contentLength(v.elementDurationSeconds) ?? contentLength(v.statedDurationSeconds);
  return seen !== null && own !== null && sameLength(own, seen);
}

/**
 * `bound`'s media and the media `seen` shows can be one: their lengths differ by at most
 * `max(SAME_LENGTH_FLOOR_S, SAME_LENGTH_SHARE × the longer)`. Like is compared with like —
 * two statements, else two element lengths (a stitched stream's element runs longer than
 * the content it states), else whatever each side has.
 *
 * `null` while the seen length is unknown (an ad showing, a pre-roll, a stream that reports
 * none): no verdict yet — what the observation shows cannot confirm the bound media, so
 * nothing may be decided on it. A bound length that is unknown agrees: the viewing has none
 * to object with, and the observation's own length is what it will keep.
 */
export function lengthsAgree(bound: Viewing, seen: MediaLength): boolean | null {
  const [a, b] = comparableLengths(bound, seen);
  if (b === null) return null;
  if (a === null) return true;
  return sameLength(a, b);
}

function comparableLengths(
  bound: Viewing,
  seen: MediaLength,
): readonly [number | null, number | null] {
  const stated = contentLength(bound.statedDurationSeconds);
  const element = contentLength(bound.elementDurationSeconds);
  const seenStated = contentLength(seen.stated);
  const seenElement = contentLength(seen.element);
  if (stated !== null && seenStated !== null) return [stated, seenStated];
  if (element !== null && seenElement !== null) return [element, seenElement];
  return [stated ?? element, seenStated ?? seenElement];
}

/** Both sides state the value and the two are not the same. */
const disagree = <T>(a: T | undefined, b: T | undefined): boolean =>
  a !== undefined && b !== undefined && a !== b;

/**
 * `a` and `b`, as seen on `serviceId`, are two shows by the years they state: both state a show
 * year and the two differ, under a key that names no id of the service's. An
 * episode's descriptive key (`ep:<show>:<season>:<episode>`) holds no year, so the key alone
 * cannot tell two shows of one title apart (a remake); this does. A title the service keys by
 * its own id is that id's, whatever the years say: the id is the identity.
 */
export function showYearsSplit(
  serviceId: string | null,
  a: MergedReading,
  b: MergedReading,
): boolean {
  const idKeyed = serviceId !== null && titleProviderId(a) !== undefined;
  return !idKeyed && disagree(a.showYear, b.showYear);
}

/** `reading` names another show than `bound`'s by its stated year (`showYearsSplit`). */
export const contradictsShowYear = (bound: Viewing, reading: MergedReading): boolean =>
  showYearsSplit(bound.serviceId, bound.reading, reading);

/**
 * `reading`, seen on `serviceId`, names another title than `bound`'s by that service's own
 * title-level id: both state one and the two differ. That is another identity
 * **whether or not the reading has a kind** — its samples are never `bound`'s, not even on
 * what may still be `bound`'s media, and without a kind it opens nothing. Only an id of
 * `bound`'s own service counts: another service is another identity anyway, and a site
 * without a module keys nothing by an id.
 */
export function namesAnotherTitleId(
  bound: Viewing,
  reading: MergedReading,
  serviceId: string | null,
): boolean {
  return (
    serviceId !== null &&
    serviceId === bound.serviceId &&
    disagree(titleProviderId(bound.reading), titleProviderId(reading))
  );
}

const showProviderId = (r: MergedReading): string | undefined =>
  r.providerIds?.find((p) => p.level === 'show')?.value;

const showName = (r: MergedReading): string =>
  r.showTitle === undefined ? '' : normalizeTitle(r.showTitle);

/**
 * `reading`, seen on `serviceId`, is an episode of `bound`'s show on `bound`'s service — what
 * an autoplay moves on to. Both are episodes; the service's show-level ids decide
 * when both state one, else the normalised show titles, which must both be there; two show
 * years that disagree are two shows. Total: whatever it cannot tell is `false`.
 */
export function sameShowOnService(
  bound: Viewing,
  reading: MergedReading,
  serviceId: string | null,
): boolean {
  const a = bound.reading;
  if (serviceId !== bound.serviceId || a.kind !== 'episode' || reading.kind !== 'episode') {
    return false;
  }
  if (disagree(a.showYear, reading.showYear)) return false;
  // An id names a show only under a service: a site without a module keys nothing by one.
  const boundShow = serviceId === null ? undefined : showProviderId(a);
  const seenShow = serviceId === null ? undefined : showProviderId(reading);
  if (boundShow !== undefined && seenShow !== undefined) return boundShow === seenShow;
  const show = showName(a);
  return show !== '' && show === showName(reading);
}

/**
 * Whether `reading` — as seen on `serviceId`, on media of length `seen` — names `bound`'s
 * title, as finely or more or less so. Total: every input is one of three answers.
 *
 * - `false` when the reading was seen on **another service** than `bound`'s, ids or none — a
 *   site without a module (`null`) counts as a service of its own, so two such sites may
 *   share a viewing but a module's viewing and a generic one never do. A person moving one
 *   episode between services inside a week gets two partial viewings; that split costs less
 *   than two titles taken for one.
 * - `true` when its key is `bound`'s own, **without asking the lengths**: the key is the
 *   identity, and a new sitting of an equal key joins whatever its media's length (a
 *   yearless title has nothing else to tell two films apart by). A caller asks
 *   this about an unequal key; the equal one answers as ingest would.
 * - `true` also for a refinement whose lengths agree: the same kind and the same title
 *   (`titleKey`), the two keys differing at most by a component one side lacks — a film's
 *   year, or the service's own title id.
 * - `false` for another title, decided by the names alone: another kind or title, two years
 *   (a film's, or a show's) or two ids that disagree — or by lengths that disagree
 *   (`lengthsAgree`: a remake on a yearless page is another film).
 * - `null` when the names say "the same title" and the seen length is unknown: a refinement
 *   is decided only on a length the observation shows. Nothing is decided on it — no join,
 *   no re-key, no split — until one shows.
 */
export function sameTitleRefinement(
  bound: Viewing,
  reading: MergedReading,
  serviceId: string | null,
  seen: MediaLength,
): boolean | null {
  if (serviceId !== bound.serviceId) return false;
  if (viewingKey(serviceId, reading) === bound.key) return true;
  const a = bound.reading;
  if (a.kind === undefined || a.kind !== reading.kind) return false;
  const title = titleKey(a);
  if (title === null || title !== titleKey(reading)) return false;
  if (a.kind === 'movie' && disagree(a.year, reading.year)) return false;
  if (disagree(a.showYear, reading.showYear)) return false;
  // An id names a title only under a service: a site without a module keys nothing by one.
  if (namesAnotherTitleId(bound, reading, serviceId)) return false;
  return lengthsAgree(bound, seen);
}

/**
 * The viewing `reading` is applied to: `v` itself when the reading joins as it is (its own
 * key, none of its own, or a coarser one — the carry restores what it lacks), `v` re-keyed
 * to the finer key when the reading refines its title (it keeps its id, ranges and
 * everything else), or `null` when it does not name `v`'s title — a reading seen on another
 * service, another title, or one not decided yet (`sameTitleRefinement` is `null`). A
 * reading whose own key is not `v`'s must be `sameTitleRefinement` of it, lengths included,
 * whichever way it differs: the carry alone would hand an older film's yearless page the
 * remake's year, or another episode the viewing's title id.
 */
export function joinTarget(
  v: Viewing,
  reading: MergedReading,
  serviceId: string | null,
  seen: MediaLength,
): Viewing | null {
  // A reading of nothing of its own (no kind) is judged by no key: its service still decides.
  if (serviceId !== v.serviceId) return null;
  const named = viewingKey(serviceId, reading);
  const differs = named !== null && named !== v.key;
  if (differs && sameTitleRefinement(v, reading, serviceId, seen) !== true) return null;
  if (readingJoins(v, reading)) return v;
  if (!differs) return null;
  const key = viewingKey(v.serviceId, carryReading(v.reading, reading));
  return key === null ? null : { ...v, key };
}

export function applySample(
  v: Viewing,
  previous: PlaybackSample | null,
  next: PlaybackSample,
  reading: MergedReading,
): Viewing {
  const carried = carriedFor(v, reading);
  if (carried === null) {
    throw new RangeError('applySample: the reading belongs to another viewing');
  }
  // The ad guard: ad time is not the content's. An ad the module's reading reports — Apple TV's
  // header promo — adds no coverage, as one the sample flags never did (`advance`), and an ended
  // ad is not the content ending (below). So is media too short to be content (`isAdTime`),
  // whoever plays it.
  const adShowing = next.adPlaying || reading.adPlaying === true || isAdTime(next);
  const before = PlayedRanges.fromJSON(v.ranges);
  const ranges = (adShowing ? before : advance(before, previous, next)).toJSON();
  const lengths = lengthsAfter(v, next, reading);
  // The element's `ended` is the content's end only when that element plays this viewing's
  // media; the service's own end signal stands as the service says it.
  const elementEnded = next.ended && !adShowing && playsViewingMedia(v, next);
  const contentEnded = v.contentEnded || elementEnded || reading.contentEnded === true;
  // One skipped intro per viewing: the first forward seek that is one, kept from then on.
  const skippedIntro =
    skippedIntroOf(v) ?? introSkipBetween(previous, next, lengths.durationSeconds, adShowing);

  return {
    ...v,
    reading: carried,
    ranges,
    ...lengths,
    ...markersAfter(v, next, reading, adShowing),
    skippedIntro,
    contentEnded,
    engaged: v.engaged || !next.muted || next.visibleArea >= ENGAGED_AREA,
    lastSampleAt: next.at,
  };
}

/** The viewing's lengths after a sample: the stated one, the element's, and the one it uses. */
function lengthsAfter(
  v: Viewing,
  next: PlaybackSample,
  reading: MergedReading,
): Pick<
  Viewing,
  'durationSeconds' | 'statedDurationSeconds' | 'elementDurationSeconds' | 'lastElementDuration'
> {
  // A statement shorter than content's is unknown: it keeps the last good one and
  // never overrides the element's length. A stored one is held to the same rule.
  const stated =
    contentLength(reading.contentDurationSeconds) ?? contentLength(v.statedDurationSeconds);
  // An element duration counts only once two consecutive samples agree on it, so the
  // previous episode's length (autoplay) or an ad's never enters the maximum; nor does media
  // too short to be content.
  const current = isUsableDuration(next.duration) && !isAdTime(next) ? next.duration : null;
  let element = v.elementDurationSeconds;
  if (current !== null && current === v.lastElementDuration) {
    element = element === null ? current : Math.max(element, current);
  }
  return {
    durationSeconds: stated ?? element,
    statedDurationSeconds: stated,
    elementDurationSeconds: element,
    lastElementDuration: current,
  };
}

/**
 * The service's markers after a sample: the latest valid statement stands, and a reading
 * without one keeps it, as the stated length does. A stored one is held to the same bounds.
 */
function markersAfter(
  v: Viewing,
  next: PlaybackSample,
  reading: MergedReading,
  adShowing: boolean,
): Pick<Viewing, 'creditsStartSeconds' | 'creditsSignalSeconds' | 'introEndSeconds'> {
  return {
    creditsStartSeconds: markerOf(reading.creditsStartSeconds) ?? markerOf(v.creditsStartSeconds),
    // Where the service's credits or post-play signal first appeared: kept from then on. An ad's
    // position is not the content's.
    creditsSignalSeconds:
      markerOf(v.creditsSignalSeconds) ??
      (reading.contentEnded === true && !adShowing ? markerOf(next.position) : null),
    introEndSeconds: markerOf(reading.introEndSeconds) ?? markerOf(v.introEndSeconds),
  };
}

/** The fields of a reading that say something of the moment, not of the item. */
const MOMENT_KEYS = [
  'contentEnded',
  'adPlaying',
  'contentDurationSeconds',
  'creditsStartSeconds',
  'introEndSeconds',
] as const satisfies readonly (keyof MergedReading)[];

type MomentKey = (typeof MOMENT_KEYS)[number];

/** What a later reading never carries over from an earlier one: the moment, and the sources. */
const TRANSIENT_READING_KEYS: ReadonlySet<keyof MergedReading> = new Set([
  ...MOMENT_KEYS,
  'sources',
]);

/**
 * What `reading` says of the moment only — the content ended, an ad is showing, the stated
 * length, the credits and intro markers — and nothing of what it names: applied to a viewing,
 * it records the sample and those signals and leaves the viewing's identity as it is.
 */
export function momentOf(reading: MergedReading): MergedReading {
  const moment: Partial<Record<MomentKey, unknown>> = {};
  for (const key of MOMENT_KEYS) {
    if (reading[key] !== undefined) moment[key] = reading[key];
  }
  return { ...(moment as Pick<MergedReading, MomentKey>), sources: [] };
}

/**
 * The new reading's values win per field; a field the new reading lacks keeps its earlier value
 * (the finishing screen may have lost the episode title, a show's year or the stated ids).
 * Moment-bound signals do not carry. The caller checks the result still names the same viewing.
 */
function carryReading(earlier: MergedReading, latest: MergedReading): MergedReading {
  const stable = Object.fromEntries(
    Object.entries(earlier).filter(
      ([key]) => !TRANSIENT_READING_KEYS.has(key as keyof MergedReading),
    ),
  );
  const sources = READING_SOURCES.filter(
    (s) => earlier.sources.includes(s) || latest.sources.includes(s),
  );
  return { ...stable, ...latest, sources };
}

export type ReportVerdict =
  | { readonly kind: 'report'; readonly watchedAt: EpochMs }
  | { readonly kind: 'wait' }
  | {
      readonly kind: 'never';
      readonly reason: 'too_short' | 'not_identified' | 'skipped' | 'already_reported';
    };

/**
 * Whether the viewing is a play to send now: the story seconds played have reached the account's
 * finish line — `finishPercent` of the story, the line in force at this moment — wherever in
 * the story that happens. The line alone decides: the person who chose 50 % expects the viewing
 * added once half of the story has played, not at its credits. The play goes in the observation
 * that reaches the line, so its moment is that observation's sample, and a reported viewing
 * never reports again, however much more of it plays.
 *
 * A closed viewing never reports (an expired one was dropped, so it answers `skipped`); a
 * duration that is unknown or unusable waits, since without a story there is no line. A viewing
 * short of the line waits however far its position got, a skim to the credits included: it
 * stays open, and expires unreported after `VIEWING_IDLE_MS` unless more of it is played. The
 * server draws the same line from the same numbers, so a play sent here is one it counts.
 */
export function reportVerdict(v: Viewing, finishPercent: number): ReportVerdict {
  if (v.state === 'reported') return { kind: 'never', reason: 'already_reported' };
  if (v.state === 'skipped' || v.state === 'expired') return { kind: 'never', reason: 'skipped' };
  if (viewingKey(v.serviceId, v.reading) === null)
    return { kind: 'never', reason: 'not_identified' };
  if (!isUsableDuration(v.durationSeconds)) return { kind: 'wait' };
  if (v.durationSeconds < MIN_CONTENT_SECONDS) return { kind: 'never', reason: 'too_short' };
  if (!v.engaged) return { kind: 'wait' };
  const story = storySeconds(v);
  // Fails closed: a line that is not a number (a caller that forgot it) records nothing.
  if (story === null || !(playedSeconds(v) >= shareLine(finishPercent, story))) {
    return { kind: 'wait' };
  }
  return { kind: 'report', watchedAt: v.lastSampleAt };
}
