/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ignoredByGit, repositoryFiles } from './git-files.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe("the linters' file set is the repository's", () => {
  it('ignores what git ignores, a folder as <folder>/**', () => {
    expect(ignoredByGit(ROOT)).toContain('node_modules/**');
  });

  it('lists what git tracks, and nothing under an ignored folder', () => {
    const files = repositoryFiles(ROOT);
    expect(files).toContain('package.json');
    const folders = ignoredByGit(ROOT)
      .filter((glob) => glob.endsWith('/**'))
      .map((glob) => glob.slice(0, -2));
    for (const file of files ?? []) {
      expect(folders.some((folder) => file.startsWith(folder))).toBe(false);
    }
  });

  it('outside a git checkout: nothing extra ignored, and no file list', () => {
    const outside = mkdtempSync(join(tmpdir(), 'mt-git-files-'));
    expect(ignoredByGit(outside)).toEqual([]);
    expect(repositoryFiles(outside)).toBeNull();
  });
});
