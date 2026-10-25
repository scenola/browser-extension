/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// One ICU message, compiled (tools/i18n/compile.ts compiles the catalogs). A message is compiled
// in two steps: the parsed ICU becomes a checked tree (`WordNode`, src/i18n/data.ts) — every
// refusal happens here, once — and the tree is written out either as a function's source (the
// pages' catalogs) or as itself, as data (the worker's). One walk, two renderings: the two can
// only differ if `render` and the code below do, and a test holds them equal.

import {
  createLiteralElement,
  isArgumentElement,
  isDateElement,
  isLiteralElement,
  isNumberElement,
  isPluralElement,
  isPoundElement,
  isSelectElement,
  isTagElement,
  isTimeElement,
  parse,
} from '@formatjs/icu-messageformat-parser';
import type { MessageFormatElement } from '@formatjs/icu-messageformat-parser';

import type { WordCases, WordNode } from '../../apps/extension/src/i18n/data.ts';

/** A catalog this tool refuses, naming the locale, the key and why. */
export class I18nError extends Error {
  override readonly name = 'I18nError';
}

type DateStyle = 'short' | 'medium' | 'long' | 'full';
type NumberStyle = 'number' | 'integer' | 'percent';
const DATE_STYLES: ReadonlySet<unknown> = new Set<DateStyle>(['short', 'medium', 'long', 'full']);
const NUMBER_STYLES: ReadonlySet<unknown> = new Set<NumberStyle>(['number', 'integer', 'percent']);
const isDateStyle = (style: unknown): style is DateStyle => DATE_STYLES.has(style);
const isNumberStyle = (style: unknown): style is NumberStyle => NUMBER_STYLES.has(style);

interface Context {
  readonly locale: string;
  readonly key: string;
  /** The plural a `#` belongs to, if any. */
  readonly plural: { readonly name: string; readonly offset: number } | null;
}

function fail(c: Context, why: string): never {
  throw new I18nError(`${c.locale} ${c.key}: ${why}`);
}

function parseMessage(c: Context, message: string): MessageFormatElement[] {
  try {
    return parse(message, { requiresOtherClause: true, shouldParseSkeletons: false });
  } catch (error: unknown) {
    return fail(c, `not ICU MessageFormat (${error instanceof Error ? error.message : 'parse'})`);
  }
}

/** One message as a checked tree. */
export function compileData(locale: string, key: string, message: string): WordNode[] {
  const c: Context = { locale, key, plural: null };
  return nodesOf(c, parseMessage(c, message));
}

/** One message as a function expression `(p, f) => …` over `runtime.ts`'s formatter. */
export function compileMessage(locale: string, key: string, message: string): string {
  return messageFunction(compileData(locale, key, message));
}

function nodesOf(c: Context, elements: readonly MessageFormatElement[]): WordNode[] {
  return elements.map((element) => nodeOf(c, element));
}

function casesOf(
  c: Context,
  options: Readonly<Record<string, { readonly value: MessageFormatElement[] }>>,
  check: (selector: string) => void,
): WordCases {
  return Object.fromEntries(
    Object.entries(options).map(([selector, option]) => {
      check(selector);
      return [selector, nodesOf(c, option.value)];
    }),
  );
}

function nodeOf(c: Context, element: MessageFormatElement): WordNode {
  if (isLiteralElement(element)) return element.value;
  if (isArgumentElement(element)) return ['s', element.value];
  if (isNumberElement(element)) {
    const style = element.style ?? 'number';
    if (!isNumberStyle(style)) {
      return fail(c, `number style ${JSON.stringify(style)} is not supported`);
    }
    return ['n', element.value, style];
  }
  if (isDateElement(element) || isTimeElement(element)) {
    const style = element.style ?? 'medium';
    if (!isDateStyle(style)) {
      return fail(c, `date style ${JSON.stringify(style)} is not supported`);
    }
    return [isDateElement(element) ? 'd' : 't', element.value, style];
  }
  if (isPluralElement(element)) {
    const ordinal = element.pluralType === 'ordinal';
    const categories = new Intl.PluralRules(c.locale, {
      type: ordinal ? 'ordinal' : 'cardinal',
    }).resolvedOptions().pluralCategories as readonly string[];
    const inner: Context = { ...c, plural: { name: element.value, offset: element.offset } };
    const cases = casesOf(inner, element.options, (selector) => {
      if (!/^=\d{1,6}$/u.test(selector) && !categories.includes(selector)) {
        fail(c, `plural category "${selector}" does not exist in ${c.locale}`);
      }
    });
    return ['p', element.value, element.offset, ordinal, cases];
  }
  if (isSelectElement(element)) {
    return ['x', element.value, casesOf(c, element.options, () => undefined)];
  }
  if (isPoundElement(element)) {
    if (c.plural === null) return fail(c, '# outside a plural');
    return ['#', c.plural.name, c.plural.offset];
  }
  if (isTagElement(element)) return fail(c, 'tags are not supported: messages are plain text');
  return fail(c, 'unknown element');
}

/** `() => …` for plain text, `(p, f) => …` for a message that reads its parameters. */
export function messageFunction(nodes: readonly WordNode[]): string {
  const body = expression(nodes);
  return nodes.every((node) => typeof node === 'string') ? `() => ${body}` : `(p, f) => ${body}`;
}

function expression(nodes: readonly WordNode[]): string {
  if (nodes.length === 0) return "''";
  return nodes.map((node) => code(node)).join(' + ');
}

/**
 * A value as a JavaScript literal: its JSON, with `<`, `>`, `/`, U+2028 and U+2029 escaped too, so
 * a translation cannot close the code it is written into, whether a module or a script element.
 */
export const str = (value: unknown): string =>
  JSON.stringify(value).replace(
    /[<>/\u{2028}\u{2029}]/gu,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

const casesCode = (cases: WordCases): string =>
  Object.entries(cases)
    .map(([selector, nodes]) => `${str(selector)}: () => ${expression(nodes)}`)
    .join(', ');

function code(node: WordNode): string {
  if (typeof node === 'string') return str(node);
  switch (node[0]) {
    case 's':
      return `f.s(p, ${str(node[1])})`;
    case 'n':
      return `f.num(p, ${str(node[1])}, ${str(node[2])})`;
    case 'd':
      return `f.date(p, ${str(node[1])}, ${str(node[2])})`;
    case 't':
      return `f.time(p, ${str(node[1])}, ${str(node[2])})`;
    case 'p':
      return `f.plural(p, ${str(node[1])}, ${String(node[2])}, { ${casesCode(node[4])} }, ${String(node[3])})`;
    case 'x':
      return `f.select(p, ${str(node[1])}, { ${casesCode(node[2])} })`;
    case '#':
      return `f.pound(p, ${str(node[1])}, ${String(node[2])})`;
  }
}

/**
 * A plain message — literals, and arguments only from `values` — rendered as text: what the
 * manifest's strings are, since Chrome reads them without a formatter.
 */
export function plainText(
  locale: string,
  key: string,
  message: string,
  values: Readonly<Record<string, string>>,
): string {
  const c: Context = { locale, key, plural: null };
  const names = Object.keys(values).map((name) => `{${name}}`);
  return parseMessage(c, message)
    .map((element) => {
      if (isLiteralElement(element)) return element.value;
      if (isArgumentElement(element) && Object.hasOwn(values, element.value)) {
        return values[element.value] ?? '';
      }
      return fail(c, `a manifest string takes ${names.join(' and ')} only`);
    })
    .join('');
}

// The pseudo-locale: every letter accented, about a third longer, bracketed, so a
// string that never went through a catalog and a box that clips longer languages both show.

const PLAIN_LETTERS = Array.from('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
const ACCENTED_LETTERS = Array.from('åƀçðéƒĝĥîĵķļɱñöþǫŕšţûṽŵẋýžÅƁÇÐÉƑĜĤÎĴĶĻṀÑÖÞǪŔŠŢÛṼŴẊÝŽ');
const ACCENTS: ReadonlyMap<string, string> = new Map(
  PLAIN_LETTERS.map((letter, i) => [letter, ACCENTED_LETTERS[i] ?? letter]),
);

function pseudoElements(elements: readonly MessageFormatElement[]): MessageFormatElement[] {
  return elements.map((element) => {
    if (isLiteralElement(element)) {
      const accented = Array.from(element.value, (ch) => ACCENTS.get(ch) ?? ch).join('');
      return { ...element, value: accented };
    }
    if (isPluralElement(element) || isSelectElement(element)) {
      return {
        ...element,
        options: Object.fromEntries(
          Object.entries(element.options).map(([selector, option]) => [
            selector,
            { ...option, value: pseudoElements(option.value) },
          ]),
        ),
      };
    }
    return element;
  });
}

function textLength(elements: readonly MessageFormatElement[]): number {
  return elements.reduce((sum, e) => sum + (isLiteralElement(e) ? e.value.length : 6), 0);
}

/**
 * One source message in the pseudo-locale, as a checked tree: parsed in `source`, accented,
 * padded and bracketed, then checked as `pseudo`'s.
 */
export function pseudoData(
  source: string,
  pseudo: string,
  key: string,
  message: string,
): WordNode[] {
  const c: Context = { locale: source, key, plural: null };
  const ast = pseudoElements(parseMessage(c, message));
  const padding = '~'.repeat(Math.ceil(textLength(ast) * 0.35));
  const wrapped: MessageFormatElement[] = [
    createLiteralElement('['),
    ...ast,
    createLiteralElement(`${padding}]`),
  ];
  return nodesOf({ ...c, locale: pseudo }, wrapped);
}
