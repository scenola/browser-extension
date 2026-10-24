/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vitest/config';

// Vitest 5 has no vitest.workspace file; the workspace is `projects` in the root config.
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      { test: { name: 'tools', include: ['tools/**/*.test.ts'] } },
      // Its own config: the build's defines, the fake browser (needs `--configLoader runner`).
      'apps/extension/vitest.config.ts',
      { test: { name: 'core', root: 'packages/core', include: ['src/**/*.test.ts'] } },
      { test: { name: 'api', root: 'packages/api', include: ['src/**/*.test.ts'] } },
      { test: { name: 'services', root: 'packages/services', include: ['src/**/*.test.ts'] } },
    ],
  },
});
