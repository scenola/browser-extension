/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { DAY_MS } from './time';
import { normalizeTitle } from './titles';

/**
 * Where a reading came from, in tie-break order: earlier wins at equal confidence. `address` is
 * the page's address, the least trusted.
 */
export const READING_SOURCES = [
  'module',
  'json-ld',
  'media-session',
  'open-graph',
  'document-title',
  'address',
] as const;
export type ReadingSource = (typeof READING_SOURCES)[number];

export interface Field<T> {
  readonly value: T;
  readonly confidence: number;
  readonly source: ReadingSource;
}

export interface ProviderId {
  /** `title` is the film's or the episode's own id; `show` is the series'. */
  readonly level: 'title' | 'show';
  readonly key: string;
  readonly value: string;
}

export interface StatedIds {
  readonly tmdb?: number;
  readonly imdb?: string;
}

export interface ServiceReading {
  readonly kind?: Field<'movie' | 'episode'>;
  readonly title?: Field<string>;
  readonly showTitle?: Field<string>;
  readonly episodeTitle?: Field<string>;
  readonly season?: Field<number>;
  readonly episode?: Field<number>;
  readonly year?: Field<number>;
  readonly showYear?: Field<number>;
  readonly ids?: Field<StatedIds>;
  readonly showIds?: Field<StatedIds>;
  readonly providerIds?: readonly ProviderId[];
  readonly contentEnded?: boolean;
  readonly adPlaying?: boolean;
  readonly contentDurationSeconds?: number;
  /**
   * Where the service says the end credits start, in content seconds (Netflix's
   * `creditsOffset`, for one). The story ends there. Bounded at the merge: finite, `0` to a week.
   */
  readonly creditsStartSeconds?: number;
  /**
   * Where the service says the intro ends, in content seconds: the story starts there. No module states one yet. Bounded like `creditsStartSeconds`.
   */
  readonly introEndSeconds?: number;
}

export interface MergedReading {
  readonly kind?: 'movie' | 'episode';
  readonly title?: string;
  readonly showTitle?: string;
  readonly episodeTitle?: string;
  readonly season?: number;
  readonly episode?: number;
  readonly year?: number;
  readonly showYear?: number;
  readonly ids?: StatedIds;
  readonly showIds?: StatedIds;
  readonly providerIds?: readonly ProviderId[];
  readonly contentEnded?: boolean;
  readonly adPlaying?: boolean;
  readonly contentDurationSeconds?: number;
  /** A valid `ServiceReading.creditsStartSeconds`: finite, `0` to `MAX_MARKER_SECONDS`. */
  readonly creditsStartSeconds?: number;
  /** A valid `ServiceReading.introEndSeconds`: finite, `0` to `MAX_MARKER_SECONDS`. */
  readonly introEndSeconds?: number;
  /** The distinct sources that supplied a field, in `READING_SOURCES` order. */
  readonly sources: readonly ReadingSource[];
}

/** The largest position a marker may name: a week, as `MAX_SECONDS` bounds a duration. */
export const MAX_MARKER_SECONDS = (7 * DAY_MS) / 1000;

/** A position a credits or intro marker may name: finite, `0` to `MAX_MARKER_SECONDS`. */
export const isMarker = (x: unknown): x is number =>
  typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= MAX_MARKER_SECONDS;

/**
 * The fields of a reading that say **which item** plays, each a `Field`: one list, spelled
 * once. `mergeReadings` takes them from a module alone once it answered, the worker keeps them
 * while the player's controls are hidden (`identityOf`), and the interpreter
 * stamps their source. A type test (`reading.test-d.ts`) holds it to every `Field`-wrapped key
 * of `ServiceReading`, and to nothing else. The provider ids are identity too; they are a list,
 * not a `Field`, and are handled beside it.
 */
export const IDENTITY_FIELDS = [
  'kind',
  'title',
  'showTitle',
  'episodeTitle',
  'season',
  'episode',
  'year',
  'showYear',
  'ids',
  'showIds',
] as const satisfies readonly (keyof ServiceReading)[];

export type IdentityField = (typeof IDENTITY_FIELDS)[number];

/** The fields of `r` that say which item plays (`IDENTITY_FIELDS`), and nothing else. */
export function identityOf(r: ServiceReading): ServiceReading {
  const identity: Partial<Record<IdentityField, unknown>> = {};
  for (const key of IDENTITY_FIELDS) {
    if (r[key] !== undefined) identity[key] = r[key];
  }
  return identity as ServiceReading;
}

const sourceRank = (s: ReadingSource): number => READING_SOURCES.indexOf(s);

/**
 * The module's field if it has one; else the most confident one of `generic`, ties by source
 * order. `mergeReadings` passes no generic readings for an identity field once the module
 * answered.
 */
function pick<K extends IdentityField>(
  key: K,
  module: ServiceReading | null,
  generic: readonly ServiceReading[],
): NonNullable<ServiceReading[K]> | undefined {
  const own = module?.[key] as NonNullable<ServiceReading[K]> | undefined;
  if (own !== undefined) return own;
  let best: NonNullable<ServiceReading[K]> | undefined;
  for (const reading of generic) {
    const candidate = reading[key] as NonNullable<ServiceReading[K]> | undefined;
    if (candidate === undefined) continue;
    if (
      best === undefined ||
      candidate.confidence > best.confidence ||
      (candidate.confidence === best.confidence &&
        sourceRank(candidate.source) < sourceRank(best.source))
    ) {
      best = candidate;
    }
  }
  return best;
}

/** A plain (unwrapped) field: the module's, else the first generic reading that has it. */
function plain<K extends 'contentEnded' | 'adPlaying' | 'contentDurationSeconds'>(
  key: K,
  module: ServiceReading | null,
  generic: readonly ServiceReading[],
): ServiceReading[K] | undefined {
  const own = module?.[key];
  if (own !== undefined) return own;
  for (const reading of generic) {
    const value = reading[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * A credits or intro marker: the module's when it states a valid one, else the first generic
 * reading's valid one. An invalid value is no statement — not a throw, not a clamp.
 */
function marker(
  key: 'creditsStartSeconds' | 'introEndSeconds',
  module: ServiceReading | null,
  generic: readonly ServiceReading[],
): number | undefined {
  const own = module?.[key];
  if (isMarker(own)) return own;
  for (const reading of generic) {
    const value = reading[key];
    if (isMarker(value)) return value;
  }
  return undefined;
}

function pickProviderIds(
  module: ServiceReading | null,
  generic: readonly ServiceReading[],
): readonly ProviderId[] | undefined {
  if (module?.providerIds !== undefined && module.providerIds.length > 0) return module.providerIds;
  const seen = new Set<string>();
  const out: ProviderId[] = [];
  for (const reading of generic) {
    for (const id of reading.providerIds ?? []) {
      const seenKey = `${id.level}\u0000${id.key}\u0000${id.value}`;
      if (seen.has(seenKey)) continue;
      seen.add(seenKey);
      out.push(id);
    }
  }
  return out.length > 0 ? out : undefined;
}

const NO_READINGS: readonly ServiceReading[] = [];

/**
 * One reading from the service module's and the generic readers', field by field.
 *
 * **A module that answered decides the identity**: when `module` is a reading, not
 * `null`, every field that says *which item* plays — the kind, the titles, the numbers, the
 * years, the stated ids, the provider ids — and the length it states for that item come from
 * it alone, and a field it leaves out stays out. The generic readers fill none of them: a
 * page's JSON-LD left from before an in-app navigation is about the previous item and would
 * give episode 2 the numbers of episode 1. They serve a site without a module and a module
 * that answers `null`. What a reading says of the moment — the content ended, an ad shows —
 * names no item and still flows: the module's when it states it, else the first generic
 * reading's.
 */
export function mergeReadings(
  module: ServiceReading | null,
  generic: readonly ServiceReading[],
): MergedReading {
  // The generic readings that may say which item plays: none once the module answered.
  const naming = module === null ? generic : NO_READINGS;
  // Every identity field from one list (`IDENTITY_FIELDS`); the type test holds the result to
  // `MergedReading`'s own fields.
  const identity: Partial<Record<IdentityField, unknown>> = {};
  const used = new Set<ReadingSource>();
  for (const key of IDENTITY_FIELDS) {
    const f = pick(key, module, naming);
    if (f === undefined) continue;
    identity[key] = f.value;
    used.add(f.source);
  }
  const providerIds = pickProviderIds(module, naming);
  const contentEnded = plain('contentEnded', module, generic);
  const adPlaying = plain('adPlaying', module, generic);
  // A stated length is a statement about one item, so it follows the identity's source; so do
  // the credits and intro markers.
  const contentDurationSeconds = plain('contentDurationSeconds', module, naming);
  const creditsStartSeconds = marker('creditsStartSeconds', module, naming);
  const introEndSeconds = marker('introEndSeconds', module, naming);

  const sources = READING_SOURCES.filter((s) => used.has(s));

  return {
    ...(identity as Pick<MergedReading, IdentityField>),
    ...(providerIds !== undefined ? { providerIds } : {}),
    ...(contentEnded !== undefined ? { contentEnded } : {}),
    ...(adPlaying !== undefined ? { adPlaying } : {}),
    ...(contentDurationSeconds !== undefined ? { contentDurationSeconds } : {}),
    ...(creditsStartSeconds !== undefined ? { creditsStartSeconds } : {}),
    ...(introEndSeconds !== undefined ? { introEndSeconds } : {}),
    sources,
  };
}

/** Identifies one watching of one thing across sittings. */
export type ViewingKey = string;

/**
 * The service's own id of the title (the first title-level one), the `svc:` key's component —
 * of a merged reading or of a module's own (a frame's identity is kept while two of those agree).
 */
export function titleProviderId(r: {
  readonly providerIds?: readonly ProviderId[] | undefined;
}): string | undefined {
  return r.providerIds?.find((p) => p.level === 'title')?.value;
}

/**
 * What every key of one title shares: `ep:<show>:<season>:<episode>` for an episode,
 * `mv:<title>` for a film — no year, no service id. `null` without those fields.
 */
export function titleKey(r: MergedReading): string | null {
  if (r.kind === 'episode') {
    if (r.showTitle === undefined || r.season === undefined || r.episode === undefined) return null;
    const show = normalizeTitle(r.showTitle);
    return show === '' ? null : `ep:${show}:${String(r.season)}:${String(r.episode)}`;
  }
  if (r.kind === 'movie') {
    if (r.title === undefined) return null;
    const title = normalizeTitle(r.title);
    return title === '' ? null : `mv:${title}`;
  }
  return null;
}

/**
 * One watching of one thing **on one service**: `svc:<service>:<title-level provider value>`
 * when the service names the title; else the title's own key — `ep:<show>:<season>:<episode>`
 * for an episode, `mv:<title>:<year>` for a film — under `<service>/` when a service module
 * read it, and bare on a site without one (`serviceId` `null`, a service of its own). Two
 * services never share a key, so a viewing never gathers another service's sittings.
 * `null` without a kind or without anything that identifies it.
 */
export function viewingKey(serviceId: string | null, r: MergedReading): ViewingKey | null {
  if (r.kind === undefined) return null;
  const own = titleProviderId(r);
  if (serviceId !== null && own !== undefined) return `svc:${serviceId}:${own}`;
  const title = titleKey(r);
  if (title === null) return null;
  const key = r.kind === 'movie' ? `${title}:${r.year === undefined ? '' : String(r.year)}` : title;
  return serviceId === null ? key : `${serviceId}/${key}`;
}
