/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Our state-path reader, run on a fake global: it follows
// ["netflix","appContext","state","playerApp",{call:"getState"},"videoPlayer"]; refuses a call
// not in allowedCalls (returns null); clones a cyclic object without a throw; truncates a 1 MB
// string so the JSON is ≤ 32 KB; cuts depth beyond 6. It is a self-contained function (no
// imports, no closures) and returns null on any failure. Its steps: routeGroup, find with its
// bound (256 elements of any array, 4,096 in all), and pick as the last step only; it never
// calls the page's toJSON.

import { runInNewContext } from 'node:vm';

import type { StatePath } from '@mt/services';
import fc from 'fast-check';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { readStatePath } from './state-path-reader';

const RUNS = { seed: 20261022, numRuns: 300 } as const;
const MAX_JSON = 32 * 1024;

const NETFLIX_PATH: StatePath = [
  'netflix',
  'appContext',
  'state',
  'playerApp',
  { call: 'getState' },
  'videoPlayer',
];

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The depth of containers in a JSON value: a primitive is 0, `{}` or `[]` is 1. */
function depthOf(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0;
  let deepest = 0;
  for (const member of Object.values(value)) deepest = Math.max(deepest, depthOf(member));
  return deepest + 1;
}

describe('readStatePath', () => {
  test('follows the Netflix path through its allow-listed call', () => {
    const videoPlayer = {
      videoMetadata: { '70196253': { _metadata: { video: { title: 'Breaking Bad' } } } },
    };
    vi.stubGlobal('netflix', {
      appContext: { state: { playerApp: { getState: () => ({ videoPlayer }) } } },
    });
    expect(readStatePath(NETFLIX_PATH, ['getState'])).toEqual(videoPlayer);
  });

  test('a call not in allowedCalls returns null, and the method never runs', () => {
    const getState = vi.fn(() => ({ videoPlayer: { x: 1 } }));
    vi.stubGlobal('netflix', { appContext: { state: { playerApp: { getState } } } });
    expect(readStatePath(NETFLIX_PATH, [])).toBeNull();
    expect(readStatePath(NETFLIX_PATH, ['getstate', 'reload'])).toBeNull();
    expect(getState).not.toHaveBeenCalled();
  });

  // A {call} step runs only if the value is a function.
  test('a call step on something that is not a function returns null', () => {
    vi.stubGlobal('netflix', {
      appContext: { state: { playerApp: { getState: { videoPlayer: 1 } } } },
    });
    expect(readStatePath(NETFLIX_PATH, ['getState'])).toBeNull();
  });

  test('a cyclic object is cloned without a throw', () => {
    const player: Record<string, unknown> = { title: 'Breaking Bad', season: 1 };
    player.self = player;
    player.list = [player, { back: player }];
    vi.stubGlobal('mtCycle', { player });
    const out = readStatePath(['mtCycle', 'player'], []);
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(out).toMatchObject({ title: 'Breaking Bad', season: 1 });
  });

  test('a 1 MB string is truncated so the JSON is at most 32 KB', () => {
    vi.stubGlobal('mtBig', { text: 'x'.repeat(1024 * 1024), title: 'kept' });
    const out = readStatePath(['mtBig', 'text'], []);
    expect(typeof out).toBe('string');
    expect(new TextEncoder().encode(JSON.stringify(out)).byteLength).toBeLessThanOrEqual(MAX_JSON);
    expect((out as string).length).toBeGreaterThan(0);
    expect('x'.repeat(1024 * 1024).startsWith(out as string)).toBe(true);
    const whole = JSON.stringify(readStatePath(['mtBig'], []));
    expect(new TextEncoder().encode(whole).byteLength).toBeLessThanOrEqual(MAX_JSON);
  });

  test('depth 7 is cut; depth 6 is kept whole', () => {
    const nest = (levels: number): unknown =>
      levels === 0 ? 'leaf' : { level: levels, next: nest(levels - 1) };
    vi.stubGlobal('mtDeep', { six: nest(6), seven: nest(7) });
    const six = readStatePath(['mtDeep', 'six'], []);
    expect(six).toEqual(nest(6));
    expect(depthOf(six)).toBe(6);
    const seven = readStatePath(['mtDeep', 'seven'], []);
    expect(depthOf(seven)).toBeLessThanOrEqual(6);
    expect(seven).toMatchObject({ level: 7, next: { level: 6 } });
  });

  test.each([
    [['mtNone', 'missing'] as StatePath],
    [['mtObj', { unknown: 1 }] as unknown as StatePath],
    [['mtObj', 42] as unknown as StatePath],
  ])('a path that leads nowhere (%j) returns null', (path) => {
    vi.stubGlobal('mtObj', { a: 1 });
    expect(readStatePath(path, [])).toBeNull();
  });

  // A state path is 1 to 16 steps (the SDK refuses any other at build time); the reader refuses
  // one too, rather than clone the page's whole global.
  test('a path of no steps, or of more than 16, returns null', () => {
    vi.stubGlobal('mtObj', { a: 1 });
    expect(readStatePath([], [])).toBeNull();
    const long = ['mtObj', ...Array.from({ length: 16 }, () => 'a')] as unknown as StatePath;
    expect(readStatePath(long, [])).toBeNull();
  });
});

describe('the routeGroup, find and pick steps', () => {
  const ROUTE = ['/watch/70196253', '70196253'];

  // { routeGroup: n }: a key named by the player route's capture group.
  test('routeGroup reads the key the route captured', () => {
    vi.stubGlobal('mtPlayer', {
      videoMetadata: { '70196253': { title: 'Breaking Bad' }, '80057281': { title: 'Other' } },
    });
    expect(readStatePath(['mtPlayer', 'videoMetadata', { routeGroup: 1 }], [], ROUTE)).toEqual({
      title: 'Breaking Bad',
    });
    // no such group: nothing to read
    expect(readStatePath(['mtPlayer', 'videoMetadata', { routeGroup: 2 }], [], ROUTE)).toBeNull();
  });

  // { find: { key, routeGroup } }: the first array element whose value at key equals that
  // group.
  test('find takes the first element whose value at key equals the group', () => {
    vi.stubGlobal('mtSeasons', {
      seasons: [
        { seq: 1, episodes: [{ id: 70196252 }, { id: 70196253 }] },
        { seq: 2, episodes: [{ id: 70196253 }] },
      ],
    });
    const out = readStatePath(
      [
        'mtSeasons',
        'seasons',
        { find: { key: ['episodes', '*', 'id'], routeGroup: 1 } },
        { pick: ['seq'] },
      ],
      [],
      ROUTE,
    );
    expect(out).toEqual({ seq: 1 });
  });

  // At most 256 elements of any array are examined.
  test('find examines at most 256 elements of an array', () => {
    const at = (index: number) =>
      Array.from({ length: 300 }, (_, i) => ({ id: i === index ? '70196253' : `x${String(i)}` }));
    vi.stubGlobal('mtFind', { early: at(255), late: at(256) });
    const path = (name: string): StatePath => [
      'mtFind',
      name,
      { find: { key: ['id'], routeGroup: 1 } },
    ];
    expect(readStatePath(path('early'), [], ROUTE)).toEqual({ id: '70196253' });
    expect(readStatePath(path('late'), [], ROUTE)).toBeNull();
  });

  // At most 256 elements of any array and 4,096 in all are examined.
  test('find examines at most 4,096 elements in all', () => {
    const seasons = (match: number) =>
      Array.from({ length: 20 }, (_, s) => ({
        seq: s + 1,
        episodes: Array.from({ length: 250 }, (_, e) => ({
          id: s * 250 + e === match ? 70196253 : -1,
        })),
      }));
    // within: season 10 (index 9), its first episode — 9 × (1 + 250) + 2 examined
    // beyond: season 18 (index 17), its first episode — past 4,096 examined
    vi.stubGlobal('mtShow', { within: seasons(9 * 250), beyond: seasons(17 * 250) });
    const path = (name: string): StatePath => [
      'mtShow',
      name,
      { find: { key: ['episodes', '*', 'id'], routeGroup: 1 } },
      { pick: ['seq'] },
    ];
    expect(readStatePath(path('within'), [], ROUTE)).toEqual({ seq: 10 });
    expect(readStatePath(path('beyond'), [], ROUTE)).toBeNull();
  });

  // { pick: [...] }: a final projection, the last step only.
  test('pick keeps only the named properties, and only as the last step', () => {
    vi.stubGlobal('mtVideo', {
      video: { title: 'Arrival', year: 2016, profileName: 'Alice', nested: { a: 1 } },
    });
    expect(readStatePath(['mtVideo', 'video', { pick: ['title', 'year'] }], [])).toEqual({
      title: 'Arrival',
      year: 2016,
    });
    expect(readStatePath(['mtVideo', { pick: ['video'] }, 'video'], [])).toBeNull();
  });
});

describe('a hostile page (every property is read once, inside try)', () => {
  test('a throwing getter is survived: its key is left out, the rest kept', () => {
    const state = { title: 'Breaking Bad' };
    Object.defineProperty(state, 'trap', {
      enumerable: true,
      get() {
        throw new Error('no');
      },
    });
    vi.stubGlobal('mtTrap', { state });
    expect(readStatePath(['mtTrap', 'state'], [])).toEqual({ title: 'Breaking Bad' });
  });

  test('a throwing getter on the path returns null', () => {
    const holder = {};
    Object.defineProperty(holder, 'state', {
      get() {
        throw new Error('no');
      },
    });
    vi.stubGlobal('mtTrap2', holder);
    expect(readStatePath(['mtTrap2', 'state', 'x'], [])).toBeNull();
  });

  test('a proxy whose every trap throws is survived', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('get');
        },
        ownKeys() {
          throw new Error('keys');
        },
        has() {
          throw new Error('has');
        },
        getPrototypeOf() {
          throw new Error('proto');
        },
        getOwnPropertyDescriptor() {
          throw new Error('descriptor');
        },
      },
    );
    vi.stubGlobal('mtProxy', { hostile, ok: 1 });
    expect(() => readStatePath(['mtProxy', 'hostile'], [])).not.toThrow();
    expect(() => readStatePath(['mtProxy'], [])).not.toThrow();
    expect(() => readStatePath(['mtProxy', 'hostile', 'deeper'], [])).not.toThrow();
    expect(readStatePath(['mtProxy', 'hostile', 'deeper'], [])).toBeNull();
  });

  test('a throwing toJSON is never called, and the data is cloned', () => {
    const toJSON = vi.fn(() => {
      throw new Error('toJSON');
    });
    vi.stubGlobal('mtJson', { video: { title: 'Arrival', toJSON } });
    const out = readStatePath(['mtJson', 'video'], []);
    expect(out).toEqual({ title: 'Arrival' });
    expect(toJSON).not.toHaveBeenCalled();
  });

  test('a page that replaced JSON.stringify is not called on', () => {
    const stringify = vi.spyOn(JSON, 'stringify');
    vi.stubGlobal('mtPlain', { video: { title: 'Arrival' } });
    readStatePath(['mtPlain', 'video'], []);
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
  });
});

describe('self-contained (no imports, no closures)', () => {
  // Chrome serialises the function's source into the page: it must run from that alone.
  test('its source alone, run in a fresh global, follows the Netflix path', () => {
    const getState = () => ({ videoPlayer: { title: 'Breaking Bad' } });
    const page = { netflix: { appContext: { state: { playerApp: { getState } } } } };
    const source = `(${readStatePath.toString()})(path, calls, groups)`;
    const args = { path: NETFLIX_PATH, calls: ['getState'], groups: [] };
    const out: unknown = runInNewContext(source, { ...page, ...args });
    expect(JSON.parse(JSON.stringify(out))).toEqual({ title: 'Breaking Bad' });
  });
});

// ── property-based ─────────────────────────────────────────────────────────────────────────

/** A description of a page value, materialised into a real object graph by `build`. */
type Shape =
  | { readonly t: 'prim'; readonly v: unknown }
  | { readonly t: 'huge'; readonly n: number }
  | { readonly t: 'arr'; readonly items: readonly Shape[] }
  | { readonly t: 'obj'; readonly entries: readonly (readonly [string, Shape])[] }
  | { readonly t: 'getterThrows' }
  | { readonly t: 'proxy'; readonly inner: Shape }
  | { readonly t: 'toJSON'; readonly inner: Shape }
  | { readonly t: 'fn'; readonly name: string }
  | { readonly t: 'cycle' };

const KEYS = [
  'a',
  'b',
  'state',
  'videoPlayer',
  'id',
  'episodes',
  'seasons',
  'title',
  '__proto__',
  'constructor',
  '0',
  '1',
];
const CALLS = ['getState', 'reload', 'fetchAll', 'reset'];

const shape: fc.Arbitrary<Shape> = fc.letrec<{ shape: Shape }>((tie) => ({
  shape: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc
      .oneof(
        fc.string({ maxLength: 30 }),
        fc.double(),
        fc.integer(),
        fc.boolean(),
        fc.constant(null),
        fc.constant(undefined),
        fc.bigInt(),
        fc.constant(Symbol('s')),
        fc.constantFrom('70196253', 70196253),
      )
      .map((v): Shape => ({ t: 'prim', v })),
    fc.integer({ min: 1, max: 200_000 }).map((n): Shape => ({ t: 'huge', n })),
    fc.array(tie('shape'), { maxLength: 6 }).map((items): Shape => ({ t: 'arr', items })),
    fc
      .array(fc.tuple(fc.constantFrom(...KEYS), tie('shape')), { maxLength: 6 })
      .map((entries): Shape => ({ t: 'obj', entries })),
    fc.constant<Shape>({ t: 'getterThrows' }),
    tie('shape').map((inner): Shape => ({ t: 'proxy', inner })),
    tie('shape').map((inner): Shape => ({ t: 'toJSON', inner })),
    fc.constantFrom(...CALLS).map((name): Shape => ({ t: 'fn', name })),
    fc.constant<Shape>({ t: 'cycle' }),
  ),
})).shape;

interface Probes {
  readonly invoked: string[];
  toJSONCalls: number;
}

function build(s: Shape, probes: Probes, ancestors: unknown[]): unknown {
  switch (s.t) {
    case 'prim':
      return s.v;
    case 'huge':
      return 'h'.repeat(s.n);
    case 'arr': {
      const out: unknown[] = [];
      ancestors.push(out);
      for (const item of s.items) out.push(build(item, probes, ancestors));
      ancestors.pop();
      return out;
    }
    case 'obj': {
      const out: Record<string, unknown> = {};
      ancestors.push(out);
      for (const [key, value] of s.entries) {
        Object.defineProperty(out, key, {
          value: build(value, probes, ancestors),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      ancestors.pop();
      return out;
    }
    case 'getterThrows': {
      const out = {};
      Object.defineProperty(out, 'trap', {
        enumerable: true,
        get() {
          throw new Error('getter');
        },
      });
      return out;
    }
    case 'proxy': {
      const inner = build(s.inner, probes, ancestors);
      const target = typeof inner === 'object' && inner !== null ? inner : {};
      return new Proxy(target, {
        get(t, key) {
          if (key === 'boom') throw new Error('boom');
          return Reflect.get(t, key) as unknown;
        },
        ownKeys() {
          throw new Error('ownKeys');
        },
      });
    }
    case 'toJSON': {
      const inner = build(s.inner, probes, ancestors);
      return {
        inner,
        toJSON() {
          probes.toJSONCalls += 1;
          throw new Error('toJSON');
        },
      };
    }
    case 'fn': {
      const name = s.name;
      const fn = function (this: unknown) {
        probes.invoked.push(name);
        return { state: { videoPlayer: { title: 'called' } } };
      };
      return { [name]: fn };
    }
    case 'cycle':
      return ancestors[0] ?? null;
  }
}

const step = fc.oneof(
  fc.constantFrom(...KEYS),
  fc.constantFrom(...CALLS).map((call) => ({ call })),
  fc.integer({ min: 0, max: 4 }).map((routeGroup) => ({ routeGroup })),
  fc
    .record({
      key: fc.array(fc.constantFrom('id', '*', 'episodes', 'a'), { minLength: 1, maxLength: 4 }),
      routeGroup: fc.integer({ min: 0, max: 3 }),
    })
    .map((find) => ({ find })),
  fc.array(fc.constantFrom(...KEYS), { minLength: 1, maxLength: 4 }).map((pick) => ({ pick })),
);

const pathArb = fc.array(step, { maxLength: 7 }).map((steps): StatePath => ['mtPage', ...steps]);

const groupsArb = fc.array(
  fc.oneof(fc.constantFrom('70196253', 'a', 'id', ''), fc.constant(null)),
  { maxLength: 4 },
);

describe('readStatePath on arbitrary pages (property-based)', () => {
  test('never throws; its answer is JSON, at most 32 KB, at most 6 deep; no call outside the allowlist runs; no toJSON runs', () => {
    fc.assert(
      fc.property(shape, pathArb, fc.subarray(CALLS), groupsArb, (s, path, allowed, groups) => {
        const probes: Probes = { invoked: [], toJSONCalls: 0 };
        vi.stubGlobal('mtPage', build(s, probes, []));
        let out: unknown;
        expect(() => {
          out = readStatePath(path, allowed, groups);
        }).not.toThrow();
        const text = JSON.stringify(out);
        expect(typeof text).toBe('string');
        expect(JSON.parse(text)).toEqual(out);
        expect(text.length).toBeLessThanOrEqual(MAX_JSON);
        expect(depthOf(out)).toBeLessThanOrEqual(6);
        for (const name of probes.invoked) expect(allowed).toContain(name);
        expect(probes.toJSONCalls).toBe(0);
        vi.unstubAllGlobals();
      }),
      RUNS,
    );
  });

  // A page built along the path, so every step can be taken: a call outside the allowlist is
  // never invoked, and a path whose calls are all allowed is walked to its end.
  test('along a walkable path, only allow-listed calls run, and every allowed one does', () => {
    const walk = fc.array(
      fc.oneof(
        fc.constantFrom('a', 'state', 'videoPlayer', 'x1').map((key) => ({ key })),
        fc.constantFrom(...CALLS).map((call) => ({ call })),
      ),
      { minLength: 1, maxLength: 8 },
    );
    fc.assert(
      fc.property(walk, fc.subarray(CALLS), (steps, allowed) => {
        const invoked: string[] = [];
        let next: unknown = { end: 'reached' };
        for (let i = steps.length - 1; i >= 0; i -= 1) {
          const s = steps[i];
          const inner = next;
          if (s !== undefined && 'key' in s) next = { [s.key]: inner };
          else if (s !== undefined) {
            const name = s.call;
            next = {
              [name]() {
                invoked.push(name);
                return inner;
              },
            };
          }
        }
        vi.stubGlobal('mtWalk', next);
        const path: StatePath = [
          'mtWalk',
          ...steps.map((s) => ('key' in s ? s.key : { call: s.call })),
        ];
        const out = readStatePath(path, allowed);
        for (const name of invoked) expect(allowed).toContain(name);
        const calls = steps.flatMap((s) => ('call' in s ? [s.call] : []));
        const walkable = calls.every((name) => allowed.includes(name));
        expect(out).toEqual(walkable ? { end: 'reached' } : null);
        if (walkable) expect(invoked).toEqual(calls);
        vi.unstubAllGlobals();
      }),
      RUNS,
    );
  });

  // Depth is at most 6: any nesting comes back at most 6 deep, and one within 6 whole
  test('nested values come back at most 6 deep, and whole when within 6', () => {
    const nested = fc.record({
      depth: fc.integer({ min: 1, max: 12 }),
      arrays: fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
      leaf: fc.oneof(fc.string({ maxLength: 8 }), fc.integer(), fc.boolean(), fc.constant(null)),
    });
    fc.assert(
      fc.property(nested, ({ depth, arrays, leaf }) => {
        let value: unknown = leaf;
        for (let d = depth - 1; d >= 0; d -= 1) {
          value = arrays[d] === true ? [value, 1] : { k: value, n: 1 };
        }
        vi.stubGlobal('mtNest', { value });
        const out = readStatePath(['mtNest', 'value'], []);
        expect(depthOf(out)).toBeLessThanOrEqual(6);
        if (depth <= 6) expect(out).toEqual(value);
        vi.unstubAllGlobals();
      }),
      RUNS,
    );
  });

  // The bound on find: it examines at most 256 elements of any array and 4,096 in all — and
  // finds the first match within those bounds
  test('find examines at most 256 elements per array and 4,096 in all, and finds what lies within', () => {
    const arb = fc.record({
      outer: fc.integer({ min: 0, max: 600 }),
      inner: fc.array(fc.integer({ min: 0, max: 600 }), { minLength: 1, maxLength: 8 }),
      nested: fc.boolean(),
      matchOuter: fc.integer({ min: 0, max: 700 }),
      matchInner: fc.integer({ min: 0, max: 700 }),
    });
    fc.assert(
      fc.property(arb, ({ outer, inner, nested, matchOuter, matchInner }) => {
        const reads = new Map<object, number>();
        let total = 0;
        const counted = <T extends object>(array: T): T => {
          const proxy = new Proxy(array, {
            get(target, key) {
              if (typeof key === 'string' && /^\d+$/u.test(key)) {
                reads.set(proxy, (reads.get(proxy) ?? 0) + 1);
                total += 1;
              }
              return Reflect.get(target, key) as unknown;
            },
          });
          return proxy;
        };
        const sizes = Array.from({ length: outer }, (_, i) => inner[i % inner.length] ?? 0);
        const elements = sizes.map((size, i) => ({
          name: `e${String(i)}`,
          id: !nested && i === matchOuter ? 'hit' : `o${String(i)}`,
          items: counted(
            Array.from({ length: size }, (_, j) => ({
              id: nested && i === matchOuter && j === matchInner ? 'hit' : 'no',
            })),
          ),
        }));
        vi.stubGlobal('mtFindPage', { list: counted(elements) });
        const key = nested ? ['items', '*', 'id'] : ['id'];
        const out = readStatePath(
          ['mtFindPage', 'list', { find: { key, routeGroup: 1 } }, { pick: ['name'] }],
          [],
          ['/watch/hit', 'hit'],
        );
        for (const count of reads.values()) expect(count).toBeLessThanOrEqual(256);
        expect(total).toBeLessThanOrEqual(4_096);

        // The documented rule, modelled: outer elements in order, each examined; with "*", each
        // inner element in order; stop at the first match; at most 256 per array, 4,096 in all.
        let examined = 0;
        let expected: string | null = null;
        outer: for (let i = 0; i < Math.min(outer, 256); i += 1) {
          examined += 1;
          if (examined > 4_096) break;
          if (!nested) {
            if (i === matchOuter) {
              expected = `e${String(i)}`;
              break;
            }
            continue;
          }
          const size = sizes[i] ?? 0;
          for (let j = 0; j < Math.min(size, 256); j += 1) {
            examined += 1;
            if (examined > 4_096) break outer;
            if (i === matchOuter && j === matchInner) {
              expected = `e${String(i)}`;
              break outer;
            }
          }
        }
        expect(out).toEqual(expected === null ? null : { name: expected });
        vi.unstubAllGlobals();
      }),
      { ...RUNS, numRuns: 200 },
    );
  });
});
