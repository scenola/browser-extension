/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { normalizeTitle as coreNormalizeTitle, parseEpisodeLabel as coreParse } from '@mt/core';
import { describe, expect, it } from 'vitest';

import { field, jsonAt, normalizeTitle, parseEpisodeLabel } from './helpers';
import {
  ALLOWED_CALL_NAMES,
  MAX_ROUTE_INPUT,
  ServiceDefinitionError,
  defineService,
  matchPlayerRoute,
} from './sdk';
import type { ServiceDefinition } from './sdk';

/** A state path of the shape Netflix's module uses. */
const NETFLIX_PLAYER = ['netflix', 'appContext', 'state', 'playerApp', { call: 'getState' }, 'x'];

/** An object that is not a plain one: a class instance. */
class Video {
  readonly title = 'x';
}

/** A definition that passes; each case below breaks one field of it. */
function valid(): ServiceDefinition {
  return {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    hosts: ['demo.example'],
    verified: null,
    playerRoutes: [/^\/watch\/(\d+)$/],
    collect: { selectors: { title: { css: 'h1' } } },
    interpret: () => null,
  };
}

/** Runs `defineService` on something no type allows, the way a JavaScript caller could. */
function defineLoose(value: unknown): ServiceDefinition {
  return defineService(value as ServiceDefinition);
}

function refusal(value: unknown): ServiceDefinitionError {
  try {
    defineLoose(value);
  } catch (error) {
    if (error instanceof ServiceDefinitionError) return error;
    throw new Error(`expected a ServiceDefinitionError, got ${String(error)}`);
  }
  throw new Error('expected defineService to refuse the definition');
}

function withField(patch: Record<string, unknown>): unknown {
  return { ...valid(), ...patch };
}

function withCollect(collect: unknown): unknown {
  return { ...valid(), collect };
}

describe('defineService accepts a valid definition', () => {
  it('returns it unchanged and frozen', () => {
    const definition = valid();
    const defined = defineService(definition);
    expect(defined).toBe(definition);
    expect(Object.isFrozen(defined)).toBe(true);
    expect(Object.isFrozen(defined.hosts)).toBe(true);
    expect(Object.isFrozen(defined.collect)).toBe(true);
    expect(Object.isFrozen(defined.collect.selectors?.title)).toBe(true);
    expect(Object.isFrozen(defined.playerRoutes)).toBe(true);
  });

  it('accepts every entry the collect spec has', () => {
    expect(() =>
      defineService({
        ...valid(),
        id: 'netflix',
        hosts: ['netflix.com'],
        verified: { on: '2026-10-01', by: 'maintainer' },
        playerRoutes: [/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?watch\/(\d+)/],
        collect: {
          selectors: {
            title: { css: '[data-uia="video-title"]', attr: 'data-uia', visibleOnly: false },
            episode: { css: '[data-uia="video-title"] span', max: 5 },
          },
          jsonLd: true,
          mediaSession: true,
          openGraph: true,
          queryParams: ['trackId'],
          pageState: { player: NETFLIX_PLAYER },
          signals: { endOfContent: '.postplay', adPlaying: '[data-uia="ad-badge"]' },
          shadowRootPlayer: true,
        },
      }),
    ).not.toThrow();
  });

  it('accepts the Apple TV route shape and Unicode property escapes', () => {
    expect(() =>
      defineService({
        ...valid(),
        playerRoutes: [
          /^\/[a-z]{2}\/(?:episode|movie)\/[^/]+\/(umc\.cmc\.[a-z0-9]+)/,
          /^\/\p{L}+$/u,
        ],
      }),
    ).not.toThrow();
  });
});

describe('defineService names the field it refuses', () => {
  it('refuses something that is not a plain object', () => {
    for (const value of [null, undefined, 'netflix', 42, [], new Video(), new Map()]) {
      expect(refusal(value).field).toBe('(definition)');
    }
  });

  it.each([
    ['a hyphen', 'apple-tv'],
    ['one letter', 'a'],
    ['upper case', 'Netflix'],
    ['a leading digit', '1tv'],
    ['32 characters', `a${'b'.repeat(31)}`],
    ['a number', 7],
  ])('refuses an id with %s', (_label, id) => {
    const error = refusal(withField({ id }));
    expect(error.field).toBe('id');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ServiceDefinitionError');
  });

  it('accepts a 31-character id, the longest the pattern allows', () => {
    expect(() => defineLoose(withField({ id: `a${'b'.repeat(30)}` }))).not.toThrow();
  });

  it.each(['', ' ', 'x'.repeat(65), 'Line\nbreak', 7])('refuses the name %j', (name) => {
    expect(refusal(withField({ name })).field).toBe('name');
  });

  it.each(['1.0', '1.0.0.0', '01.0.0', '1.0.0-beta', 'v1.0.0', '1.0.0 ', '1.5e3.0', '1234567.0.0'])(
    'refuses the version %j',
    (version) => {
      expect(refusal(withField({ version })).field).toBe('version');
    },
  );

  it.each([
    ['a URL', 'https://demo.example'],
    ['a port', 'demo.example:443'],
    ['a path', 'demo.example/watch'],
    ['a trailing dot', 'demo.example.'],
    ['upper case', 'Demo.example'],
    ['a wildcard', '*.demo.example'],
    ['a single label', 'localhost'],
    ['an IP address', '127.0.0.1'],
    ['an IDN in Unicode', 'démo.example'],
    ['an empty label', 'demo..example'],
    ['a leading hyphen', '-demo.example'],
    ['a 64-character label', `${'a'.repeat(64)}.example`],
    ['a blocked host', 'kinopoisk.ru'],
    ['a blocked suffix', 'www.youtube.com'],
    ['whitespace', ' demo.example'],
  ])('refuses a host with %s', (_label, host) => {
    expect(refusal(withField({ hosts: [host] })).field).toBe('hosts[0]');
  });

  it('refuses no hosts, a repeated host and a host inside another', () => {
    expect(refusal(withField({ hosts: [] })).field).toBe('hosts');
    expect(refusal(withField({ hosts: ['demo.example', 'demo.example'] })).field).toBe('hosts[1]');
    expect(refusal(withField({ hosts: ['demo.example', 'www.demo.example'] })).field).toBe(
      'hosts[1]',
    );
    expect(refusal(withField({ hosts: 'demo.example' })).field).toBe('hosts');
  });

  it.each([
    ['a day that does not exist', { on: '2026-02-30', by: 'maintainer' }, 'verified.on'],
    ['a date without padding', { on: '2026-1-2', by: 'maintainer' }, 'verified.on'],
    ['a timestamp', { on: '2026-10-01T00:00:00Z', by: 'maintainer' }, 'verified.on'],
    ['no verifier', { on: '2026-10-01', by: '' }, 'verified.by'],
    ['an extra key', { on: '2026-10-01', by: 'maintainer', note: 'x' }, 'verified.note'],
    ['a string', '2026-10-01', 'verified'],
  ])('refuses a verification with %s', (_label, verified, fieldName) => {
    expect(refusal(withField({ verified })).field).toBe(fieldName);
  });

  it('refuses no routes, a route that is not a RegExp and a stateful flag', () => {
    expect(refusal(withField({ playerRoutes: [] })).field).toBe('playerRoutes');
    expect(refusal(withField({ playerRoutes: ['^/watch'] })).field).toBe('playerRoutes[0]');
    expect(refusal(withField({ playerRoutes: [/^\/watch/g] })).field).toBe('playerRoutes[0]');
    expect(refusal(withField({ playerRoutes: [/^\/watch/y] })).field).toBe('playerRoutes[0]');
    // The `v` flag is ES2024; the target is ES2023, so it is built at run time.
    const unicodeSets = new RegExp('x', 'v');
    expect(refusal(withField({ playerRoutes: [/^\/watch/, unicodeSets] })).field).toBe(
      'playerRoutes[1]',
    );
  });

  it('refuses a route that would run code when matched', () => {
    class Route extends RegExp {
      override exec(): RegExpExecArray | null {
        return null;
      }
    }
    const ownExec = Object.assign(/^\/watch/, { exec: () => null });
    expect(refusal(withField({ playerRoutes: [new Route('^/watch')] })).field).toBe(
      'playerRoutes[0]',
    );
    expect(refusal(withField({ playerRoutes: [ownExec] })).field).toBe('playerRoutes[0]');
  });

  it('names the entry of a list that is an accessor', () => {
    const hosts = Object.defineProperty(['demo.example'], 0, { get: () => 'demo.example' });
    expect(refusal(withField({ hosts })).field).toBe('hosts[0]');
  });

  it.each([
    ['a repeated group with a quantifier inside', /^\/(a+)+$/],
    ['a starred group with a quantifier inside', /^\/(\d+)*$/],
    ['a repeated alternation', /^\/(a|ab)+$/],
    ['a counted group with a quantifier inside', /^\/(.*a){3}$/],
    ['a repeated optional', /^\/(a?){20}a{20}$/],
    ['three unbounded quantifiers', /^\/a+b+c+$/],
    ['a backreference', /^\/(a)\1$/],
    ['a named backreference', /^\/(?<x>a)\k<x>$/],
    ['a bound above 255', /^\/a{1,1000}$/],
    ['nine optional atoms', /^a?b?c?d?e?f?g?h?i?$/],
    ['a 257-character source', new RegExp(`^${'a'.repeat(256)}`)],
  ])('refuses a route with %s', (_label, route) => {
    expect(refusal(withField({ playerRoutes: [route] })).field).toBe('playerRoutes[0]');
  });

  it('refuses a selector of 301 characters and accepts one of 300', () => {
    const css = (length: number): string => `.${'a'.repeat(length - 1)}`;
    expect(refusal(withCollect({ selectors: { title: { css: css(301) } } })).field).toBe(
      'collect.selectors.title.css',
    );
    const longest = withCollect({ selectors: { title: { css: css(300) } } });
    expect(() => defineLoose(longest)).not.toThrow();
  });

  it('refuses an empty selector, a control character and a long signal selector', () => {
    expect(refusal(withCollect({ selectors: { title: { css: ' ' } } })).field).toBe(
      'collect.selectors.title.css',
    );
    expect(refusal(withCollect({ selectors: { title: { css: 'h1\u0000' } } })).field).toBe(
      'collect.selectors.title.css',
    );
    expect(refusal(withCollect({ signals: { endOfContent: 'a'.repeat(301) } })).field).toBe(
      'collect.signals.endOfContent',
    );
    expect(refusal(withCollect({ signals: { credits: '.x' } })).field).toBe(
      'collect.signals.credits',
    );
  });

  it.each([0, 6, 2.5, -1, Number.NaN, '5'])('refuses max %j', (max) => {
    expect(refusal(withCollect({ selectors: { title: { css: 'h1', max } } })).field).toBe(
      'collect.selectors.title.max',
    );
  });

  it('refuses a bad attribute, a bad visibleOnly and an extra key on a selector', () => {
    const attribute = withCollect({ selectors: { title: { css: 'h1', attr: 'on click' } } });
    expect(refusal(attribute).field).toBe('collect.selectors.title.attr');
    expect(
      refusal(withCollect({ selectors: { title: { css: 'h1', visibleOnly: 'yes' } } })).field,
    ).toBe('collect.selectors.title.visibleOnly');
    expect(refusal(withCollect({ selectors: { title: { css: 'h1', html: true } } })).field).toBe(
      'collect.selectors.title.html',
    );
  });

  it('refuses a selector name that is not an identifier, and too many selectors', () => {
    expect(refusal(withCollect({ selectors: { '1title': { css: 'h1' } } })).field).toBe(
      'collect.selectors.1title',
    );
    const many = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`s${String(i)}`, { css: 'h1' }]),
    );
    expect(refusal(withCollect({ selectors: many })).field).toBe('collect.selectors');
  });

  it.each([
    ['a call name that is not an identifier', ['netflix', { call: 'get-State' }], 'player[1].call'],
    ['an empty call name', ['netflix', { call: '' }], 'player[1].call'],
    ['a call not listed for the module', ['netflix', { call: 'reload' }], 'player[1].call'],
    ['a call with arguments', ['netflix', { call: 'getState', args: [1] }], 'player[1].args'],
    ['a call first, on the global object', [{ call: 'getState' }], 'player[0]'],
    ['an empty property', ['netflix', ''], 'player[1]'],
    ['a prototype step', ['netflix', '__proto__'], 'player[1]'],
    ['a constructor step', ['netflix', 'constructor'], 'player[1]'],
    ['a number step', ['netflix', 0], 'player[1]'],
    ['a 129-character property', ['netflix', 'a'.repeat(129)], 'player[1]'],
    ['no steps', [], 'player'],
    ['seventeen steps', Array.from({ length: 17 }, () => 'a'), 'player'],
  ])('refuses a state path with %s', (_label, path, suffix) => {
    const definition = {
      ...valid(),
      id: 'netflix',
      hosts: ['netflix.com'],
      collect: { pageState: { player: path } },
    };
    expect(refusal(definition).field).toBe(`collect.pageState.${suffix}`);
  });

  it('refuses a call for a module the allowlist does not name, even one named after a prototype key', () => {
    for (const id of ['demo', 'constructor']) {
      const definition = {
        ...valid(),
        id,
        collect: { pageState: { player: ['netflix', { call: 'getState' }] } },
      };
      expect(refusal(definition).field).toBe('collect.pageState.player[1].call');
    }
  });

  it('refuses a page-state name that is not an identifier, and too many paths', () => {
    expect(refusal(withCollect({ pageState: { 'my player': ['a'] } })).field).toBe(
      'collect.pageState.my player',
    );
    const many = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`p${String(i)}`, ['a']]));
    expect(refusal(withCollect({ pageState: many })).field).toBe('collect.pageState');
  });

  it('refuses bad query parameters', () => {
    expect(refusal(withCollect({ queryParams: ['a b'] })).field).toBe('collect.queryParams[0]');
    expect(refusal(withCollect({ queryParams: ['v', 'v'] })).field).toBe('collect.queryParams[1]');
    const nine = Array.from({ length: 9 }, (_, i) => `p${String(i)}`);
    expect(refusal(withCollect({ queryParams: nine })).field).toBe('collect.queryParams');
  });

  it('refuses a flag that is not exactly true', () => {
    for (const key of ['jsonLd', 'mediaSession', 'openGraph', 'shadowRootPlayer']) {
      expect(refusal(withCollect({ [key]: false })).field).toBe(`collect.${key}`);
    }
  });

  it('refuses an unknown key at every level', () => {
    expect(refusal(withField({ fetch: () => null })).field).toBe('fetch');
    expect(refusal(withCollect({ scripts: ['x.js'] })).field).toBe('collect.scripts');
    expect(refusal(withField({ collect: null })).field).toBe('collect');
  });

  it('refuses an interpret that is not a function', () => {
    expect(refusal(withField({ interpret: 'return null' })).field).toBe('interpret');
  });

  it('refuses an accessor, without running it', () => {
    let ran = false;
    const definition = Object.defineProperty({ ...valid() }, 'name', {
      enumerable: true,
      get: () => {
        ran = true;
        return 'Demo';
      },
    });
    expect(refusal(definition).field).toBe('name');
    expect(ran).toBe(false);
  });

  it('carries the service id in the message when it has one', () => {
    expect(refusal(withField({ version: 'x' })).message).toBe(
      'service definition demo: version must be MAJOR.MINOR.PATCH',
    );
  });
});

describe('ALLOWED_CALL_NAMES', () => {
  it('lists identifiers only', () => {
    for (const names of Object.values(ALLOWED_CALL_NAMES)) {
      for (const name of names) expect(name).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/);
    }
  });

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(ALLOWED_CALL_NAMES)).toBe(true);
    for (const names of Object.values(ALLOWED_CALL_NAMES)) {
      expect(Object.isFrozen(names)).toBe(true);
    }
  });
});

describe('matchPlayerRoute', () => {
  const routes = [/^\/watch\/(\d+)$/, /^\/title\/(\d+)$/];

  it('answers the first route that matches', () => {
    expect(matchPlayerRoute(routes, '/title/42')?.[1]).toBe('42');
    expect(matchPlayerRoute(routes, '/browse')).toBeNull();
  });

  it('never runs a route on more than 2,048 characters', () => {
    const atLimit = `/watch/${'1'.repeat(MAX_ROUTE_INPUT - '/watch/'.length)}`;
    expect(atLimit).toHaveLength(2048);
    expect(matchPlayerRoute(routes, atLimit)).not.toBeNull();
    expect(matchPlayerRoute(routes, `${atLimit}1`)).toBeNull();
  });
});

describe('helpers', () => {
  it('re-exports the core label grammar and title normalisation', () => {
    expect(parseEpisodeLabel).toBe(coreParse);
    expect(normalizeTitle).toBe(coreNormalizeTitle);
  });

  it('builds a module field', () => {
    expect(field('Dune', 0.8)).toEqual({ value: 'Dune', confidence: 0.8, source: 'module' });
    expect(field(2, 0)).toEqual({ value: 2, confidence: 0, source: 'module' });
    expect(field(2, 1)).toEqual({ value: 2, confidence: 1, source: 'module' });
  });

  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses confidence %d',
    (confidence) => {
      expect(() => field('x', confidence)).toThrow(RangeError);
    },
  );

  it('reads own data of plain objects and arrays along a path', () => {
    const state = JSON.parse(
      '{"videos":{"80057281":{"title":"Dune","seasons":[{"n":1}]}},"__proto__":{"x":1}}',
    ) as unknown;
    expect(jsonAt(state, ['videos', '80057281', 'title'])).toBe('Dune');
    expect(jsonAt(state, ['videos', '80057281', 'seasons', 0, 'n'])).toBe(1);
    expect(jsonAt(state, ['__proto__', 'x'])).toBe(1);
    expect(jsonAt(state, [])).toBe(state);
  });

  it('answers undefined rather than reaching the prototype chain or running code', () => {
    let ran = false;
    const getter = Object.defineProperty({}, 'title', {
      enumerable: true,
      get: () => {
        ran = true;
        return 'x';
      },
    });
    expect(jsonAt({}, ['constructor'])).toBeUndefined();
    expect(jsonAt({}, ['toString'])).toBeUndefined();
    expect(jsonAt([1, 2], ['length'])).toBeUndefined();
    expect(jsonAt([1, 2], ['constructor'])).toBeUndefined();
    expect(jsonAt([1, 2], [2])).toBeUndefined();
    expect(jsonAt([1, 2], [-1])).toBeUndefined();
    expect(jsonAt({ a: 1 }, [0])).toBeUndefined();
    expect(jsonAt(getter, ['title'])).toBeUndefined();
    expect(ran).toBe(false);
    expect(jsonAt(new Video(), ['title'])).toBeUndefined();
    expect(jsonAt(new Map([['title', 'x']]), ['title'])).toBeUndefined();
    expect(jsonAt('Dune', [0])).toBeUndefined();
    expect(jsonAt(null, ['a'])).toBeUndefined();
  });

  it('reads a null-prototype object and refuses a path longer than 16 keys', () => {
    const bare = Object.assign(Object.create(null) as object, { title: 'Dune' });
    expect(jsonAt(bare, ['title'])).toBe('Dune');
    let deep: unknown = 'bottom';
    for (let i = 0; i < 17; i += 1) deep = { a: deep };
    const keys = (count: number): string[] => Array.from({ length: count }, () => 'a');
    expect(jsonAt(deep, keys(16))).toEqual({ a: 'bottom' });
    expect(jsonAt(deep, keys(17))).toBeUndefined();
  });
});
