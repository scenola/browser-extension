/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The three state-path steps — `{ routeGroup: n }`, `{ find: { key,
// routeGroup } }` and `{ pick: [...] }` — in the SDK's types and in `defineService`'s validation.
// The bounds: a route group 1–9; a find key of 1–8
// property names or "*"; a pick of 1–16 distinct property names, the last step only; a path of
// 1–16 steps that starts with a property; property names 1–128 characters, never `__proto__`,
// `prototype` or `constructor`; unknown keys and accessors refused, an accessor never run.

import { describe, expect, it } from 'vitest';

import { ServiceDefinitionError, defineService } from './sdk';
import type { ServiceDefinition, StatePath, StatePathStep } from './sdk';

// ---------------------------------------------------------------------------------------------
// The types (checked by `pnpm typecheck`)

/** Netflix's shape: every step kind in one path. */
const EVERY_STEP: StatePath = [
  'netflix',
  { call: 'getState' },
  'videoMetadata',
  { routeGroup: 1 },
  'seasons',
  { find: { key: ['episodes', '*', 'id'], routeGroup: 1 } },
  'episodes',
  { find: { key: ['id'], routeGroup: 1 } },
  { pick: ['id', 'seq', 'title'] },
];

// @ts-expect-error -- a route group names a capture group by its number, not a string
const groupAsText: StatePathStep = { routeGroup: '1' };
// @ts-expect-error -- a find needs the route group it compares with
const findWithoutGroup: StatePathStep = { find: { key: ['id'] } };
// @ts-expect-error -- a find key is a list of property names
const findKeyAsText: StatePathStep = { find: { key: 'id', routeGroup: 1 } };
// @ts-expect-error -- a pick keeps property names
const pickNumbers: StatePathStep = { pick: [1, 2] };

// ---------------------------------------------------------------------------------------------
// defineService

/** A definition that passes, with its page state replaced by `path` (as JavaScript could). */
function withPath(path: unknown): ServiceDefinition {
  return {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    hosts: ['demo.example'],
    verified: null,
    playerRoutes: [/^\/watch\/(\d+)$/u],
    collect: { pageState: { video: path as StatePath } },
    interpret: () => null,
  };
}

function refusal(path: unknown): ServiceDefinitionError {
  try {
    defineService(withPath(path));
  } catch (error) {
    if (error instanceof ServiceDefinitionError) return error;
    throw new TypeError(`expected a ServiceDefinitionError, got ${String(error)}`);
  }
  throw new TypeError('expected defineService to refuse the path');
}

/** The first fault throws a ServiceDefinitionError naming the field. */
const refusesThePath = (path: unknown): void => {
  expect(refusal(path).field.startsWith('collect.pageState.video')).toBe(true);
};

const names = (n: number): string[] => Array.from({ length: n }, (_, i) => `k${String(i)}`);

describe('the three bounded steps are accepted', () => {
  it.each([
    ['a route group', ['root', { routeGroup: 1 }]],
    ['the highest route group, 9', ['root', { routeGroup: 9 }]],
    [
      'a find by a nested key with "*"',
      ['root', { find: { key: ['episodes', '*', 'id'], routeGroup: 1 } }],
    ],
    ['a find key of 8 names', ['root', { find: { key: names(8), routeGroup: 2 } }]],
    ['a pick as the last step', ['root', 'video', { pick: ['type', 'id'] }]],
    ['a pick of 16 names', ['root', { pick: names(16) }]],
    [
      'a route group, a find and a pick together',
      ['root', { routeGroup: 1 }, { find: { key: ['id'], routeGroup: 1 } }, { pick: ['id'] }],
    ],
  ] as const)('%s', (_label, path) => {
    expect(() => defineService(withPath(path))).not.toThrow();
  });

  it("Netflix's own path, with its call, is a valid definition's", () => {
    const netflix = { ...withPath(EVERY_STEP), id: 'netflix', hosts: ['netflix.com'] };
    expect(() => defineService(netflix)).not.toThrow();
  });

  it('the type rejections above are compile-time only', () => {
    // They exist for `pnpm typecheck`; at run time defineService refuses them too.
    for (const step of [groupAsText, findWithoutGroup, findKeyAsText, pickNumbers]) {
      refusesThePath(['root', step]);
    }
  });
});

describe('the steps are bounded', () => {
  it.each([
    ['route group 0', { routeGroup: 0 }],
    ['route group 10', { routeGroup: 10 }],
    ['a negative route group', { routeGroup: -1 }],
    ['a fractional route group', { routeGroup: 1.5 }],
    ['a route group that is not a number', { routeGroup: '1' }],
    ['a route group of NaN', { routeGroup: Number.NaN }],
    ['a route group of Infinity', { routeGroup: Number.POSITIVE_INFINITY }],
    ['a find with no key', { find: { key: [], routeGroup: 1 } }],
    ['a find key of 9 names', { find: { key: names(9), routeGroup: 1 } }],
    ['a find key that is not a list', { find: { key: 'id', routeGroup: 1 } }],
    ['a find key holding a number', { find: { key: [0], routeGroup: 1 } }],
    ['a find key holding an empty name', { find: { key: [''], routeGroup: 1 } }],
    ['a find key of 129 characters', { find: { key: ['a'.repeat(129)], routeGroup: 1 } }],
    ['a find without its route group', { find: { key: ['id'] } }],
    ['a find with route group 10', { find: { key: ['id'], routeGroup: 10 } }],
    ['a find that is not an object', { find: ['id', 1] }],
    ['an empty pick', { pick: [] }],
    ['a pick of 17 names', { pick: names(17) }],
    ['a pick that repeats a name', { pick: ['id', 'id'] }],
    ['a pick holding a number', { pick: ['id', 3] }],
    ['a pick that is not a list', { pick: 'id' }],
  ])('refuses %s', (_label, step) => {
    refusesThePath(['root', step]);
  });

  it('refuses a pick that is not the last step', () => {
    refusesThePath(['root', { pick: ['video'] }, 'id']);
  });

  it('refuses a path that starts with a route group, a find or a pick', () => {
    refusesThePath([{ routeGroup: 1 }]);
    refusesThePath([{ find: { key: ['id'], routeGroup: 1 } }, 'a']);
    refusesThePath([{ pick: ['a'] }]);
  });

  it('refuses a path of 17 steps however they are made, and accepts one of 16', () => {
    const steps = (n: number): unknown[] => [
      'root',
      ...Array.from({ length: n - 1 }, () => ({ routeGroup: 1 })),
    ];
    refusesThePath(steps(17));
    expect(() => defineService(withPath(steps(16)))).not.toThrow();
  });
});

describe('hostile step shapes are refused, never run', () => {
  it.each(['__proto__', 'prototype', 'constructor'])(
    'refuses %s in a find key and in a pick',
    (name) => {
      refusesThePath(['root', { find: { key: ['episodes', name], routeGroup: 1 } }]);
      refusesThePath(['root', { pick: ['id', name] }]);
    },
  );

  it('refuses a step that is two kinds at once', () => {
    refusesThePath(['root', { routeGroup: 1, pick: ['id'] }]);
    refusesThePath(['root', { find: { key: ['id'], routeGroup: 1 }, call: 'getState' }]);
  });

  it('refuses an unknown key beside a step and inside a find', () => {
    refusesThePath(['root', { routeGroup: 1, args: [1] }]);
    refusesThePath(['root', { find: { key: ['id'], routeGroup: 1, max: 1_000_000 } }]);
  });

  it('refuses a step of an unknown kind, an array step and a null step', () => {
    refusesThePath(['root', { index: 3 }]);
    refusesThePath(['root', ['id']]);
    refusesThePath(['root', null]);
  });

  /** A property whose value only a getter gives, and a count of how often it ran. */
  function accessor(
    target: object,
    key: PropertyKey,
    value: unknown,
  ): { readonly ran: () => number } {
    let runs = 0;
    Object.defineProperty(target, key, {
      get: () => {
        runs += 1;
        return value;
      },
      enumerable: true,
    });
    return { ran: () => runs };
  }

  it.each([
    [
      'the route group',
      () => {
        const step = {};
        return { step, ...accessor(step, 'routeGroup', 1) };
      },
    ],
    [
      "a find's route group",
      () => {
        const find = { key: ['id'] };
        return { step: { find }, ...accessor(find, 'routeGroup', 1) };
      },
    ],
    [
      'an element of a find key',
      () => {
        const key: string[] = [];
        return { step: { find: { key, routeGroup: 1 } }, ...accessor(key, 0, 'id') };
      },
    ],
    [
      'an element of a pick',
      () => {
        const pick: string[] = [];
        return { step: { pick }, ...accessor(pick, 0, 'id') };
      },
    ],
  ])('refuses an accessor as %s, without running it', (_label, make) => {
    const { step, ran } = make();
    refusesThePath(['root', step]);
    expect(ran()).toBe(0);
  });

  // A step is plain data — an object literal. A class
  // instance is refused even when its own properties would make a valid step, since its
  // prototype carries code a reader of the definition does not see.
  it('refuses a class instance as a step, a find or a pick holder, whatever it holds', () => {
    class Group {
      readonly routeGroup = 1;
    }
    class Find {
      readonly key = ['id'];
      readonly routeGroup = 1;
    }
    refusesThePath(['root', new Group()]);
    refusesThePath(['root', { find: new Find() }]);
    refusesThePath([
      'root',
      Object.assign(Object.create({ inherited: true }) as object, { routeGroup: 1 }),
    ]);
  });

  it('accepts a step with no prototype at all, which carries no code', () => {
    const step = Object.assign(Object.create(null) as object, { routeGroup: 1 });
    expect(() => defineService(withPath(['root', step]))).not.toThrow();
  });
});
