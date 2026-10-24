/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Datetimes as the server reads and writes them: Pydantic's parse of a string, and Python's
// `isoformat()` of a UTC instant.

/**
 * What Pydantic's datetime parser takes from a string, as far as the mock goes: a date, or a date
 * and a time (`T`, `t`, a space or `_` between), seconds and up to nine fraction digits optional
 * (Pydantic takes more), an offset `Z`/`z` or `±HH[:]MM` optional — each form checked against
 * the backend's own parser. Linear: one anchored pass, no nested quantifier, the input capped.
 */
const DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt _](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(?:([Zz])|([+-])(\d{2}):?(\d{2}))?)?$/;

export interface ParsedDateTime {
  /** The instant in microseconds since the epoch (exact), local time when there is no offset. */
  readonly epochMicros: bigint;
  /** The offset east of UTC in seconds, or `null` for a naive time. */
  readonly offsetSeconds: number | null;
}

/** `text` as a datetime, or `null` when Pydantic would not read it as one. */
export function parseDateTime(text: string): ParsedDateTime | null {
  if (text.length > 64) return null;
  const m = DATETIME.exec(text);
  if (m === null) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0', fraction = '', zulu, sign, oh, om] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const offsetSeconds = offsetOf(zulu, sign, oh, om);
  if (offsetSeconds === undefined) return null;
  const micros = BigInt(fraction.padEnd(6, '0').slice(0, 6));
  const seconds =
    BigInt(daysFromCivil(year, month, day)) * 86_400n +
    BigInt(hour * 3600 + minute * 60 + second) -
    BigInt(offsetSeconds ?? 0);
  return { epochMicros: seconds * 1_000_000n + micros, offsetSeconds };
}

/**
 * The offset east of UTC in seconds that `Z` or `±HH[:]MM` states, `null` for none (a naive
 * time), `undefined` for one out of range.
 */
function offsetOf(
  zulu: string | undefined,
  sign: string | undefined,
  hours: string | undefined,
  minutes: string | undefined,
): number | null | undefined {
  if (zulu !== undefined) return 0;
  if (sign === undefined) return null;
  const offsetHours = Number(hours);
  const offsetMinutes = Number(minutes);
  if (offsetHours > 23 || offsetMinutes > 59) return undefined;
  return (sign === '-' ? -1 : 1) * (offsetHours * 3600 + offsetMinutes * 60);
}

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

function daysIn(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's `days_from_civil`). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** Python's `datetime.isoformat()` of a UTC instant in epoch milliseconds: `…+00:00`. */
export function isoformatUtc(epochMs: number): string {
  const text = new Date(epochMs).toISOString();
  const millis = text.slice(20, 23);
  const whole = text.slice(0, 19);
  return millis === '000' ? `${whole}+00:00` : `${whole}.${millis}000+00:00`;
}
