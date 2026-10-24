/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The build fingerprint: a SHA-256 over `path\0bytes\0` of every `.js`, `.css` and `.html` file
// sorted by path, excluding `_metadata/`; stable across two runs over the same files and changed
// by one byte of JS. It is recomputable from an installed copy, to which the store adds
// `_metadata/`. The expected hash is computed here from that definition.

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { fingerprint } from './fingerprint';

const CODE: Readonly<Record<string, string>> = {
  'background.js': 'self.x = 1;\n',
  'chunks/popup-1.js': 'export {};\n',
  'assets/popup.css': ':root { color: red }\n',
  'popup.html': '<!doctype html><title>p</title>',
};
const OTHER: Readonly<Record<string, string>> = {
  'manifest.json': '{"manifest_version":3}',
  'icons/16.png': '\u0089PNG',
  'fingerprint.json': '{"fingerprint":"x"}',
  '_metadata/verified_contents.json': '[]',
  '_metadata/computed_hashes.js': 'not code of ours',
};

const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function folder(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mt-fingerprint-test-'));
  scratch.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, ...name.split('/'));
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
  }
  return dir;
}

/** The definition, spelled out: sorted paths, `path \0 bytes \0` each. */
function expected(code: Readonly<Record<string, string>>): string {
  const hash = createHash('sha256');
  for (const name of Object.keys(code).sort()) {
    hash.update(`${name}\0`);
    hash.update(code[name] ?? '');
    hash.update('\0');
  }
  return hash.digest('hex');
}

describe('the build fingerprint', () => {
  it('is the SHA-256 of the definition above, over the code alone', async () => {
    expect(await fingerprint(await folder({ ...CODE, ...OTHER }))).toBe(expected(CODE));
  });

  it('is stable across two runs over the same files, and wherever they lie', async () => {
    const one = await folder({ ...CODE, ...OTHER });
    const two = await folder({ ...CODE, ...OTHER });
    const first = await fingerprint(one);
    expect(await fingerprint(one)).toBe(first);
    expect(await fingerprint(two)).toBe(first);
  });

  it('is not changed by a file time', async () => {
    const dir = await folder(CODE);
    const before = await fingerprint(dir);
    await utimes(join(dir, 'background.js'), new Date(0), new Date(0));
    expect(await fingerprint(dir)).toBe(before);
  });

  it('is changed by one byte of JS', async () => {
    const before = await fingerprint(await folder(CODE));
    const changed = await folder({ ...CODE, 'background.js': 'self.x = 2;\n' });
    expect(await fingerprint(changed)).not.toBe(before);
  });

  it('is changed by a JS file renamed, added or removed', async () => {
    const before = await fingerprint(await folder(CODE));
    const { 'chunks/popup-1.js': moved, ...rest } = CODE;
    const renamed = await folder({ ...rest, 'chunks/popup-2.js': moved ?? '' });
    expect(await fingerprint(renamed)).not.toBe(before);
    expect(await fingerprint(await folder({ ...CODE, 'injected.js': '' }))).not.toBe(before);
    expect(await fingerprint(await folder(rest))).not.toBe(before);
  });

  it('is not changed by the store adding _metadata/, nor by files that are not JS, CSS or HTML', async () => {
    const before = await fingerprint(await folder(CODE));
    expect(await fingerprint(await folder({ ...CODE, ...OTHER }))).toBe(before);
  });
});
