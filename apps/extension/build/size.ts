/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The size budgets, as size-limit checks over what each surface really loads (`.size-limit.ts`).
// A size-limit entry that names a page's own chunk counts 5 KB of a popup that loads 35: the
// chunks the pages share are most of it. So a page's check is its closure — the HTML, every
// script and stylesheet it names, and every module those import, statically, to the end — plus,
// of the catalogs it may `import()` on demand, the largest, since a UI language loads one. The
// worker's is its bundle plus the largest of the catalog files it may read (`i18n/*.json`).
// Fonts are assets, not code, and are not counted.

import { readFile, readdir } from 'node:fs/promises';
import { basename, join, posix, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

import { PSEUDO_LOCALE, WEB_LOCALES } from '../../../tools/i18n/locales-map.ts';

export interface SizeCheck {
  readonly name: string;
  /** The files counted, relative to the size-limit configuration's directory. */
  readonly path: readonly string[];
  readonly gzip: true;
  readonly limit: string;
}

/**
 * The budgets, by surface. The worker's is the loosest: it is parsed once per wake-up, not on
 * every page, and its real limit is the cold start the end-to-end suite times.
 */
const BUDGETS = {
  bootstrap: '2 KB',
  collector: '20 KB',
  background: '75 KB',
  popup: '45 KB',
  sandbox: '40 KB',
} as const;

/** Longest first, so `en-XA-<hash>.js` is the pseudo-locale's and not English's. */
const LOCALES: readonly string[] = [...WEB_LOCALES, PSEUDO_LOCALE].sort(
  (a, b) => b.length - a.length,
);

const STATIC_IMPORT =
  /\b(?:import|export)\s*(?:[\w$*{}\s,]*?\s*from\s*)?["'`](\.{1,2}\/[^"'`]+)["'`]/gu;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["'`](\.{1,2}\/[^"'`]+)["'`]\s*\)/gu;
const HTML_REFERENCE = /\b(?:src|href)\s*=\s*"([^"]+\.(?:js|css))"/gu;

/** The locale a chunk is the catalog of, from its name (`chunks/<locale>-<hash>.js`), if any. */
function catalogLocale(file: string): string | null {
  const name = basename(file);
  return LOCALES.find((locale) => name.startsWith(`${locale}-`) && name.endsWith('.js')) ?? null;
}

interface Closure {
  /** Every file loaded whatever the language: the page's own and its static imports. */
  readonly always: ReadonlySet<string>;
  /** The catalogs it may load, one at a time. */
  readonly catalogs: ReadonlySet<string>;
}

/** A path inside the build, `/`-separated, from a reference relative to `from` (or the root). */
function resolveIn(from: string | null, reference: string): string {
  const path = reference.startsWith('/')
    ? reference.slice(1)
    : posix.join(from === null ? '' : posix.dirname(from), reference);
  return posix.normalize(path);
}

async function closureOf(root: string, entries: readonly string[]): Promise<Closure> {
  const always = new Set<string>();
  const catalogs = new Set<string>();
  const queue = [...entries];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (always.has(file)) continue;
    always.add(file);
    if (!file.endsWith('.js')) continue;
    const text = await readFile(join(root, file), 'utf8');
    for (const [, reference] of text.matchAll(STATIC_IMPORT)) {
      if (reference !== undefined) queue.push(resolveIn(file, reference));
    }
    for (const [, reference] of text.matchAll(DYNAMIC_IMPORT)) {
      if (reference === undefined) continue;
      const target = resolveIn(file, reference);
      const locale = catalogLocale(target);
      if (locale === null) {
        // Anything else loaded on demand may be loaded with everything else: counted.
        queue.push(target);
        continue;
      }
      const catalog = await readFile(join(root, target), 'utf8');
      if (!new RegExp(`locale:\\s*["'\`]${locale}["'\`]`, 'u').test(catalog)) {
        throw new Error(`${target} is named for ${locale} but is not its catalog`);
      }
      catalogs.add(target);
    }
  }
  return { always, catalogs };
}

/** What size-limit measures: gzip at level 9. */
async function gzipSize(path: string): Promise<number> {
  return gzipSync(await readFile(path), { level: 9 }).length;
}

/** The largest of `files` gzipped (what size-limit measures), or none. */
async function largest(root: string, files: Iterable<string>): Promise<string[]> {
  let best: { file: string; size: number } | null = null;
  for (const file of [...files].sort()) {
    const size = await gzipSize(join(root, file));
    if (best === null || size > best.size) best = { file, size };
  }
  return best === null ? [] : [best.file];
}

/** The files a page loads, its largest catalog included, relative to the build's root. */
export async function pageFiles(root: string, html: string): Promise<readonly string[]> {
  const text = await readFile(join(root, html), 'utf8');
  const named = [...text.matchAll(HTML_REFERENCE)]
    .map(([, reference]) => reference)
    .filter(
      (reference): reference is string => reference !== undefined && !/^[a-z]+:/u.test(reference),
    )
    .map((reference) => resolveIn(html, reference));
  const { always, catalogs } = await closureOf(root, named);
  return [html, ...[...always].sort(), ...(await largest(root, catalogs))];
}

/** The worker's bundle and the largest catalog file it may read. */
async function workerFiles(root: string): Promise<readonly string[]> {
  const catalogs = await readdir(join(root, 'i18n')).catch(() => [] as string[]);
  const files = catalogs.filter((name) => name.endsWith('.json')).map((name) => `i18n/${name}`);
  return ['background.js', ...(await largest(root, files))];
}

/** The size-limit checks for the build at `outDir`, its paths relative to `configDir`. */
export async function sizeChecks(outDir: string, configDir: string): Promise<SizeCheck[]> {
  const relativeTo = (file: string): string =>
    relative(configDir, join(outDir, file)).split(sep).join('/');
  const check = (name: keyof typeof BUDGETS, files: readonly string[]): SizeCheck => ({
    name,
    path: files.map(relativeTo),
    gzip: true,
    limit: BUDGETS[name],
  });
  return [
    check('bootstrap', ['bootstrap.js']),
    check('collector', ['collector.js']),
    check('background', await workerFiles(outDir)),
    check('popup', await pageFiles(outDir, 'popup.html')),
    check('sandbox', await pageFiles(outDir, 'sandbox.html')),
  ];
}
