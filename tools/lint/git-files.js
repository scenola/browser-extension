/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The linters' file set is the repository's: what git tracks, or would track. Whatever git
// ignores — `.gitignore`, and a checkout's own `.git/info/exclude` for folders kept only on
// one machine — is not linted or formatted either, without any of those paths being spelled
// in a committed file. Outside a git checkout (a source archive) nothing extra is ignored.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** @param {string} root @param {string[]} args @returns {string[] | null} */
function git(root, args) {
  try {
    const out = execFileSync('git', ['-C', root, ...args, '-z'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\0').filter((path) => path !== '');
  } catch {
    return null;
  }
}

/** `path` as a glob that matches only itself. @param {string} path */
const literal = (path) => path.replace(/[\\*?[\]{}()!+@]/gu, '\\$&');

/**
 * What git ignores under `root` and does not track, as ESLint `ignores` globs: a folder as
 * `<folder>/**`, a file as itself. `[]` outside a git checkout.
 * @param {string} root
 * @returns {string[]}
 */
export function ignoredByGit(root) {
  const paths = git(root, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
  ]);
  return (paths ?? []).map((path) =>
    path.endsWith('/') ? `${literal(path.slice(0, -1))}/**` : literal(path),
  );
}

/**
 * The files under `root` that git tracks or would track (untracked, not ignored), that exist
 * on disk; `null` outside a git checkout.
 * @param {string} root
 * @returns {string[] | null}
 */
export function repositoryFiles(root) {
  const paths = git(root, ['ls-files', '--cached', '--others', '--exclude-standard']);
  return paths === null ? null : [...new Set(paths)].filter((path) => existsSync(join(root, path)));
}
