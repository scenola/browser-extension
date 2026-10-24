/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  BUILT_IN_SITES,
  RegistryError,
  allBuiltInHosts,
  defineSites,
  modulesForBuild,
  selectForBuild,
  siteForHost,
} from './registry';
import type { BuiltInSite } from './registry';
import { ALLOWED_CALL_NAMES, defineService } from './sdk';
import type { ServiceDefinition, Snapshot } from './sdk';

const SERVICES_DIR = join(import.meta.dirname, 'services');

function demoModule(
  id: string,
  hosts: readonly string[],
  verified: ServiceDefinition['verified'],
): ServiceDefinition {
  return defineService({
    id,
    name: id,
    version: '1.0.0',
    hosts,
    verified,
    playerRoutes: [/^\/watch\/(\d+)$/],
    collect: {},
    interpret: () => null,
  });
}

describe('BUILT_IN_SITES', () => {
  it('lists the seven built-in sites, by their permanent ids', () => {
    expect(BUILT_IN_SITES.map((site) => site.id)).toEqual([
      'netflix',
      'apple_tv',
      'prime_video',
      'disney_plus',
      'hbo_max',
      'crunchyroll',
      'paramount_plus',
    ]);
  });

  it('gives each site the hosts its service plays on', () => {
    expect(Object.fromEntries(BUILT_IN_SITES.map((site) => [site.id, site.hosts]))).toEqual({
      netflix: ['netflix.com'],
      apple_tv: ['tv.apple.com'],
      prime_video: ['primevideo.com'],
      disney_plus: ['disneyplus.com'],
      hbo_max: ['hbomax.com'],
      crunchyroll: ['crunchyroll.com'],
      paramount_plus: ['paramountplus.com'],
    });
  });

  it('names each service the way it is called', () => {
    expect(BUILT_IN_SITES.map((site) => site.name)).toEqual([
      'Netflix',
      'Apple TV',
      'Prime Video',
      'Disney+',
      'HBO Max',
      'Crunchyroll',
      'Paramount+',
    ]);
  });

  it('has unique ids and unique hosts, and no host inside another', () => {
    const ids = BUILT_IN_SITES.map((site) => site.id);
    expect(new Set(ids).size).toBe(ids.length);
    const hosts = BUILT_IN_SITES.flatMap((site) => site.hosts);
    expect(new Set(hosts).size).toBe(hosts.length);
    for (const a of hosts) {
      for (const b of hosts) {
        if (a !== b) expect(b.endsWith(`.${a}`)).toBe(false);
      }
    }
  });

  it('attaches a module only under its own id and hosts', () => {
    for (const site of BUILT_IN_SITES) {
      if (site.module === null) continue;
      expect(site.module.id).toBe(site.id);
      expect([...site.module.hosts].sort()).toEqual([...site.hosts].sort());
    }
  });

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(BUILT_IN_SITES)).toBe(true);
    for (const site of BUILT_IN_SITES) {
      expect(Object.isFrozen(site)).toBe(true);
      expect(Object.isFrozen(site.hosts)).toBe(true);
    }
  });
});

describe('siteForHost', () => {
  it.each([
    ['www.netflix.com', 'netflix'],
    ['netflix.com', 'netflix'],
    ['tv.apple.com', 'apple_tv'],
    ['www.primevideo.com', 'prime_video'],
    ['www.disneyplus.com', 'disney_plus'],
    ['play.hbomax.com', 'hbo_max'],
    ['static.crunchyroll.com', 'crunchyroll'],
    ['www.paramountplus.com', 'paramount_plus'],
  ])('finds %s as %s', (host, id) => {
    expect(siteForHost(host)?.id).toBe(id);
  });

  it.each([
    ['a lookalike suffix', 'netflix.com.evil.example'],
    ['a name that only ends the same', 'evilnetflix.com'],
    ['another top-level domain', 'netflix.co'],
    ['the parent of a listed subdomain', 'apple.com'],
    ['a sibling of a listed subdomain', 'www.apple.com'],
    ['a retired domain that only redirects', 'play.max.com'],
    ['a shop that is not the service', 'www.amazon.com'],
    ['a URL', 'https://www.netflix.com/watch/70196253'],
    ['a port', 'www.netflix.com:443'],
    ['a trailing dot', 'www.netflix.com.'],
    ['upper case', 'WWW.NETFLIX.COM'],
    ['a Cyrillic letter', 'www.nеtflix.com'],
    ['an IDN in Unicode', 'www.netflíx.com'],
    ['an IDN in punycode', 'www.xn--netflx-yta.com'],
    ['a path', 'www.netflix.com/'],
    ['credentials', 'user@www.netflix.com'],
    ['leading whitespace', ' www.netflix.com'],
    ['a trailing newline', 'www.netflix.com\n'],
    ['an empty label', 'www..netflix.com'],
    ['a leading dot', '.netflix.com'],
    ['nothing', ''],
    ['a host over 253 characters', `${'a.'.repeat(124)}www.netflix.com`],
  ])('answers null for %s', (_label, host) => {
    expect(siteForHost(host)).toBeNull();
  });

  it('answers null for a value that is not a string', () => {
    for (const value of [null, undefined, 42, { toString: () => 'netflix.com' }]) {
      expect(siteForHost(value as unknown as string)).toBeNull();
    }
  });
});

describe('allBuiltInHosts', () => {
  it('lists every site host once, in registry order', () => {
    expect(allBuiltInHosts()).toEqual([
      'netflix.com',
      'tv.apple.com',
      'primevideo.com',
      'disneyplus.com',
      'hbomax.com',
      'crunchyroll.com',
      'paramountplus.com',
    ]);
    expect(Object.isFrozen(allBuiltInHosts())).toBe(true);
  });
});

describe('defineSites', () => {
  const site = (id: string, hosts: readonly string[], module: ServiceDefinition | null = null) =>
    ({ id, name: id, hosts, module }) satisfies BuiltInSite;

  it('accepts the shape the registry uses', () => {
    expect(defineSites([site('demo', ['demo.example'])])).toHaveLength(1);
  });

  it.each([
    ['a repeated id', [site('demo', ['a.example']), site('demo', ['b.example'])]],
    ['an id with a hyphen', [site('de-mo', ['a.example'])]],
    ['a repeated host', [site('one', ['a.example']), site('two', ['a.example'])]],
    ['a host inside another site', [site('one', ['a.example']), site('two', ['tv.a.example'])]],
    ['a host inside the same site', [site('one', ['a.example', 'www.a.example'])]],
    ['a site without hosts', [site('one', [])]],
    ['a host that is not a bare domain', [site('one', ['https://a.example'])]],
    ['a blocked host', [site('one', ['example.ru'])]],
    ['an empty name', [{ id: 'one', name: ' ', hosts: ['a.example'], module: null }]],
    [
      'a module of another id',
      [site('one', ['a.example'], demoModule('two', ['a.example'], null))],
    ],
    [
      'a module with other hosts',
      [site('one', ['a.example'], demoModule('one', ['b.example'], null))],
    ],
  ])('refuses %s', (_label, sites) => {
    expect(() => defineSites(sites)).toThrow(RegistryError);
  });
});

describe('modulesForBuild and selectForBuild', () => {
  const unverified = demoModule('unverified', ['a.example'], null);
  const stale = demoModule('stale', ['b.example'], { on: '2026-07-01', by: 'maintainer' });
  const fresh = demoModule('fresh', ['c.example'], { on: '2026-10-01', by: 'maintainer' });
  const modules = [unverified, stale, fresh];

  it('keeps, for a store build, only modules verified within 90 days', () => {
    expect(selectForBuild(modules, 'store', '2026-10-21')).toEqual([fresh]);
  });

  it('keeps every module for a development build', () => {
    expect(selectForBuild(modules, 'development', '2026-10-21')).toEqual(modules);
  });

  it('counts 90 days on UTC calendar dates, inclusive', () => {
    const at = (on: string) => [demoModule('mod', ['m.example'], { on, by: 'maintainer' })];
    expect(selectForBuild(at('2026-07-23'), 'store', '2026-10-21')).toHaveLength(1);
    expect(selectForBuild(at('2026-07-22'), 'store', '2026-10-21')).toHaveLength(0);
    expect(selectForBuild(at('2026-10-21'), 'store', '2026-10-21')).toHaveLength(1);
    expect(selectForBuild(at('2025-12-31'), 'store', '2026-03-31')).toHaveLength(1);
    expect(selectForBuild(at('2028-02-29'), 'store', '2028-05-29')).toHaveLength(1);
  });

  it('does not move with the local time zone across a daylight-saving change', () => {
    const before = process.env.TZ;
    // Each zone's offset on the two dates, in minutes, as `getTimezoneOffset` gives it: the
    // window crosses a change in every one, and checking it proves the zone took effect.
    // London's change moves local midnight across the UTC day boundary, which is what
    // catches a count made from local dates.
    const zones: readonly (readonly [string, number, number])[] = [
      ['Europe/London', 0, -60],
      ['Europe/Berlin', -60, -120],
      ['America/New_York', 300, 240],
      ['Pacific/Chatham', -825, -765],
    ];
    try {
      for (const [zone, march, may] of zones) {
        process.env.TZ = zone;
        expect(new Date(2026, 2, 1, 12).getTimezoneOffset()).toBe(march);
        expect(new Date(2026, 4, 30, 12).getTimezoneOffset()).toBe(may);
        const at = [demoModule('mod', ['m.example'], { on: '2026-03-01', by: 'maintainer' })];
        expect(selectForBuild(at, 'store', '2026-05-30')).toHaveLength(1);
        expect(selectForBuild(at, 'store', '2026-05-31')).toHaveLength(0);
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it('excludes a verification dated after today', () => {
    const future = [demoModule('mod', ['m.example'], { on: '2026-10-22', by: 'maintainer' })];
    expect(selectForBuild(future, 'store', '2026-10-21')).toEqual([]);
    expect(selectForBuild(future, 'development', '2026-10-21')).toEqual(future);
  });

  it.each(['2026-10-21T00:00:00Z', '2026-13-01', '2026-02-30', '21-10-2026', '', '2026-1-1'])(
    'refuses today = %j',
    (today) => {
      expect(() => selectForBuild(modules, 'store', today)).toThrow(RegistryError);
      expect(() => modulesForBuild('development', today)).toThrow(RegistryError);
    },
  );

  it('refuses a mode it does not know', () => {
    const mode = 'e2e' as unknown as 'store';
    expect(() => modulesForBuild(mode, '2026-10-21')).toThrow(RegistryError);
  });

  it('answers the attached modules of the registry', () => {
    const attached = BUILT_IN_SITES.flatMap((site) => (site.module === null ? [] : [site.module]));
    expect(modulesForBuild('development', '2026-10-21')).toEqual(attached);
  });
});

describe('ALLOWED_CALL_NAMES against the registry', () => {
  const callsOf = (module: ServiceDefinition): string[] =>
    Object.values(module.collect.pageState ?? {}).flatMap((path) =>
      path.flatMap((step) => (typeof step !== 'string' && 'call' in step ? [step.call] : [])),
    );

  it('names only built-in sites', () => {
    const ids = new Set(BUILT_IN_SITES.map((site) => site.id));
    for (const id of Object.keys(ALLOWED_CALL_NAMES)) expect(ids.has(id)).toBe(true);
  });

  it('lists, for an attached module, exactly the calls its state paths make', () => {
    for (const site of BUILT_IN_SITES) {
      if (site.module === null) continue;
      const listed = Object.hasOwn(ALLOWED_CALL_NAMES, site.id) ? ALLOWED_CALL_NAMES[site.id] : [];
      expect([...new Set(callsOf(site.module))].sort()).toEqual([...(listed ?? [])].sort());
    }
  });
});

/** The kinds a module's readings name, each of which needs a fixture. */
const KINDS_READ = ['movie', 'episode'] as const;

/**
 * What a module folder must hold beside its definition: a README; fixtures in the
 * `{ synthetic, snapshot }` shape; with `module`, at least one fixture the module
 * reads as a film and one it reads as an episode; and a test that loads every fixture and is no
 * longer the scaffold's deliberate failure. (That the test passes is the suite's own result;
 * the version bump when a fixture changes is `pnpm module-versions:check`.)
 */
function folderProblems(dir: string, module?: ServiceDefinition): string[] {
  const problems: string[] = [];
  if (!existsSync(join(dir, 'definition.ts'))) problems.push('definition.ts missing');
  if (!existsSync(join(dir, 'README.md'))) problems.push('README.md missing');
  const fixtures = join(dir, 'fixtures');
  const snapshots = existsSync(fixtures)
    ? readdirSync(fixtures).filter((name) => name.endsWith('.snapshot.json'))
    : [];
  if (snapshots.length === 0) problems.push('no fixtures/*.snapshot.json');

  const kinds = new Set<string>();
  for (const name of snapshots) {
    const read = fixtureKind(join(fixtures, name), module);
    if (typeof read === 'string') kinds.add(read);
    else if (read !== null) problems.push(`${name}: ${read.problem}`);
  }
  if (module !== undefined) {
    for (const kind of KINDS_READ) {
      if (!kinds.has(kind)) problems.push(`no fixture the module reads as kind ${kind}`);
    }
  }
  return [...problems, ...testProblems(join(dir, 'definition.test.ts'), snapshots)];
}

/**
 * The kind `module` reads from a fixture (`null` without a module or a kind), or what is wrong
 * with the fixture: not JSON, not `{ synthetic, snapshot }`, or a snapshot `interpret` throws on.
 */
function fixtureKind(
  path: string,
  module: ServiceDefinition | undefined,
): string | null | { readonly problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { problem: 'not JSON' };
  }
  const shape = parsed as { synthetic?: unknown; snapshot?: unknown } | null;
  if (
    typeof shape?.synthetic !== 'boolean' ||
    typeof shape.snapshot !== 'object' ||
    shape.snapshot === null
  ) {
    return { problem: 'not { synthetic, snapshot }' };
  }
  if (module === undefined) return null;
  try {
    return module.interpret(shape.snapshot as Snapshot)?.kind?.value ?? null;
  } catch {
    return { problem: 'interpret throws' };
  }
}

/** What is wrong with a module's test: missing, a fixture it does not load, the scaffold's fail. */
function testProblems(testFile: string, snapshots: readonly string[]): string[] {
  if (!existsSync(testFile)) return ['definition.test.ts missing'];
  const test = readFileSync(testFile, 'utf8');
  const problems = snapshots
    .filter((name) => !test.includes(`fixtures/${name}`))
    .map((name) => `definition.test.ts does not load fixtures/${name}`);
  if (/\bexpect\.fail\(/u.test(test)) {
    problems.push('definition.test.ts still holds the scaffold’s deliberate failure');
  }
  return problems;
}

describe('module folders', () => {
  const sandboxes: string[] = [];
  afterAll(() => {
    for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
  });

  it('holds a README, fixtures of both kinds and a loading test beside every attached module', () => {
    for (const site of BUILT_IN_SITES) {
      if (site.module === null) continue;
      const problems = folderProblems(join(SERVICES_DIR, site.id), site.module);
      expect({ id: site.id, problems }).toEqual({ id: site.id, problems: [] });
    }
  });

  it('reports a folder that lacks them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-module-folder-'));
    sandboxes.push(dir);
    expect(folderProblems(dir)).toEqual([
      'definition.ts missing',
      'README.md missing',
      'no fixtures/*.snapshot.json',
      'definition.test.ts missing',
    ]);
    writeFileSync(join(dir, 'definition.ts'), '');
    writeFileSync(join(dir, 'README.md'), '');
    writeFileSync(join(dir, 'definition.test.ts'), "load('fixtures/episode.snapshot.json');");
    mkdirSync(join(dir, 'fixtures'));
    writeFileSync(
      join(dir, 'fixtures', 'episode.snapshot.json'),
      JSON.stringify({ synthetic: true, snapshot: { kind: 'episode' } }),
    );
    expect(folderProblems(dir)).toEqual([]);
  });

  describe('against a module (a fixture per kind, a test that loads each)', () => {
    /** A module reading a snapshot's own `kind` field, so a fixture states what it is a sample of. */
    const reads = (): ServiceDefinition =>
      defineService({
        id: 'probe',
        name: 'Probe',
        version: '1.0.0',
        hosts: ['probe.example'],
        verified: null,
        playerRoutes: [/^\/watch\//u],
        collect: {},
        interpret: (snapshot) => {
          const kind = (snapshot as unknown as { kind?: string }).kind;
          return kind === 'movie' || kind === 'episode'
            ? { kind: { value: kind, confidence: 0.9, source: 'module' as const } }
            : null;
        },
      });

    function folder(fixtures: Readonly<Record<string, string>>, test: string): string {
      const dir = mkdtempSync(join(tmpdir(), 'mt-module-folder-'));
      sandboxes.push(dir);
      writeFileSync(join(dir, 'definition.ts'), '');
      writeFileSync(join(dir, 'README.md'), '');
      writeFileSync(join(dir, 'definition.test.ts'), test);
      mkdirSync(join(dir, 'fixtures'));
      for (const [name, text] of Object.entries(fixtures)) {
        writeFileSync(join(dir, 'fixtures', name), text);
      }
      return dir;
    }
    const sample = (kind: string): string =>
      JSON.stringify({ synthetic: true, snapshot: { kind } });
    const LOADS_BOTH = "'fixtures/film.snapshot.json' 'fixtures/episode.snapshot.json'";

    it('accepts a film fixture, an episode fixture and a test that loads both', () => {
      const dir = folder(
        { 'film.snapshot.json': sample('movie'), 'episode.snapshot.json': sample('episode') },
        LOADS_BOTH,
      );
      expect(folderProblems(dir, reads())).toEqual([]);
    });

    it('refuses a module with no fixture it reads as a film', () => {
      const dir = folder(
        { 'film.snapshot.json': sample('episode'), 'episode.snapshot.json': sample('episode') },
        LOADS_BOTH,
      );
      expect(folderProblems(dir, reads())).toEqual(['no fixture the module reads as kind movie']);
    });

    it('refuses a module with no fixture it reads as an episode', () => {
      const dir = folder(
        { 'film.snapshot.json': sample('movie') },
        "'fixtures/film.snapshot.json'",
      );
      expect(folderProblems(dir, reads())).toEqual(['no fixture the module reads as kind episode']);
    });

    it('refuses a fixture that is not { synthetic, snapshot }', () => {
      const dir = folder(
        {
          'film.snapshot.json': sample('movie'),
          'episode.snapshot.json': sample('episode'),
          'bad.snapshot.json': '{}',
          'broken.snapshot.json': '{',
        },
        `${LOADS_BOTH} 'fixtures/bad.snapshot.json' 'fixtures/broken.snapshot.json'`,
      );
      expect(folderProblems(dir, reads()).sort()).toEqual([
        'bad.snapshot.json: not { synthetic, snapshot }',
        'broken.snapshot.json: not JSON',
      ]);
    });

    it('refuses a fixture its test never loads', () => {
      const dir = folder(
        { 'film.snapshot.json': sample('movie'), 'episode.snapshot.json': sample('episode') },
        "'fixtures/film.snapshot.json'",
      );
      expect(folderProblems(dir, reads())).toEqual([
        'definition.test.ts does not load fixtures/episode.snapshot.json',
      ]);
    });

    it('refuses a test that is still the scaffold’s deliberate failure', () => {
      const dir = folder(
        { 'film.snapshot.json': sample('movie'), 'episode.snapshot.json': sample('episode') },
        `${LOADS_BOTH} expect.fail('Capture a film')`,
      );
      expect(folderProblems(dir, reads())).toEqual([
        'definition.test.ts still holds the scaffold’s deliberate failure',
      ]);
    });
  });
});
