/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Builds the e2e extension once per run (e2e/build.ts), in its own process: WXT loads its own
// configuration, the service registry's TypeScript source among it, with its own loader.
// `MT_E2E_SKIP_BUILD=1` reuses the last build, for a person iterating on a test file.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export default function globalSetup(): void {
  if (process.env.MT_E2E_SKIP_BUILD === '1') return;
  const build = fileURLToPath(new URL('./build.ts', import.meta.url));
  const result = spawnSync(process.execPath, [build], { stdio: 'inherit', env: process.env });
  if (result.status !== 0) throw new Error(`the e2e build failed (${String(result.status)})`);
}
