/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The player routes' safety check, run by `defineService` on every route a module declares.
// A route is data that runs in the worker against every pathname of its site, so a route that
// backtracks catastrophically would stall the worker for whatever page asked it to: the shapes
// that can are refused here, whatever review let through.

const MAX_ROUTE_SOURCE = 256;
const MAX_ROUTE_BOUND = 255;
const MAX_ROUTE_VARIABLE_QUANTIFIERS = 8;
const MAX_ROUTE_UNBOUNDED_QUANTIFIERS = 2;
const ROUTE_FLAGS = 'dimsu';

interface Quantifier {
  readonly min: number;
  readonly max: number;
  readonly length: number;
}

const BOUNDED = /^\{(\d{1,4})(,(\d{0,4}))?\}/;
/** What opens a group: `(?:`, a lookaround, a named group; a plain `(` is matched by none. */
const GROUP_HEAD = /^\(\?(?::|=|!|<=|<!|<[A-Za-z_$][A-Za-z0-9_$]*>)/;

/** The quantifier at `source[index]`, or `null` when there is none there. */
function quantifierAt(source: string, index: number): Quantifier | null {
  const char = source[index];
  let quantifier: Quantifier | null = null;
  if (char === '*') quantifier = { min: 0, max: Infinity, length: 1 };
  else if (char === '+') quantifier = { min: 1, max: Infinity, length: 1 };
  else if (char === '?') quantifier = { min: 0, max: 1, length: 1 };
  else if (char === '{') {
    const match = BOUNDED.exec(source.slice(index, index + 12));
    if (match !== null) {
      const min = Number(match[1]);
      const max = match[2] === undefined ? min : match[3] === '' ? Infinity : Number(match[3]);
      quantifier = { min, max, length: match[0].length };
    }
  }
  if (quantifier === null) return null;
  // A lazy quantifier (`*?`) backtracks the same way.
  const lazy = source[index + quantifier.length] === '?';
  return lazy ? { ...quantifier, length: quantifier.length + 1 } : quantifier;
}

/** How far an escape at `source[index]` (a backslash) reaches, or a problem. */
function escapeEnd(source: string, index: number): number | string {
  const next = source[index + 1];
  if (next === undefined) return 'ends in a backslash';
  if (/[1-9]/.test(next) || next === 'k') return 'uses a backreference';
  if ((next === 'p' || next === 'P' || next === 'u') && source[index + 2] === '{') {
    const close = source.indexOf('}', index + 2);
    return close === -1 ? 'has an unterminated escape' : close + 1;
  }
  return index + 2;
}

interface Group {
  variable: boolean;
  alternation: boolean;
}

/**
 * Why a player route is unsafe, or `null`. Routes are reviewed, and run only on a pathname
 * of at most 2,048 characters; this refuses the shapes that are catastrophic whatever the
 * review says: a stateful flag, a backreference, a repeated group that holds a variable
 * quantifier or an alternation (exponential backtracking), more than two unbounded
 * quantifiers or eight variable ones (polynomial backtracking past a quadratic bound).
 */
export function routeProblem(route: RegExp): string | null {
  const source = route.source;
  if (source.length > MAX_ROUTE_SOURCE) {
    return `is longer than ${String(MAX_ROUTE_SOURCE)} characters`;
  }
  for (const flag of route.flags) {
    if (!ROUTE_FLAGS.includes(flag)) return `uses the ${flag} flag`;
  }
  const scan: RouteScan = {
    source,
    stack: [{ variable: false, alternation: false }],
    variable: 0,
    unbounded: 0,
    last: null,
    index: 0,
  };
  while (scan.index < source.length) {
    const problem = scanStep(scan);
    if (problem !== null) return problem;
  }
  if (scan.stack.length !== 1) return 'has an unbalanced parenthesis';
  if (scan.unbounded > MAX_ROUTE_UNBOUNDED_QUANTIFIERS) {
    return `has more than ${String(MAX_ROUTE_UNBOUNDED_QUANTIFIERS)} unbounded quantifiers`;
  }
  if (scan.variable > MAX_ROUTE_VARIABLE_QUANTIFIERS) {
    return `has more than ${String(MAX_ROUTE_VARIABLE_QUANTIFIERS)} variable quantifiers`;
  }
  return null;
}

/** A route's source as `routeProblem` walks it, one token at a time. */
interface RouteScan {
  readonly source: string;
  /** The open groups, the whole pattern at the bottom. */
  readonly stack: Group[];
  /** Quantifiers whose bounds differ, and those without an upper one. */
  variable: number;
  unbounded: number;
  /** The atom a quantifier would apply to: a group's contents, a single atom, or none. */
  last: Group | 'atom' | null;
  index: number;
}

/** One token of the scan read and stepped over, or a problem. */
function scanStep(scan: RouteScan): string | null {
  const { source, stack } = scan;
  const top = stack[stack.length - 1];
  if (top === undefined) return 'has an unbalanced parenthesis';
  switch (source[scan.index]) {
    case '\\':
      return stepOver(scan, escapeEnd(source, scan.index));
    case '[':
      return stepOver(scan, classEnd(source, scan.index));
    case '(': {
      stack.push({ variable: false, alternation: false });
      const head = GROUP_HEAD.exec(source.slice(scan.index, scan.index + 64));
      scan.index += head === null ? 1 : head[0].length;
      scan.last = null;
      return null;
    }
    case ')':
      return closeGroup(scan);
    case '|':
      top.alternation = true;
      scan.index += 1;
      scan.last = null;
      return null;
  }
  const quantifier = quantifierAt(source, scan.index);
  if (quantifier !== null) return applyQuantifier(scan, top, quantifier);
  scan.index += 1;
  scan.last = 'atom';
  return null;
}

/** An atom that ends at `end` (an escape, a class), or the problem that ended the scan. */
function stepOver(scan: RouteScan, end: number | string): string | null {
  if (typeof end === 'string') return end;
  scan.index = end;
  scan.last = 'atom';
  return null;
}

/** Where a character class at `source[index]` ends, past its `]`, or a problem. */
function classEnd(source: string, index: number): number | string {
  let end = index + 1;
  while (end < source.length && source[end] !== ']') end += source[end] === '\\' ? 2 : 1;
  return end >= source.length ? 'has an unterminated class' : end + 1;
}

/** A `)`: the group's contents pass up to its parent, and the group is what a quantifier repeats. */
function closeGroup(scan: RouteScan): string | null {
  const group = scan.stack.pop();
  const parent = scan.stack[scan.stack.length - 1];
  if (group === undefined || parent === undefined) return 'has an unbalanced parenthesis';
  parent.variable ||= group.variable;
  parent.alternation ||= group.alternation;
  scan.index += 1;
  scan.last = group;
  return null;
}

/** A quantifier counted, and refused when it repeats a group that can backtrack. */
function applyQuantifier(scan: RouteScan, top: Group, quantifier: Quantifier): string | null {
  if (quantifier.max !== Infinity && quantifier.max > MAX_ROUTE_BOUND) {
    return `has a bound above ${String(MAX_ROUTE_BOUND)}`;
  }
  if (quantifier.min !== quantifier.max) {
    scan.variable += 1;
    top.variable = true;
  }
  if (quantifier.max === Infinity) scan.unbounded += 1;
  const last = scan.last;
  if (typeof last === 'object' && last !== null && quantifier.max > 1) {
    if (last.variable || last.alternation) {
      return 'repeats a group that holds a variable quantifier or an alternation';
    }
  }
  scan.index += quantifier.length;
  scan.last = null;
  return null;
}
