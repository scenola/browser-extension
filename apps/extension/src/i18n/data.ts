/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The worker's words as data. A service worker cannot `import()`, so it cannot load a compiled
// catalog on demand the way a page does; it reads its UI language's catalog — core's keys only —
// as JSON from the package (`i18n/<locale>.json`) and renders it here. The data is the
// compiler's checked tree of the same ICU message the pages' functions are compiled from
// (tools/i18n/compile.ts emits both from one walk), rendered over the same formatter, so the
// two cannot disagree; a test holds them equal key by key.

import { isRecord } from '../values';
import type { Formatter, Params } from './runtime';

type NumberStyle = 'number' | 'integer' | 'percent';
type DateStyle = 'short' | 'medium' | 'long' | 'full';

/** One part of a message: literal text, or a parameter as a formatter call. */
export type WordNode =
  | string
  | readonly ['s', string]
  | readonly ['n', string, NumberStyle]
  | readonly ['d' | 't', string, DateStyle]
  | readonly ['p', string, number, boolean, WordCases]
  | readonly ['x', string, WordCases]
  | readonly ['#', string, number];

/** A plural's or a select's branches, by selector. */
export type WordCases = Readonly<Record<string, readonly WordNode[]>>;

export interface DataCatalog {
  readonly locale: string;
  readonly messages: Readonly<Record<string, readonly WordNode[]>>;
}

/** A message's text: what its compiled function returns for the same parameters. */
export function render(nodes: readonly WordNode[], p: Params, f: Formatter): string {
  let out = '';
  for (const node of nodes) out += typeof node === 'string' ? node : part(node, p, f);
  return out;
}

function branches(cases: WordCases, p: Params, f: Formatter): Record<string, () => string> {
  const out: Record<string, () => string> = {};
  for (const [selector, nodes] of Object.entries(cases)) out[selector] = () => render(nodes, p, f);
  return out;
}

function part(node: Exclude<WordNode, string>, p: Params, f: Formatter): string {
  switch (node[0]) {
    case 's':
      return f.s(p, node[1]);
    case 'n':
      return f.num(p, node[1], node[2]);
    case 'd':
      return f.date(p, node[1], node[2]);
    case 't':
      return f.time(p, node[1], node[2]);
    case 'p':
      return f.plural(p, node[1], node[2], branches(node[4], p, f), node[3]);
    case 'x':
      return f.select(p, node[1], branches(node[2], p, f));
    case '#':
      return f.pound(p, node[1], node[2]);
  }
}

// What a catalog read from the package may be. It is ours, but it is a file: a damaged one is
// refused whole, and the worker speaks English, never a half-read tree.

const MAX_DEPTH = 8;
const MAX_NAME = 64;
const NUMBER_STYLES: ReadonlySet<unknown> = new Set(['number', 'integer', 'percent']);
const DATE_STYLES: ReadonlySet<unknown> = new Set(['short', 'medium', 'long', 'full']);

const isName = (x: unknown): x is string =>
  typeof x === 'string' && x.length > 0 && x.length <= MAX_NAME;

function isCases(x: unknown, depth: number): boolean {
  return isRecord(x) && Object.values(x).every((nodes) => isNodes(nodes, depth + 1));
}

function isNode(x: unknown, depth: number): boolean {
  if (typeof x === 'string') return true;
  if (!Array.isArray(x)) return false;
  const [kind, name, a, b, c] = x as readonly unknown[];
  if (!isName(name)) return false;
  switch (kind) {
    case 's':
      return x.length === 2;
    case 'n':
      return x.length === 3 && NUMBER_STYLES.has(a);
    case 'd':
    case 't':
      return x.length === 3 && DATE_STYLES.has(a);
    case 'p':
      return (
        x.length === 5 && Number.isSafeInteger(a) && typeof b === 'boolean' && isCases(c, depth)
      );
    case 'x':
      return x.length === 3 && isCases(a, depth);
    case '#':
      return x.length === 3 && Number.isSafeInteger(a);
    default:
      return false;
  }
}

function isNodes(x: unknown, depth: number): boolean {
  return depth <= MAX_DEPTH && Array.isArray(x) && x.every((node) => isNode(node, depth));
}

/** Whether `x` is a catalog of `locale`, every message a well-formed tree. */
export function isDataCatalog(x: unknown, locale: string): x is DataCatalog {
  return (
    isRecord(x) &&
    x.locale === locale &&
    isRecord(x.messages) &&
    Object.values(x.messages).every((nodes) => isNodes(nodes, 0))
  );
}
