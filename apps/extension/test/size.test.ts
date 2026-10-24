/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The size budgets count what a surface loads: the size-limit entry for the popup used to name
// its own chunk and stylesheet, 5.6 KB of a popup that loads about 35 KB, because the chunks the
// pages share were never counted. Here, on a build tree written for the purpose: a page's
// closure, its largest catalog, and the worker's largest catalog file.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import { pageFiles, sizeChecks } from '../build/size.ts';

const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function folder(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mt-size-test-'));
  scratch.push(dir);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return dir;
}

/** Text that does not compress away, so "the largest" is the longest. */
const bulk = (n: number): string =>
  Array.from({ length: n }, (_, i) => ((i * 7919) % 104_729).toString(36)).join(',');

const BUILD: Readonly<Record<string, string>> = {
  'popup.html':
    '<script type="module" crossorigin src="/chunks/popup-a1.js"></script>' +
    '<link rel="modulepreload" crossorigin href="/chunks/store-b2.js">' +
    '<link rel="stylesheet" crossorigin href="/assets/store-c3.css">' +
    '<link rel="icon" href="https://example.com/x.js">',
  'chunks/popup-a1.js': 'import{t as e}from"./store-b2.js";import"./side-d4.js";e();',
  // Minified ESM as Rolldown writes it: re-exports, backticks, a lazy view, two catalogs.
  'chunks/store-b2.js':
    'export{f as t}from"./format-e5.js";' +
    'const l={de:async()=>(await import(`./de-f6.js`)).catalog,' +
    '"pt-BR":async()=>(await import("./pt-BR-g7.js")).catalog,' +
    '"en-XA":async()=>(await import("./en-XA-h8.js")).catalog};' +
    'const v=()=>import("./lazy-i9.js");',
  'chunks/format-e5.js': 'export const f=()=>1;',
  'chunks/side-d4.js': '',
  'chunks/lazy-i9.js': 'export const view=1;',
  'chunks/de-f6.js': `const e={locale:\`de\`,messages:{${bulk(50)}}};export{e as catalog}`,
  'chunks/pt-BR-g7.js': `const e={locale:"pt-BR",messages:{${bulk(400)}}};export{e as catalog}`,
  'chunks/en-XA-h8.js': `const e={locale:"en-XA",messages:{${bulk(100)}}};export{e as catalog}`,
  'chunks/options-j0.js': 'export const unused=1;',
  'assets/store-c3.css': ':root{color:red}',
  'assets/font-k1.woff2': 'not counted',
  'sandbox.html': '<script type="module" src="/chunks/sandbox-l2.js"></script>',
  'chunks/sandbox-l2.js': 'export const s=1;',
  'background.js': 'var background=(function(){})();',
  'bootstrap.js': '',
  'collector.js': '',
  'i18n/de.json': JSON.stringify({ locale: 'de', messages: { a: [bulk(30)] } }),
  'i18n/pt-BR.json': JSON.stringify({ locale: 'pt-BR', messages: { a: [bulk(300)] } }),
};

describe("a page's size counts what it loads", () => {
  test('the HTML, its scripts and styles, their static imports to the end, the largest catalog', async () => {
    const dir = await folder(BUILD);
    expect(await pageFiles(dir, 'popup.html')).toEqual([
      'popup.html',
      'assets/store-c3.css',
      'chunks/format-e5.js',
      'chunks/lazy-i9.js',
      'chunks/popup-a1.js',
      'chunks/side-d4.js',
      'chunks/store-b2.js',
      'chunks/pt-BR-g7.js',
    ]);
  });

  test('a chunk named for a locale that is not its catalog is refused', async () => {
    const dir = await folder({
      ...BUILD,
      'chunks/de-f6.js': 'export const catalog = { locale: "fr", messages: {} };',
    });
    await expect(pageFiles(dir, 'popup.html')).rejects.toThrow(/de-f6\.js is named for de/u);
  });
});

describe('the checks', () => {
  test('every surface with its budget; the worker with its largest catalog file', async () => {
    const dir = await folder(BUILD);
    const checks = await sizeChecks(dir, join(dir, '..'));
    const base = dir.split(/[\\/]/u).at(-1) ?? '';
    expect(checks.map(({ name, limit, gzip }) => [name, limit, gzip])).toEqual([
      ['bootstrap', '2 KB', true],
      ['collector', '20 KB', true],
      ['background', '75 KB', true],
      ['popup', '45 KB', true],
      ['sandbox', '40 KB', true],
    ]);
    expect(checks.find((c) => c.name === 'background')?.path).toEqual([
      `${base}/background.js`,
      `${base}/i18n/pt-BR.json`,
    ]);
    expect(checks.find((c) => c.name === 'sandbox')?.path).toEqual([
      `${base}/sandbox.html`,
      `${base}/chunks/sandbox-l2.js`,
    ]);
  });

  test('a build with no catalog files: the worker alone', async () => {
    const rest = Object.fromEntries(
      Object.entries(BUILD).filter(([name]) => !name.startsWith('i18n/')),
    );
    const dir = await folder(rest);
    const checks = await sizeChecks(dir, dir);
    expect(checks.find((c) => c.name === 'background')?.path).toEqual(['background.js']);
  });
});
