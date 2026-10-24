/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The third-party notices: which package a shipped file belongs to, and the text written for the
// packages a build ships. That a real build lists what it bundles is in build-output.test.ts,
// beside the other checks on a real build.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import { noticesText, packageRoot } from '../build/notices.ts';

const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A `node_modules` folder holding these packages, each a package.json and its other files. */
async function modules(
  packages: Readonly<Record<string, Readonly<Record<string, string>>>>,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mt-notices-test-'));
  scratch.push(dir);
  for (const [name, files] of Object.entries(packages)) {
    const root = join(dir, 'node_modules', ...name.split('/'));
    await mkdir(root, { recursive: true });
    for (const [file, text] of Object.entries(files)) await writeFile(join(root, file), text);
  }
  return join(dir, 'node_modules');
}

const p = (...parts: string[]): string => parts.join(sep);

describe('packageRoot', () => {
  test('a file is its package’s, scoped or not, through pnpm’s nesting', () => {
    expect(packageRoot(p('', 'w', 'node_modules', 'preact', 'dist', 'preact.mjs'))).toBe(
      p('', 'w', 'node_modules', 'preact'),
    );
    expect(
      packageRoot(
        p('', 'w', 'node_modules', '.pnpm', 'x@1', 'node_modules', '@preact', 'signals', 'a.js'),
      ),
    ).toBe(p('', 'w', 'node_modules', '.pnpm', 'x@1', 'node_modules', '@preact', 'signals'));
  });

  test('a query is not part of the path', () => {
    expect(packageRoot(p('', 'w', 'node_modules', 'idb', 'build', 'index.js?v=1'))).toBe(
      p('', 'w', 'node_modules', 'idb'),
    );
  });

  test('the workspace’s own files and virtual modules belong to no package', () => {
    expect(packageRoot(p('', 'w', 'packages', 'core', 'src', 'index.ts'))).toBeNull();
    expect(packageRoot('\0vite/preload-helper.js')).toBeNull();
    expect(packageRoot(p('', 'w', 'node_modules', '@scope'))).toBeNull();
  });
});

describe('noticesText', () => {
  test('each package once, by name, its licence files verbatim', async () => {
    const dir = await modules({
      zeta: {
        'package.json': JSON.stringify({ name: 'zeta', version: '2.0.0', license: 'ISC' }),
        LICENSE: 'ISC License\r\n\r\nCopyright (c) Zeta   \r\n',
      },
      '@a/alpha': {
        'package.json': JSON.stringify({
          name: '@a/alpha',
          version: '1.0.0',
          license: 'MIT',
          author: { name: 'Ann', email: 'ann@example.org' },
          repository: { type: 'git', url: 'git+https://example.org/alpha.git' },
        }),
        'LICENSE.md': 'MIT License\n\nCopyright (c) Ann',
      },
    });
    const zeta = join(dir, 'zeta');
    const text = await noticesText([zeta, join(dir, '@a', 'alpha'), zeta], 'Product');
    expect(text.startsWith('Third-party software in Product\n')).toBe(true);
    expect(text.indexOf('@a/alpha 1.0.0')).toBeLessThan(text.indexOf('zeta 2.0.0'));
    expect(text.split('zeta 2.0.0')).toHaveLength(2);
    expect(text).toContain(
      'Licence: MIT\nAuthor: Ann <ann@example.org>\nSource: https://example.org/alpha',
    );
    expect(text).toContain('MIT License\n\nCopyright (c) Ann');
    // Line endings and trailing blanks are the file's only changes.
    expect(text).toContain('ISC License\n\nCopyright (c) Zeta\n');
  });

  // MIT asks that its notice travel with the code: a package that publishes none still gets one.
  test('a package with no licence file that declares MIT carries MIT’s text, under its author', async () => {
    const dir = await modules({
      shim: {
        'package.json': JSON.stringify({
          name: 'shim',
          version: '0.1.0',
          license: 'MIT',
          author: 'Sam <sam@example.org>',
        }),
      },
      anonymous: {
        'package.json': JSON.stringify({ name: 'anonymous', version: '1.0.0', license: 'MIT' }),
      },
    });
    const text = await noticesText([join(dir, 'shim'), join(dir, 'anonymous')], 'Product');
    expect(text).toContain('shim 0.1.0\nLicence: MIT\nAuthor: Sam <sam@example.org>');
    expect(text).toContain('MIT License\n\nCopyright (c) Sam <sam@example.org>\n\nPermission is');
    expect(text).toContain('The above copyright notice and this permission notice shall be');
    expect(text).toContain('Copyright (c) the authors of anonymous\n');
    expect(text.split('Permission is hereby granted')).toHaveLength(3);
  });

  test('a package with no licence file under another licence is listed by its declaration', async () => {
    const dir = await modules({
      shim: {
        'package.json': JSON.stringify({ name: 'shim', version: '0.1.0', license: 'BSD-3-Clause' }),
      },
    });
    const text = await noticesText([join(dir, 'shim')], 'Product');
    expect(text).toContain('shim 0.1.0\nLicence: BSD-3-Clause');
    expect(text).toContain('publishes no licence file; its package.json declares the licence');
    expect(text).not.toContain('Permission is hereby granted');
  });

  test('a package that declares no licence at all stops the build', async () => {
    const dir = await modules({
      mystery: { 'package.json': JSON.stringify({ name: 'mystery', version: '1.0.0' }) },
    });
    await expect(noticesText([join(dir, 'mystery')], 'Product')).rejects.toThrow(
      /mystery ships in the build but declares no licence/u,
    );
  });

  test('the same packages give the same bytes, in any order', async () => {
    const dir = await modules({
      a: { 'package.json': JSON.stringify({ name: 'a', version: '1.0.0', license: 'MIT' }) },
      b: { 'package.json': JSON.stringify({ name: 'b', version: '1.0.0', license: 'MIT' }) },
    });
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    expect(await noticesText([a, b], 'P')).toBe(await noticesText([b, a], 'P'));
  });
});
