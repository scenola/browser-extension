/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Where one observation's sample goes (`routeOf`): to the bound viewing, with what its reading
// says or only what it says of the moment; to a viewing it binds; or nowhere. The rules are
// `IngestObservation`'s (index.ts says each); this is the decision alone, pure over plain data.

import { SEEK_ALLOWANCE_S, SEEK_SLACK } from '../../domain/coverage';
import type { PlaybackSample } from '../../domain/coverage';
import type { MergedReading, ViewingKey } from '../../domain/reading';
import {
  contradictsShowYear,
  joinTarget,
  mediaLength,
  momentOf,
  namesAnotherTitleId,
  sameTitleRefinement,
} from '../../domain/viewing';
import type { Viewing } from '../../domain/viewing';
import { continuesSitting } from './tab';

/** An element duration within this many seconds of the bound viewing's is that media's. */
const SAME_DURATION_S = 1;
/** Under this position a sample is a fresh start, never the end of the previous media. */
const FRESH_START_S = 60;

/** A reading that changes nothing about the viewing it is applied to. */
export const NOTHING: MergedReading = { sources: [] };
/** Only the end of the content: what an end screen says about the media it ends. */
const ENDED: MergedReading = { sources: [], contentEnded: true };

/** Where one observation's sample goes. */
export type Route =
  /** Nowhere: it binds nothing and belongs to nothing bound. */
  | { readonly kind: 'ignore' }
  /** It belongs to the bound viewing, which is closed: nothing to record. */
  | { readonly kind: 'keep' }
  /** It belongs to the bound viewing: applied with this reading. */
  | { readonly kind: 'apply'; readonly viewing: Viewing; readonly reading: MergedReading }
  /** A new identity has held still on its own media: join or start its viewing from here. */
  | { readonly kind: 'bind'; readonly key: ViewingKey };

const IGNORE: Route = { kind: 'ignore' };
const KEEP: Route = { kind: 'keep' };

export interface RouteInputs {
  readonly bound: Viewing | null;
  readonly last: PlaybackSample | null;
  /** The reading's key has held still: named by `STABLE_OBSERVATIONS` observations in a row. */
  readonly heldStill: boolean;
  readonly key: ViewingKey | null;
  readonly reading: MergedReading;
  readonly serviceId: string | null;
  readonly sample: PlaybackSample;
  readonly playing: boolean;
  /**
   * A muted sample may bind: the reading is an episode of the tab's viewing's show, on the
   * player heard with sound in this stretch of playback.
   */
  readonly mutedMayOpen: boolean;
  /** The sample's element plays other media than the tab's sitting (`fromOtherMedia`). */
  readonly otherMedia: boolean;
}

export function routeOf(o: RouteInputs): Route {
  const { bound, last, sample } = o;
  if (bound !== null && o.serviceId === bound.serviceId) {
    // Another title of the bound viewing's own service by that service's own id: another
    // identity whether or not the reading has a kind. Nothing of it is the bound
    // viewing's — no sample, no end, no name.
    const anotherId = namesAnotherTitleId(bound, o.reading, o.serviceId);
    const named = anotherId ? null : namedRoute(o, bound);
    if (named !== null) return named;
    // Another identity, on what may still be the bound media: nothing else starts from it, and
    // its samples are the bound viewing's — unless the reading names another title by the
    // service's own id, whose samples there are nobody's.
    if (sameMedia(bound, last, sample)) return anotherId ? IGNORE : onBoundMedia(o, bound);
  }
  // A sample seen on another service than the bound viewing's is never that viewing's, not
  // even on media of its length — it never joins, refines or ends a viewing: the tab left the
  // service, and what plays there is that service's. It may bind, as any other.
  return bindRoute(o);
}

/**
 * The route of a reading that may name the bound viewing (same service, no other title's id):
 * the viewing's, with the reading or only its moment; nowhere while undecided off the bound
 * media; `null` when it names another identity, decided below.
 */
function namedRoute(o: RouteInputs, bound: Viewing): Route | null {
  const { key, reading, last, sample } = o;
  const seen = mediaLength(sample, reading);
  // A show year the reading states and the viewing's contradicts: another show, even under
  // the viewing's own key — and a reading of nothing of its own never renames it.
  const otherShow = contradictsShowYear(bound, reading);
  // The reading names the tab's viewing — as its key does, more or less finely (a year or
  // the service's id gained or lost: the same title, whatever the pause, at the same
  // length), or nothing of its own; `null` while the length it shows cannot say.
  const names =
    key === null
      ? true
      : key === bound.key
        ? !otherShow
        : sameTitleRefinement(bound, reading, o.serviceId, seen);
  const closed = bound.state === 'reported' || bound.state === 'expired';
  // A closed viewing keeps its sitting while the playback runs on; a later sitting of the
  // same thing is a new viewing, bound like any other below.
  const keeps = !closed || key === null || continuesSitting(last, sample);
  if (!keeps || names === false) return null;
  // Undecided: nothing is re-keyed, split or bound on it. The bound media's own samples
  // still count; anything else goes nowhere until a length shows.
  if (names === null) return sameMedia(bound, last, sample) ? onBoundMedia(o, bound) : IGNORE;
  // A finer name re-keys the viewing only once it held still: one stray observation
  // naming another year must not rename the viewing for good. Until then the sample, and
  // what the reading says of the moment, are the viewing's.
  const target = joinTarget(bound, reading, o.serviceId, seen);
  const refines = target !== null && target.key !== bound.key;
  return toBound(o, bound, (refines && !o.heldStill) || otherShow ? momentOf(reading) : reading);
}

/**
 * The sample, and what `r` says, to the bound viewing — unless it plays other media than the
 * sitting's: then it is nobody's, adding no coverage and ending nothing. A closed viewing keeps
 * the sample without recording it.
 */
function toBound(o: RouteInputs, v: Viewing, r: MergedReading): Route {
  if (o.otherMedia) return IGNORE;
  return v.state === 'open' || v.state === 'skipped'
    ? { kind: 'apply', viewing: v, reading: r }
    : KEEP;
}

/**
 * While the element may still be on the bound media, that media's samples and its end are
 * the bound viewing's, and nothing else starts from them: a countdown names the next
 * episode while the last one plays out.
 */
function onBoundMedia(o: RouteInputs, v: Viewing): Route {
  if (o.reading.contentEnded === true) return toBound(o, v, ENDED);
  if (!o.playing || continuesPlayback(o.last, o.sample)) return toBound(o, v, NOTHING);
  return IGNORE;
}

/**
 * A new identity binds once it held still, from a playing player, never from an end screen. A
 * reading that names nothing starts nothing — nor one that names another title by its id
 * alone, which has no key.
 */
function bindRoute(o: RouteInputs): Route {
  const { key } = o;
  if (key === null || !o.playing || !o.heldStill) return IGNORE;
  if (o.reading.contentEnded === true) return IGNORE;
  // A muted element never starts a viewing nor binds a sitting to one: Chrome's
  // autoplay previews and header trailers play muted. A viewing started with sound keeps its
  // muted samples — they reach it above, never through a bind — and so does the next episode
  // that autoplays on the player heard with sound after the person muted it. A trailer that
  // has only ever been muted opens nothing; nor does one that follows sound in the same frame
  // (another page) — it names a film or another show, not the tab's show.
  if (o.sample.muted && !o.mutedMayOpen) return IGNORE;
  return { kind: 'bind', key };
}

/**
 * The element may still be on the bound viewing's media: moments after that viewing's last
 * sample, at the same length (within a second), past a fresh start. A new episode loading
 * (another length, or a start under 60 s) is never it.
 */
function sameMedia(bound: Viewing, last: PlaybackSample | null, s: PlaybackSample): boolean {
  if (last === null || s.duration === null || !continuesSitting(last, s)) return false;
  const length = bound.lastElementDuration ?? bound.elementDurationSeconds ?? bound.durationSeconds;
  return (
    length !== null &&
    Math.abs(s.duration - length) <= SAME_DURATION_S &&
    s.position >= FRESH_START_S
  );
}

/** The position moved on from the last sample as playback does, with no jump either way. */
function continuesPlayback(last: PlaybackSample | null, s: PlaybackSample): boolean {
  if (last === null) return false;
  const elapsed = (s.at - last.at) / 1000;
  const delta = s.position - last.position;
  return (
    delta >= -SEEK_ALLOWANCE_S &&
    delta <= Math.max(s.rate, 0) * elapsed * SEEK_SLACK + SEEK_ALLOWANCE_S
  );
}
