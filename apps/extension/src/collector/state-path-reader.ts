/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Our state-path reader: the worker runs it in a page's MAIN world with
// `scripting.executeScript({ world: "MAIN", func: readStatePath, args })`, so it walks the
// player's own objects where they live. Chrome serialises the function's source, not its module:
// it is **self-contained** — no import, no closure, nothing from outside its body but the page's
// own built-ins — and its arguments are plain data the worker passes (the path, the module's
// allow-listed calls, the player route's capture groups), which the page cannot change. It
// returns plain JSON, which the worker bounds again on arrival; the page can forge only the
// data, which is untrusted anyway.
//
// The page is hostile: getters, proxies, throwing `toJSON`. Every property is read once per step,
// inside `try`, and the value read is the one used; nothing of the page's is ever serialised by
// the page's own code (no `JSON`, no `toJSON`): the clone is built here, depth ≤ 6, ≤ 32 KB as
// JSON writes it, functions, symbols and cycles dropped. Its loops are indexed and bounded by
// its own counters — no array iterator, no `Math` — so a page that replaced those built-ins
// cannot make it run on. Any failure anywhere is `null`.

/* eslint-disable @typescript-eslint/prefer-for-of, @typescript-eslint/restrict-template-expressions
   -- In the page, `for…of` takes the page's Array iterator and `String(n)` the page's `String`;
   indexed loops and a template literal (ToString itself) take neither. */

import type { StatePath } from '@mt/services';

/**
 * The value at `path` from the page's global object, cloned to bounded JSON, or `null`.
 *
 * - A property step reads that property of the current value.
 * - `{ call }` calls the current value's method of that name with no arguments — only a name in
 *   `allowedCalls`, only a function, inside `try`.
 * - `{ routeGroup: n }` reads the property named `routeGroups[n]` (capture group `n` of the
 *   player route that matched the frame's pathname; index 0 is the whole match).
 * - `{ find: { key, routeGroup } }` takes the first element of the current array whose value at
 *   `key` (with `"*"` for any element of an array there) equals `routeGroups[routeGroup]` — a
 *   string, or a number written the same — examining at most 256 elements of any array and
 *   4,096 in all.
 * - `{ pick: [...] }`, the last step only, keeps only those properties.
 */
export function readStatePath(
  path: StatePath,
  allowedCalls: readonly string[],
  routeGroups: readonly (string | null)[] = [],
): unknown {
  const MAX_DEPTH = 6;
  const MAX_CHARS = 32 * 1024;
  const MAX_NODES = 10_000;
  const MAX_KEYS = 1_000;
  const MAX_KEY_LENGTH = 256;
  const MAX_FIND_PER_ARRAY = 256;
  const MAX_FIND_TOTAL = 4_096;
  const MAX_FIND_KEY = 8;
  const ANY = '*';
  /** What the clone leaves out (`undefined` in an object, `null` in an array — as JSON does). */
  const SKIP = {};

  type Read = { readonly ok: true; readonly value: unknown } | { readonly ok: false };
  const FAILED: Read = { ok: false };

  const min = (a: number, b: number): number => (a < b ? a : b);

  /** One read of one property; a getter runs once, and a throw is no value. */
  const read = (target: unknown, key: string | number): Read => {
    if ((typeof target !== 'object' && typeof target !== 'function') || target === null) {
      return FAILED;
    }
    try {
      return { ok: true, value: (target as Record<string | number, unknown>)[key] };
    } catch {
      return FAILED;
    }
  };

  const isArray = (value: unknown): value is readonly unknown[] => {
    try {
      return Array.isArray(value);
    } catch {
      return false;
    }
  };

  /** How many elements of an array to look at: its length, at most `most`; 0 for no length. */
  const countOf = (array: unknown, most: number): number => {
    const length = read(array, 'length');
    if (!length.ok || typeof length.value !== 'number' || !(length.value > 0)) return 0;
    return min(length.value, most);
  };

  const finite = (value: number): boolean =>
    value === value && value !== Infinity && value !== -Infinity;

  /** A string's or a finite number's text, as a route group compares it. */
  const textOf = (value: unknown): string | null => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && finite(value)) return `${value}`;
    return null;
  };

  let examined = 0;
  /** Whether the value at `key[at…]` of `node` equals `wanted`, `"*"` trying each element. */
  const matches = (node: unknown, key: readonly unknown[], at: number, wanted: string): boolean => {
    if (at === key.length) return textOf(node) === wanted;
    const step = key[at];
    if (step === ANY) {
      if (!isArray(node)) return false;
      const count = countOf(node, MAX_FIND_PER_ARRAY);
      for (let i = 0; i < count; i += 1) {
        examined += 1;
        if (examined > MAX_FIND_TOTAL) return false;
        const element = read(node, i);
        if (element.ok && matches(element.value, key, at + 1, wanted)) return true;
      }
      return false;
    }
    if (typeof step !== 'string') return false;
    const next = read(node, step);
    return next.ok && matches(next.value, key, at + 1, wanted);
  };

  let chars = 0;
  let nodes = 0;
  const ancestors: unknown[] = [];

  /**
   * A key or a string value as far as `room` lets JSON write it, quotes included, and what it
   * costs — read by index, never through the string's methods. Each character is counted at its
   * widest (an escape, a control or a surrogate as `\uXXXX`), never less than JSON writes.
   */
  const quoted = (text: string, room: number): { readonly text: string; readonly cost: number } => {
    let cost = 2;
    let kept = '';
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i] ?? '';
      const width =
        c === '"' || c === '\\' ? 2 : c < ' ' || (c >= '\uD800' && c <= '\uDFFF') ? 6 : 1;
      if (cost + width > room) break;
      cost += width;
      kept += c;
    }
    return { text: kept, cost };
  };

  const clone = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_NODES) return SKIP;
    if (value === null) {
      if (chars + 4 > MAX_CHARS) return SKIP;
      chars += 4;
      return null;
    }
    switch (typeof value) {
      case 'string': {
        if (chars + 2 > MAX_CHARS) return SKIP;
        const fitted = quoted(value, MAX_CHARS - chars);
        chars += fitted.cost;
        return fitted.text;
      }
      case 'number': {
        const cost = finite(value) ? `${value}`.length : 4;
        if (chars + cost > MAX_CHARS) return SKIP;
        chars += cost;
        return finite(value) ? value : null;
      }
      case 'boolean':
        if (chars + 5 > MAX_CHARS) return SKIP;
        chars += value ? 4 : 5;
        return value;
      case 'object':
        break;
      default:
        // undefined, a function, a symbol, a bigint: JSON has none.
        return SKIP;
    }
    if (depth > MAX_DEPTH || chars + 2 > MAX_CHARS) return SKIP;
    for (let i = 0; i < ancestors.length; i += 1) if (ancestors[i] === value) return SKIP;
    ancestors[ancestors.length] = value;
    chars += 2;
    try {
      if (isArray(value)) {
        const out: unknown[] = [];
        const count = countOf(value, MAX_KEYS);
        for (let i = 0; i < count; i += 1) {
          // A separator and at least a `null` must fit.
          if (chars + 5 > MAX_CHARS || nodes >= MAX_NODES) break;
          chars += 1;
          const member = read(value, i);
          const copied = member.ok ? clone(member.value, depth + 1) : SKIP;
          if (copied === SKIP) chars += 4;
          out[out.length] = copied === SKIP ? null : copied;
        }
        return out;
      }
      let keys: readonly unknown[];
      try {
        keys = Object.keys(value);
      } catch {
        return {};
      }
      const out: Record<string, unknown> = {};
      const count = countOf(keys, MAX_KEYS);
      for (let i = 0; i < count; i += 1) {
        const entry = read(keys, i);
        const key = entry.ok ? entry.value : undefined;
        if (typeof key !== 'string' || key.length > MAX_KEY_LENGTH || key === '__proto__') continue;
        const name = quoted(key, MAX_KEY_LENGTH * 6 + 2);
        // The key, its colon, a separator and at least a `null` must fit.
        if (chars + name.cost + 2 + 4 > MAX_CHARS || nodes >= MAX_NODES) break;
        const member = read(value, key);
        if (!member.ok) continue;
        const before = chars;
        chars += name.cost + 2;
        const copied = clone(member.value, depth + 1);
        if (copied === SKIP) {
          chars = before;
          continue;
        }
        out[key] = copied;
      }
      return out;
    } finally {
      ancestors.length -= 1;
    }
  };

  // A path is 1 to 16 steps. No step would clone the page's whole global object; the SDK
  // refuses either at build time, and the reader does not take one either.
  const MAX_STEPS = 16;
  try {
    if (path.length < 1 || path.length > MAX_STEPS) return null;
    let current: unknown = globalThis;
    for (let index = 0; index < path.length; index += 1) {
      const step: unknown = path[index];
      if (typeof step === 'string') {
        const next = read(current, step);
        if (!next.ok) return null;
        current = next.value;
      } else if (typeof step === 'object' && step !== null) {
        const call = (step as { readonly call?: unknown }).call;
        const routeGroup = (step as { readonly routeGroup?: unknown }).routeGroup;
        const find = (step as { readonly find?: unknown }).find;
        const pick = (step as { readonly pick?: unknown }).pick;
        if (typeof call === 'string') {
          let allowed = false;
          for (let i = 0; i < allowedCalls.length; i += 1) {
            if (allowedCalls[i] === call) allowed = true;
          }
          if (!allowed) return null;
          const method = read(current, call);
          if (!method.ok || typeof method.value !== 'function') return null;
          try {
            current = (method.value as (this: unknown) => unknown).call(current);
          } catch {
            return null;
          }
        } else if (typeof routeGroup === 'number') {
          const key = routeGroups[routeGroup];
          if (typeof key !== 'string' || key === '') return null;
          const next = read(current, key);
          if (!next.ok) return null;
          current = next.value;
        } else if (typeof find === 'object' && find !== null) {
          const key: unknown = (find as { readonly key?: unknown }).key;
          const group: unknown = (find as { readonly routeGroup?: unknown }).routeGroup;
          const wanted = typeof group === 'number' ? routeGroups[group] : undefined;
          if (!isArray(key) || key.length === 0 || key.length > MAX_FIND_KEY) return null;
          if (typeof wanted !== 'string' || wanted === '' || !isArray(current)) return null;
          const count = countOf(current, MAX_FIND_PER_ARRAY);
          let found: Read = FAILED;
          for (let i = 0; i < count && !found.ok; i += 1) {
            examined += 1;
            if (examined > MAX_FIND_TOTAL) return null;
            const element = read(current, i);
            if (element.ok && matches(element.value, key, 0, wanted)) found = element;
          }
          if (!found.ok) return null;
          current = found.value;
        } else if (isArray(pick) && index === path.length - 1) {
          if ((typeof current !== 'object' && typeof current !== 'function') || current === null) {
            return null;
          }
          const picked: Record<string, unknown> = {};
          const count = countOf(pick, MAX_KEYS);
          for (let i = 0; i < count; i += 1) {
            const name = pick[i];
            if (typeof name !== 'string' || name === '__proto__') continue;
            const member = read(current, name);
            if (member.ok && member.value !== undefined) picked[name] = member.value;
          }
          current = picked;
        } else {
          return null;
        }
      } else {
        return null;
      }
      // Nothing there: neither a value to return nor one to walk on from.
      if (current === undefined || current === null) return null;
    }
    const result = clone(current, 1);
    return result === SKIP || result === undefined ? null : result;
  } catch {
    return null;
  }
}
