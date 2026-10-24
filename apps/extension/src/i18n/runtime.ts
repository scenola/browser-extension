/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What a compiled message calls: ICU MessageFormat is parsed at build time (tools/i18n/compile.ts),
// so a message here is a plain function over its parameters and this locale's `Intl` formatters
// — plurals, selects, numbers and dates without a runtime parser.

export type Params = Readonly<Record<string, string | number>>;

/** One branch of a plural or a select, rendered only when chosen. */
type Branch = () => string;

type DateStyle = 'short' | 'medium' | 'long' | 'full';

export interface Formatter {
  readonly locale: string;
  /** A parameter as text; an absent one is empty. */
  s(p: Params, name: string): string;
  num(p: Params, name: string, style: 'number' | 'integer' | 'percent'): string;
  date(p: Params, name: string, style: DateStyle): string;
  time(p: Params, name: string, style: DateStyle): string;
  plural(
    p: Params,
    name: string,
    offset: number,
    cases: Readonly<Record<string, Branch>>,
    ordinal: boolean,
  ): string;
  /** `#` inside a plural: its number less the offset, formatted. */
  pound(p: Params, name: string, offset: number): string;
  select(p: Params, name: string, cases: Readonly<Record<string, Branch>>): string;
}

type Message = (p: Params, f: Formatter) => string;

export interface Catalog {
  readonly locale: string;
  readonly messages: Readonly<Record<string, Message>>;
}

/** A parameter, read as an own property only: a name is never a prototype key. */
const param = (p: Params, name: string): string | number | undefined =>
  Object.hasOwn(p, name) ? p[name] : undefined;

const pick = (cases: Readonly<Record<string, Branch>>, key: string): Branch | undefined =>
  Object.hasOwn(cases, key) ? cases[key] : undefined;

const asNumber = (value: string | number | undefined): number =>
  typeof value === 'number' ? value : Number(value);

/** The formatters of one locale, made once and shared by every message of its catalog. */
export function createFormatter(locale: string): Formatter {
  const cardinal = new Intl.PluralRules(locale);
  const ordinalRules = new Intl.PluralRules(locale, { type: 'ordinal' });
  const numbers = new Intl.NumberFormat(locale);
  const integers = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const percents = new Intl.NumberFormat(locale, { style: 'percent' });
  const dates = new Map<string, Intl.DateTimeFormat>();

  const dateFormat = (kind: 'date' | 'time', style: DateStyle): Intl.DateTimeFormat => {
    const key = `${kind}:${style}`;
    let format = dates.get(key);
    if (format === undefined) {
      format = new Intl.DateTimeFormat(
        locale,
        kind === 'date' ? { dateStyle: style } : { timeStyle: style },
      );
      dates.set(key, format);
    }
    return format;
  };
  const formatDate = (kind: 'date' | 'time', value: unknown, style: DateStyle): string => {
    const at = new Date(asNumber(value as string | number | undefined));
    return Number.isNaN(at.getTime()) ? '' : dateFormat(kind, style).format(at);
  };
  const formatNumber = (format: Intl.NumberFormat, n: number): string =>
    Number.isFinite(n) ? format.format(n) : '';
  const choose = (cases: Readonly<Record<string, Branch>>, key: string): string =>
    (pick(cases, key) ?? pick(cases, 'other'))?.() ?? '';

  return {
    locale,
    s: (p, name) => {
      const value = param(p, name);
      return value === undefined ? '' : String(value);
    },
    num: (p, name, style) =>
      formatNumber(
        style === 'percent' ? percents : style === 'integer' ? integers : numbers,
        asNumber(param(p, name)),
      ),
    date: (p, name, style) => formatDate('date', param(p, name), style),
    time: (p, name, style) => formatDate('time', param(p, name), style),
    plural: (p, name, offset, cases, ordinal) => {
      const n = asNumber(param(p, name));
      if (!Number.isFinite(n)) return choose(cases, 'other');
      const exact = pick(cases, `=${String(n)}`);
      if (exact !== undefined) return exact();
      return choose(cases, (ordinal ? ordinalRules : cardinal).select(n - offset));
    },
    pound: (p, name, offset) => formatNumber(numbers, asNumber(param(p, name)) - offset),
    select: (p, name, cases) => choose(cases, String(param(p, name))),
  };
}
