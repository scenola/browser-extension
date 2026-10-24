/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import {
  EPISODE_NUMBER_MAX,
  MAX_PROVIDER_ENTRIES,
  MAX_SECONDS,
  MAX_TITLE_CODE_POINTS,
  SEASON_NUMBER_MAX,
  isImdbId,
  isProviderKey,
  isProviderNamespace,
  isProviderValue,
  isYear,
} from '../../packages/core/src/domain/play';

// Core writes the wire's bounds by hand (`packages/core/src/domain/play.ts`), so that a value
// the server would refuse never leaves a viewing as a 422. The committed OpenAPI subset is the
// server's own statement of them. This gate holds the two together; `pnpm openapi:check` keeps
// the subset equal to the backend's document.

const SUBSET_FILE = fileURLToPath(new URL('../openapi/openapi.subset.json', import.meta.url));

type Json = Readonly<Record<string, unknown>>;

const isJson = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `value` at `path`, which must be objects all the way: a reshaped document fails loudly. */
function at(value: unknown, ...path: string[]): Json {
  let here: unknown = value;
  for (const key of path) {
    here = isJson(here) ? here[key] : undefined;
    if (!isJson(here)) throw new TypeError(`the subset has no object at ${path.join('.')}`);
  }
  if (!isJson(here)) throw new TypeError('the subset is not an object');
  return here;
}

/** A field's schema without its `null` branch (`anyOf: [{…}, {type: 'null'}]`). */
function nonNull(schema: Json): Json {
  const anyOf = schema.anyOf;
  if (!Array.isArray(anyOf)) return schema;
  const kept = anyOf.filter((s): s is Json => isJson(s) && s.type !== 'null');
  const only = kept[0];
  if (kept.length !== 1 || only === undefined) {
    throw new TypeError('a field with more than one non-null branch');
  }
  return only;
}

/** Every one-character string of ASCII, a few beyond it, and each beside a valid first letter. */
const CHARACTERS = [
  ...Array.from({ length: 0x80 }, (_, i) => String.fromCharCode(i)),
  ' ',
  'é',
  'ł',
  '€',
  '１',
  '😀',
];

/** Strings that tell two string rules apart, at the schema's length bound and past it. */
function stringProbes(maxLength: number): string[] {
  return [
    '',
    ...CHARACTERS,
    ...CHARACTERS.map((c) => `a${c}`),
    ...CHARACTERS.map((c) => `${c}a`),
    'aB',
    'a'.repeat(maxLength),
    'a'.repeat(maxLength + 1),
    `${'a'.repeat(maxLength - 1)}"`,
  ];
}

const IMDB_PROBES = [
  ...Array.from({ length: 9 }, (_, i) => `tt${'1'.repeat(i + 3)}`),
  'TT12345',
  'tt12345a',
  'xtt12345',
  ' tt12345',
  'tt12345\n',
  'tt１２３４５',
  'nm1234567',
];

/** What the schema of one string field accepts: its lengths (in code points) and its pattern. */
function schemaAccepts(schema: Json): (s: string) => boolean {
  const pattern = typeof schema.pattern === 'string' ? new RegExp(schema.pattern, 'u') : null;
  const min = typeof schema.minLength === 'number' ? schema.minLength : 0;
  const max = typeof schema.maxLength === 'number' ? schema.maxLength : Number.POSITIVE_INFINITY;
  return (s) => {
    const length = Array.from(s).length;
    return length >= min && length <= max && (pattern === null || pattern.test(s));
  };
}

/**
 * Where core's hand-written wire bounds and the subset's schemas disagree, one message per
 * bound (none when they agree). Throws when the subset is no longer shaped as read here.
 */
function wireBoundDrift(subset: unknown): string[] {
  const drift: string[] = [];
  const schemas = at(subset, 'components', 'schemas');
  const field = (schema: string, name: string): Json =>
    nonNull(at(schemas, schema, 'properties', name));
  const numbers = (where: string, schema: Json, core: Readonly<Record<string, number>>): void => {
    for (const [bound, value] of Object.entries(core)) {
      if (schema[bound] !== value) {
        drift.push(
          `${where}.${bound}: the wire says ${String(schema[bound])}, core ${String(value)}`,
        );
      }
    }
  };
  const strings = (
    where: string,
    schema: Json,
    core: (s: string) => boolean,
    probes: readonly string[],
  ): void => {
    const wire = schemaAccepts(schema);
    const differ = probes.filter((s) => core(s) !== wire(s));
    const first = differ[0];
    if (first !== undefined) {
      drift.push(`${where}: core and the wire differ on ${JSON.stringify(first)}`);
    }
  };
  const years = (where: string, schema: Json): void => {
    const { minimum, maximum } = schema;
    if (typeof minimum !== 'number' || typeof maximum !== 'number') {
      drift.push(`${where}: the wire states no range`);
      return;
    }
    const agrees =
      isYear(minimum) && !isYear(minimum - 1) && isYear(maximum) && !isYear(maximum + 1);
    if (!agrees) drift.push(`${where}: the wire says ${String(minimum)}–${String(maximum)}`);
  };

  for (const schema of ['PlayEvidence', 'ShowEvidence']) {
    // `clampTitle` trims and clamps to the bound; an empty title is left out.
    numbers(`${schema}.title`, field(schema, 'title'), {
      minLength: 1,
      maxLength: MAX_TITLE_CODE_POINTS,
    });
    years(`${schema}.year`, field(schema, 'year'));
  }
  // TMDB numbers its specials season 0 (`inRange`); a duration is at least a second.
  numbers('PlayEvidence.season_number', field('PlayEvidence', 'season_number'), {
    minimum: 0,
    maximum: SEASON_NUMBER_MAX,
  });
  numbers('PlayEvidence.episode_number', field('PlayEvidence', 'episode_number'), {
    minimum: 0,
    maximum: EPISODE_NUMBER_MAX,
  });
  numbers('PlayEvidence.duration_seconds', field('PlayEvidence', 'duration_seconds'), {
    minimum: 1,
    maximum: MAX_SECONDS,
  });
  numbers(
    'PlayEvidence.furthest_position_seconds',
    field('PlayEvidence', 'furthest_position_seconds'),
    { minimum: 0, maximum: MAX_SECONDS },
  );
  numbers('EvidenceIds.provider', field('EvidenceIds', 'provider'), {
    maxItems: MAX_PROVIDER_ENTRIES,
  });
  strings('EvidenceIds.imdb', field('EvidenceIds', 'imdb'), isImdbId, IMDB_PROBES);
  for (const [name, core] of [
    ['namespace', isProviderNamespace],
    ['key', isProviderKey],
    ['value', isProviderValue],
  ] as const) {
    const schema = field('ProviderEvidence', name);
    const max = typeof schema.maxLength === 'number' ? schema.maxLength : 0;
    strings(`ProviderEvidence.${name}`, schema, core, stringProbes(max));
  }
  return drift;
}

async function committedSubset(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(SUBSET_FILE, 'utf8')) as Record<string, unknown>;
}

/** The committed subset with one schema property replaced. */
async function withField(
  schema: string,
  name: string,
  edit: (field: Record<string, unknown>) => void,
): Promise<unknown> {
  const subset = structuredClone(await committedSubset());
  const property = at(subset, 'components', 'schemas', schema, 'properties', name);
  edit(nonNull(property));
  return subset;
}

describe('core’s wire bounds and the OpenAPI subset', () => {
  test('agree: title, numbers, seconds, years, provider entries and the IMDb id', async () => {
    expect(wireBoundDrift(await committedSubset())).toEqual([]);
  });

  test.each<[string, string, string, (field: Record<string, unknown>) => void]>([
    ['a title bound', 'PlayEvidence', 'title', (f) => (f.maxLength = 199)],
    ['a show title bound', 'ShowEvidence', 'title', (f) => (f.maxLength = 300)],
    ['a season bound', 'PlayEvidence', 'season_number', (f) => (f.maximum = 9999)],
    ['an episode bound', 'PlayEvidence', 'episode_number', (f) => (f.minimum = 1)],
    ['a seconds bound', 'PlayEvidence', 'duration_seconds', (f) => (f.maximum = 86_400)],
    ['a position bound', 'PlayEvidence', 'furthest_position_seconds', (f) => (f.maximum = 1)],
    ['a year range', 'PlayEvidence', 'year', (f) => (f.minimum = 1888)],
    ['a show year range', 'ShowEvidence', 'year', (f) => (f.maximum = 2100)],
    ['the provider entry cap', 'EvidenceIds', 'provider', (f) => (f.maxItems = 16)],
    ['the IMDb pattern', 'EvidenceIds', 'imdb', (f) => (f.pattern = '^tt[0-9]{5,9}$')],
    [
      'a namespace that may start with a digit',
      'ProviderEvidence',
      'namespace',
      (f) => (f.pattern = '^[a-z0-9][a-z0-9._-]*$'),
    ],
    ['a key length', 'ProviderEvidence', 'key', (f) => (f.maxLength = 65)],
    [
      'a value that may hold a backslash',
      'ProviderEvidence',
      'value',
      (f) => (f.pattern = '^[ !#-~]+$'),
    ],
  ])('fires on %s', async (_name, schema, field, edit) => {
    const drift = wireBoundDrift(await withField(schema, field, edit));
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain(`${schema}.${field}`);
  });

  test('a subset no longer shaped as read here fails loudly', async () => {
    const subset = structuredClone(await committedSubset());
    const schemas = at(subset, 'components', 'schemas') as Record<string, unknown>;
    delete schemas.ProviderEvidence;
    expect(() => wireBoundDrift(subset)).toThrow(TypeError);
  });
});
