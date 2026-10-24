/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The third-party notices: every package whose code or files a build ships, with its licence's own
// text, written at the build's root as `THIRD_PARTY_NOTICES.txt` and opened from the About screen.
// The MIT, ISC and SIL Open Font licences each ask that their text travel with what they cover,
// and a minified bundle keeps no comment that could carry it.
//
// What ships is read from the bundles themselves, not from package.json: a Vite plugin records
// each module a chunk holds and each file an asset was made from, so a dependency that is only a
// tool never appears, and one that starts shipping cannot be missed. A package that publishes no
// licence file is listed with the licence, author and repository its package.json declares and,
// when that licence is MIT, with MIT's standard text under that author, since MIT's one condition
// is that its notice travel with the code. One that declares no licence at all stops the build,
// since nothing says it may ship.

import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';

import type { Plugin } from 'vite';

const NODE_MODULES = `${sep}node_modules${sep}`;
const LICENCE_FILE = /^(?:licen[cs]e|copying)(?:[.-][^/]*)?$/iu;

/**
 * Packages that ship through the stylesheet's own `@import`, which PostCSS inlines before Vite
 * sees a module: Tailwind's preflight and utilities are in every page's CSS.
 */
const STYLESHEET_PACKAGES = ['tailwindcss'];

class NoticesError extends Error {
  override readonly name = 'NoticesError';
}

/**
 * The folder of the package a file belongs to — the last `node_modules/<name>` or
 * `node_modules/@scope/name` on its path — or `null` for a file of this workspace, a virtual
 * module or anything else that is not a package's.
 */
export function packageRoot(file: string): string | null {
  if (file.startsWith('\0')) return null;
  const path = file.split('?')[0] ?? file;
  const at = path.lastIndexOf(NODE_MODULES);
  if (at === -1) return null;
  const rest = path.slice(at + NODE_MODULES.length).split(sep);
  const scoped = rest[0]?.startsWith('@') === true;
  const parts = rest.slice(0, scoped ? 2 : 1);
  if (parts.length < (scoped ? 2 : 1) || parts.some((part) => part === '')) return null;
  return path.slice(0, at + NODE_MODULES.length) + parts.join(sep);
}

/** The packages one build ships, gathered across the Vite builds WXT runs for it. */
export interface NoticesCollector {
  /** Added to every Vite build of the extension. */
  readonly plugin: Plugin;
  /** Forgets what an earlier build of this process recorded. */
  reset(): void;
  /** The package folders recorded since the last `reset`. */
  roots(): readonly string[];
}

export function noticesCollector(): NoticesCollector {
  const roots = new Set<string>();
  let base = process.cwd();
  const record = (file: string): void => {
    const root = packageRoot(resolve(base, file));
    if (root !== null) roots.add(root);
  };
  return {
    plugin: {
      name: 'mt:notices',
      apply: 'build',
      configResolved(config) {
        base = config.root;
      },
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type === 'chunk') {
            for (const id of Object.keys(output.modules)) record(id);
          } else {
            for (const name of output.originalFileNames) record(name);
          }
        }
      },
    },
    reset() {
      roots.clear();
    },
    roots() {
      const require = createRequire(join(base, 'package.json'));
      const styles = STYLESHEET_PACKAGES.map((name) =>
        dirname(require.resolve(`${name}/package.json`)),
      );
      return [...roots, ...styles];
    },
  };
}

interface Notice {
  readonly name: string;
  readonly version: string;
  /** The SPDX expression package.json declares, or `null`. */
  readonly licence: string | null;
  readonly author: string | null;
  readonly repository: string | null;
  readonly texts: readonly string[];
}

/** package.json's `author`, as a string or as `{ name, email, url }`. */
function authorOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return null;
  const { name, email } = value as { readonly name?: unknown; readonly email?: unknown };
  if (typeof name !== 'string') return null;
  return typeof email === 'string' ? `${name} <${email}>` : name;
}

/** package.json's `repository` as a web address: `git+https://…/x.git` is `https://…/x`. */
function repositoryOf(value: unknown): string | null {
  const url =
    typeof value === 'string'
      ? value
      : typeof value === 'object' && value !== null
        ? (value as { readonly url?: unknown }).url
        : undefined;
  if (typeof url !== 'string') return null;
  return url.replace(/^git\+/u, '').replace(/\.git$/u, '');
}

async function noticeOf(root: string): Promise<Notice> {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    readonly name?: unknown;
    readonly version?: unknown;
    readonly license?: unknown;
    readonly author?: unknown;
    readonly repository?: unknown;
  };
  const name = typeof manifest.name === 'string' ? manifest.name : String(root.split(sep).at(-1));
  const version = typeof manifest.version === 'string' ? manifest.version : '';
  const licence = typeof manifest.license === 'string' ? manifest.license : null;
  const files = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && LICENCE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0 && licence === null) {
    throw new NoticesError(`${name} ships in the build but declares no licence`);
  }
  const texts = await Promise.all(
    files.map(async (file) =>
      (await readFile(join(root, file), 'utf8'))
        .replace(/\r\n?/gu, '\n')
        .replace(/[ \t]+$/gmu, '')
        .trim(),
    ),
  );
  return {
    name,
    version,
    licence,
    author: authorOf(manifest.author),
    repository: repositoryOf(manifest.repository),
    texts,
  };
}

/** MIT's text after its copyright line, as the SPDX licence list gives it. */
const MIT_PERMISSION = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/**
 * The standard text of a declared licence, for a package that publishes no file of it, under the
 * copyright holder its package.json names. The year is not known, so none is given.
 */
const STANDARD_TEXTS: ReadonlyMap<string, (holder: string) => string> = new Map([
  ['MIT', (holder: string) => `MIT License\n\nCopyright (c) ${holder}\n\n${MIT_PERMISSION}`],
]);

/** What a package without a licence file is listed with, under its declared licence. */
function declaredOnly(notice: Notice): readonly string[] {
  const standard = notice.licence === null ? undefined : STANDARD_TEXTS.get(notice.licence);
  if (standard === undefined) {
    return ['The package publishes no licence file; its package.json declares the licence above.'];
  }
  return [
    'The package publishes no licence file. This is the standard text of the licence its',
    'package.json declares, under the author it names.',
    '',
    standard(notice.author ?? `the authors of ${notice.name}`),
  ];
}

function section(notice: Notice): string {
  const head = [
    RULE,
    `${notice.name} ${notice.version}`.trim(),
    `Licence: ${notice.licence ?? 'as below'}`,
    ...(notice.author === null ? [] : [`Author: ${notice.author}`]),
    ...(notice.repository === null ? [] : [`Source: ${notice.repository}`]),
    RULE,
  ];
  const body = notice.texts.length > 0 ? notice.texts : declaredOnly(notice);
  return [...head, '', ...body].join('\n');
}

const RULE = '='.repeat(78);

/**
 * The notices file for these package folders: one section per package, by name, each with every
 * licence file the package has, verbatim. The same folders give the same bytes.
 */
export async function noticesText(roots: readonly string[], product: string): Promise<string> {
  const notices = await Promise.all([...new Set(roots)].map(noticeOf));
  notices.sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name < b.name ? -1 : 1,
  );
  const sections = notices.map(section);
  const lead = [
    `Third-party software in ${product}`,
    '',
    `${product} itself is under the Mozilla Public License 2.0. It includes the`,
    'following software and fonts, each under its own licence, reproduced here.',
  ].join('\n');
  return `${[lead, ...sections].join('\n\n')}\n`;
}
