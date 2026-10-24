/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The build fingerprint: a SHA-256 over the bundled code alone, so it can be
// recomputed from an installed copy, which the store serves with `_metadata/` and an `update_url`
// added. The build writes it to `fingerprint.json`, which is neither code nor counted.

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const CODE = /\.(?:js|css|html)$/u;
const EXCLUDED_DIR = '_metadata';

async function codeFiles(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === root && entry.name === EXCLUDED_DIR) continue;
      out.push(...(await codeFiles(root, path)));
    } else if (entry.isFile() && CODE.test(entry.name)) {
      out.push(relative(root, path).split(sep).join('/'));
    }
  }
  return out;
}

/**
 * SHA-256, hex, over `path \0 bytes \0` of every `.js`, `.css` and `.html` file under `dir` — the
 * path relative and `/`-separated, the files in code-unit order of their paths — leaving out
 * `_metadata/`. The same files give the same fingerprint wherever they lie.
 */
export async function fingerprint(dir: string): Promise<string> {
  const files = (await codeFiles(dir, dir)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file, 'utf8');
    hash.update(new Uint8Array([0]));
    hash.update(await readFile(join(dir, ...file.split('/'))));
    hash.update(new Uint8Array([0]));
  }
  return hash.digest('hex');
}
