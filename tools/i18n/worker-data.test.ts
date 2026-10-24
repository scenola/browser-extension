/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The worker's words are data, the pages' are functions, and both come from one compiler walk:
// rendering the data must give exactly what the compiled function gives, for every kind of ICU element, every message on disk and every value a parameter takes.
// And the files the build writes for the worker carry what they should: a translation's core
// keys, the pseudo-locale's only when asked.

import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { isDataCatalog, render } from '../../apps/extension/src/i18n/data.ts';
import type { DataCatalog, WordNode } from '../../apps/extension/src/i18n/data.ts';
import { catalog as pseudoCatalog } from '../../apps/extension/src/i18n/generated/en-XA.ts';
import { catalog as englishCatalog } from '../../apps/extension/src/i18n/generated/en.ts';
import {
  PSEUDO_LOCALE,
  SOURCE_WORDS,
  WORKER_TRANSLATIONS,
} from '../../apps/extension/src/i18n/generated/worker.ts';
import { createFormatter } from '../../apps/extension/src/i18n/runtime.ts';
import type { Formatter, Params } from '../../apps/extension/src/i18n/runtime.ts';
import { readCatalogs, readCoreKeys, workerFiles } from './compile';
import { compileData, compileMessage } from './icu';

type Message = (p: Params, f: Formatter) => string;

const compiled = (locale: string, message: string): Message =>
  runInNewContext(`(${compileMessage(locale, 'test.key', message)})`) as Message;

/** Every value a parameter is tried with: plural categories, offsets, a date, select keys. */
const VALUES: readonly (string | number)[] = [
  0,
  1,
  2,
  3,
  5,
  11,
  21,
  22,
  101,
  1.5,
  -1,
  1_792_687_194_000,
  'x',
  'female',
  'male',
  '',
];

function names(nodes: readonly WordNode[], into = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (typeof node === 'string') continue;
    into.add(node[1]);
    if (node[0] === 'p') for (const branch of Object.values(node[4])) names(branch, into);
    if (node[0] === 'x') for (const branch of Object.values(node[2])) names(branch, into);
  }
  return into;
}

/** One parameter set per value, every name given it, plus none at all. */
function paramSets(nodes: readonly WordNode[]): Params[] {
  const all = [...names(nodes)];
  return [{}, ...VALUES.map((value) => Object.fromEntries(all.map((name) => [name, value])))];
}

const CORPUS: readonly (readonly [string, string])[] = [
  ['en', ''],
  ['en', 'Plain text'],
  ['en', 'Hello, {name}!'],
  ['en', '{n, number} · {n, number, integer} · {n, number, percent}'],
  ['en', '{d, date, short} {d, date, full} {d, time, short} {d, time, medium}'],
  ['en', '{count, plural, =0 {none} one {# item} other {# items}}'],
  ['en', '{count, plural, offset:1 =0 {nobody} one {you} other {you and # others}}'],
  ['en', '{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}'],
  ['en', '{g, select, female {she} male {he} other {they}} came'],
  ['en', '{a, plural, one {{b, select, x {X #} other {O #}}} other {{b} and #}}'],
  ['pl', '{count, plural, one {# film} few {# filmy} many {# filmów} other {# filmu}}'],
  ['ar', '{n, plural, zero {٠} one {١} two {٢} few {قليل #} many {كثير #} other {# آخر}}'],
];

function sameEverywhere(locale: string, message: string, data: readonly WordNode[]): void {
  const fn = compiled(locale, message);
  const f = createFormatter(locale);
  for (const p of paramSets(data)) expect(render(data, p, f)).toBe(fn(p, f));
}

describe('rendering the data gives what the compiled function gives', () => {
  it.each(CORPUS)('%s: %s', (locale, message) => {
    sameEverywhere(locale, message, compileData(locale, 'test.key', message));
  });

  it('for every message of every catalog on disk', async () => {
    for (const [locale, messages] of await readCatalogs()) {
      for (const [key, message] of Object.entries(messages)) {
        sameEverywhere(locale, message, compileData(locale, key, message));
      }
    }
  });

  it("the worker's bundled English is English's catalog for core's keys, word for word", async () => {
    const core = await readCoreKeys();
    const english = (await readCatalogs()).get('en') ?? {};
    expect(Object.keys(SOURCE_WORDS.messages).sort()).toEqual(
      [...core].filter((key) => Object.hasOwn(english, key)).sort(),
    );
    const f = createFormatter('en');
    for (const [key, nodes] of Object.entries(SOURCE_WORDS.messages)) {
      const fn = englishCatalog.messages[key];
      expect(fn).toBeDefined();
      for (const p of paramSets(nodes)) expect(render(nodes, p, f)).toBe(fn?.(p, f));
    }
  });

  it("the pseudo-locale's worker file says what its page catalog says", async () => {
    const files = workerFiles(await readCatalogs(), await readCoreKeys(), { pseudo: true });
    const data = JSON.parse(files.get(`i18n/${PSEUDO_LOCALE}.json`) ?? 'null') as DataCatalog;
    expect(isDataCatalog(data, PSEUDO_LOCALE)).toBe(true);
    expect(Object.keys(data.messages).sort()).toEqual(Object.keys(SOURCE_WORDS.messages).sort());
    const f = createFormatter(PSEUDO_LOCALE);
    for (const [key, nodes] of Object.entries(data.messages)) {
      const fn = pseudoCatalog.messages[key];
      for (const p of paramSets(nodes)) expect(render(nodes, p, f)).toBe(fn?.(p, f));
    }
  });
});

describe('the worker files a build writes', () => {
  const en = {
    'manifest.extName': '{extension}',
    'status.idle': '{product} — nothing playing',
    'status.waiting': '{count, plural, one {# viewing} other {# viewings}}',
    'popup.title': 'Now playing',
  };
  const de = { 'status.idle': '{product} — nichts läuft', 'popup.title': 'Jetzt läuft' };
  const catalogs = new Map([
    ['en', en],
    ['de', de],
  ]);
  const core = new Set(['status.idle', 'status.waiting']);

  it("one per translation, core's keys only, the ones it has; English is bundled instead", () => {
    const files = workerFiles(catalogs, core, { pseudo: false });
    expect([...files.keys()]).toEqual(['i18n/de.json']);
    const data: unknown = JSON.parse(files.get('i18n/de.json') ?? 'null');
    expect(isDataCatalog(data, 'de')).toBe(true);
    expect(data).toEqual({
      locale: 'de',
      messages: { 'status.idle': [['s', 'product'], ' — nichts läuft'] },
    });
  });

  it('the pseudo-locale only when asked: a development build', () => {
    expect([...workerFiles(catalogs, core, { pseudo: true }).keys()]).toEqual([
      'i18n/de.json',
      `i18n/${PSEUDO_LOCALE}.json`,
    ]);
  });

  it('names the locales it writes in the generated module the worker reads', async () => {
    const files = workerFiles(await readCatalogs(), await readCoreKeys(), { pseudo: false });
    expect([...files.keys()]).toEqual(WORKER_TRANSLATIONS.map((l) => `i18n/${l}.json`));
  });
});
