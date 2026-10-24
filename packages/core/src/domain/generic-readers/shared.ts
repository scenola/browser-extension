/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { clampTitle, isYear } from '../play';
import type { Field, ReadingSource, ServiceReading } from '../reading';

/**
 * Confidence by trust: the page's structured data, the player's metadata, the share card, the tab
 * title, the address (the least trusted).
 */
const CONFIDENCE = {
  'json-ld': 0.8,
  'media-session': 0.7,
  'open-graph': 0.6,
  'document-title': 0.4,
  address: 0.3,
} as const;

type GenericSource = keyof typeof CONFIDENCE;

export const field = <T>(source: GenericSource, value: T): Field<T> => ({
  value,
  confidence: CONFIDENCE[source],
  source: source satisfies ReadingSource,
});

export const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/** The members of an array, `[]` for anything else. */
export const asArray = (x: unknown): readonly unknown[] =>
  Array.isArray(x) ? (x as unknown[]) : [];

/** The longest string a reader takes from a page. */
const MAX_TEXT_CHARS = 500;

/** A non-blank string, trimmed and cut at `MAX_TEXT_CHARS`; anything else is nothing. */
export function text(x: unknown): string | undefined {
  if (typeof x !== 'string') return undefined;
  const trimmed = x.slice(0, MAX_TEXT_CHARS).trim();
  return trimmed === '' ? undefined : trimmed;
}

/** A calendar year from a leading `YYYY` of a date string (or a bare number), within `isYear`. */
export function yearOf(x: unknown): number | undefined {
  const raw = typeof x === 'number' ? String(x) : text(x);
  if (raw === undefined) return undefined;
  const match = /^(\d{4})(?!\d)/u.exec(raw);
  if (match?.[1] === undefined) return undefined;
  const year = Number(match[1]);
  return isYear(year) ? year : undefined;
}

/**
 * A title as the wire takes it: a page string, trimmed and cut to
 * `MAX_TITLE_CODE_POINTS` code points — the cut `buildPlay` makes, so the viewing a reading
 * keys is the one its play names. Anything else is nothing.
 */
export const titleText = (x: unknown): string | undefined => clampTitle(text(x));

/** A name and the trailing ` (YYYY)` within the wire's years it ends with, if any. */
function dated(raw: string): { readonly name: string; readonly year?: number } {
  const match = /^(.*\S)\s+\((\d{4})\)$/u.exec(raw);
  const year = Number(match?.[2]);
  return match?.[1] !== undefined && isYear(year) ? { name: match[1], year } : { name: raw };
}

/**
 * A film's or a show's title as a page writes it — never an episode's: a trailing
 * ` (YYYY)` within the wire's years is its year, not its name; two names joined by one spaced
 * slash (`Local name / Original name`) are the first, which the page leads with. Several spaced
 * slashes, or an unspaced one (`Fate/Zero`), are part of the name. The year is read off the whole
 * text, and off the first of two names too (`Local (2020) / Original (2020)`), as one year: two
 * different years are no year, since neither can be told for the work's. The name is then cut as
 * `titleText` cuts it. The one reading of a work's title: every generic reader that takes one
 * calls this.
 */
export function workTitle(
  x: unknown,
): { readonly name: string; readonly year?: number } | undefined {
  const raw = text(x);
  if (raw === undefined) return undefined;
  const whole = dated(raw);
  const names = whole.name.split(/\s+\/\s+/u);
  const first = names.length === 2 && names[0] !== undefined ? dated(names[0]) : undefined;
  const years = new Set([whole.year, first?.year].filter((y) => y !== undefined));
  const name = clampTitle((first ?? whole).name);
  if (name === undefined) return undefined;
  const [year, ...others] = years;
  return year !== undefined && others.length === 0 ? { name, year } : { name };
}

/**
 * The fields of a work's title (`workTitle`): its name under `keys[0]`, and under `keys[1]` the
 * year the reader states (`stated`) or else the one the title carries.
 */
export function workFields(
  src: GenericSource,
  x: unknown,
  keys: readonly ['title', 'year'] | readonly ['showTitle', 'showYear'],
  stated?: number,
): ServiceReading {
  const work = workTitle(x);
  const year = stated ?? work?.year;
  return {
    ...(work === undefined ? {} : { [keys[0]]: field(src, work.name) }),
    ...(year === undefined ? {} : { [keys[1]]: field(src, year) }),
  };
}

/** A positive whole number, from a number or a digit string. */
function positiveInt(x: unknown): number | undefined {
  const n =
    typeof x === 'number'
      ? x
      : typeof x === 'string' && /^\s*\d{1,5}\s*$/u.test(x)
        ? Number(x)
        : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * A positive whole number the wire can carry: `positiveInt`, at most `max`
 * (`SEASON_NUMBER_MAX`, `EPISODE_NUMBER_MAX`). A larger one is no number — never capped, which
 * would invent one.
 */
export function boundedInt(x: unknown, max: number): number | undefined {
  const n = positiveInt(x);
  return n !== undefined && n <= max ? n : undefined;
}

/** The reading, or `null` when no field was read. */
export function orNull(reading: ServiceReading): ServiceReading | null {
  return Object.keys(reading).length === 0 ? null : reading;
}
