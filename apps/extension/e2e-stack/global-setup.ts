/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Builds the stack extension once per run, in its own process (as e2e/global-setup.ts does).
// Without the session token nothing runs, so nothing is built either.
// `MT_E2E_SKIP_BUILD=1` reuses the last build.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { SESSION_TOKEN_ENV, SKIP_REASON } from './config.ts';

export default function globalSetup(): void {
  if ((process.env[SESSION_TOKEN_ENV] ?? '') === '') {
    process.stderr.write(`e2e:stack: ${SKIP_REASON}\n`);
    return;
  }
  if (process.env.MT_E2E_SKIP_BUILD === '1') return;
  const build = fileURLToPath(new URL('./build.ts', import.meta.url));
  const result = spawnSync(process.execPath, [build], { stdio: 'inherit', env: process.env });
  if (result.status !== 0) throw new Error(`the stack build failed (${String(result.status)})`);
}
