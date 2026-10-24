/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Times, dates and durations as the pages show them: through `Intl`, in the words' locale
// (`uiLocale()`), never formatted by hand. And the two moments the pause menu offers,
// computed in the person's own time zone.

import { HOUR_MS, isIndefinitePause } from '@mt/core';
import { browser } from 'wxt/browser';

import { uiLocale } from '../i18n/t';

/**
 * The locale dates are formatted in: the browser's own tag when it is a variant of the words'
 * language (`en-GB` beside the English catalog keeps a 24-hour clock and day-first dates), else
 * the words' locale, so a date is never in another language than the sentence around it.
 */
function intlLocale(): string {
  const words = uiLocale();
  let browserTag = '';
  try {
    browserTag = browser.i18n.getUILanguage();
  } catch {
    browserTag = typeof navigator === 'undefined' ? '' : navigator.language;
  }
  const language = (tag: string): string => tag.toLowerCase().split(/[-_]/u)[0] ?? '';
  if (browserTag === '' || language(browserTag) !== language(words)) return words;
  try {
    return Intl.getCanonicalLocales(browserTag.replace(/_/gu, '-'))[0] ?? words;
  } catch {
    return words;
  }
}

const formats = new Map<string, Intl.DateTimeFormat>();

function format(options: Intl.DateTimeFormatOptions, key: string): Intl.DateTimeFormat {
  let found = formats.get(key);
  if (found === undefined) {
    found = new Intl.DateTimeFormat(intlLocale(), options);
    formats.set(key, found);
  }
  return found;
}

/** Whether two instants fall on the same local calendar day. */
export function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

/** A finite instant a `Date` can hold; anything else is not a time to show. */
function isShowable(at: number): boolean {
  return Number.isFinite(at) && !Number.isNaN(new Date(at).getTime());
}

/** `21:40` today, `20 Oct` another day this year, `20 Oct 2025` another year. */
export function shortMoment(at: number, now: number): string {
  if (!isShowable(at)) return '';
  if (sameDay(at, now)) return format({ timeStyle: 'short' }, 'time').format(at);
  const thisYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return thisYear
    ? format({ day: 'numeric', month: 'short' }, 'day').format(at)
    : format({ dateStyle: 'medium' }, 'date').format(at);
}

/** A time of day alone: `06:00`. */
export function timeOfDay(at: number): string {
  if (!isShowable(at)) return '';
  return format({ timeStyle: 'short' }, 'time').format(at);
}

/** A moment in full: `22 Oct 2026, 21:40`. */
export function fullMoment(at: number): string {
  if (!isShowable(at)) return '';
  return format({ dateStyle: 'medium', timeStyle: 'short' }, 'full').format(at);
}

/** A day: `22 Oct 2026`. */
export function day(at: number): string {
  if (!isShowable(at)) return '';
  return format({ dateStyle: 'medium' }, 'date').format(at);
}

/**
 * When a pause ends, as a person reads it: `22:40` today, `Thu 06:00` another day. `null` for an
 * indefinite pause, which has no time to show (`isIndefinitePause`, never formatted).
 */
export function pauseEnd(until: number, now: number): string | null {
  if (isIndefinitePause(until) || !isShowable(until)) return null;
  if (sameDay(until, now)) return format({ timeStyle: 'short' }, 'time').format(until);
  return format({ weekday: 'short', hour: 'numeric', minute: '2-digit' }, 'weekday').format(until);
}

/** The hour the "until tomorrow" pause ends at, local time. */
const MORNING_HOUR = 6;

/** "For 1 hour": a duration, so it is the same instant in any time zone. */
export function inOneHour(now: number): number {
  return now + HOUR_MS;
}

/**
 * "Until tomorrow": the next 06:00 local time after `now` — this morning's when the person is
 * still up after midnight, else tomorrow's. Computed with local calendar setters, never as
 * `now + 24 h`: across a daylight-saving change a day is 23 or 25 hours, and 06:00 must stay
 * 06:00. Where a zone's clocks jump over 06:00 itself, the `Date` setters land on the first
 * valid instant after it.
 */
export function nextMorning(now: number): number {
  const at = new Date(now);
  at.setHours(MORNING_HOUR, 0, 0, 0);
  if (at.getTime() > now) return at.getTime();
  const tomorrow = new Date(now);
  tomorrow.setHours(12, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(MORNING_HOUR, 0, 0, 0);
  return tomorrow.getTime();
}

/** Whole minutes of a position (down) and of a length (to the nearest), for "31 of 48 min". */
export function progressMinutes(
  position: number,
  duration: number,
): {
  readonly position: number;
  readonly duration: number;
} {
  const total = Math.max(0, Math.round(duration / 60));
  return { position: Math.min(Math.max(0, Math.floor(position / 60)), total), duration: total };
}

/**
 * A play's words (`playLabel`: `Show · S1 E2`, or a film's title) as two lines: the title, and
 * the numbers when the label ends with them. Split at the last separator only when what follows
 * is numbers, so a title that itself contains the separator stays whole.
 */
export function splitLabel(label: string): { readonly title: string; readonly detail: string } {
  const at = label.lastIndexOf(' · ');
  if (at > 0) {
    const tail = label.slice(at + 3);
    if (/^(?:S\d{1,4}(?: E\d{1,5})?|E\d{1,5})$/u.test(tail)) {
      return { title: label.slice(0, at), detail: tail };
    }
  }
  return { title: label, detail: '' };
}
