/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `pnpm format` (`--write`) and the Prettier half of `pnpm lint` (`--check`): Prettier over the
// repository's files (git-files.js), never over whatever else sits in the folder. Prettier
// still applies .prettierignore and skips a file it has no parser for. Outside a git checkout
// it falls back to the whole folder.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { repositoryFiles } from './git-files.js';

const ROOT = join(import.meta.dirname, '..', '..');
const PRETTIER = join(ROOT, 'node_modules', 'prettier', 'bin', 'prettier.cjs');
// Well under any platform's command-line limit.
const BATCH = 200;

const mode = process.argv[2];
if (mode !== '--check' && mode !== '--write') {
  process.stderr.write('usage: node tools/lint/format.js --check | --write\n');
  process.exit(2);
}

const files = repositoryFiles(ROOT) ?? ['.'];
let status = 0;
for (let i = 0; i < files.length; i += BATCH) {
  const run = spawnSync(
    process.execPath,
    [PRETTIER, mode, '--ignore-unknown', '--log-level=warn', ...files.slice(i, i + BATCH)],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (run.status !== 0) status = run.status ?? 1;
}
if (status === 0 && mode === '--check')
  process.stdout.write('All matched files use Prettier code style!\n');
process.exit(status);
