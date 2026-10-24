/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { KnipConfig } from 'knip';

/** What a stylesheet loads: each `@import`, and a scoped package's file in a `url()` (a font). */
const STYLESHEET_LOADS = [/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g, /url\(\s*['"]?(@[^'")\s]+)/g];

const config: KnipConfig = {
  workspaces: {
    '.': {
      entry: ['tools/**/*.test.ts'],
    },
    'packages/*': {},
    'packages/services': {
      entry: ['test/forbidden/*.ts', 'test/control/*.ts'],
    },
    'apps/extension': {
      entry: ['e2e-stack/*.ts'],
      wxt: {
        config: ['wxt.config.ts'],
        entry: ['src/entrypoints/**/*.{ts,tsx}'],
      },
    },
  },
  compilers: {
    // Knip's own stylesheet reader follows `@import` only, so the font packages, which a
    // stylesheet names in `url()`, would read as unused: each load is read as the import it is.
    css: (text: string) =>
      STYLESHEET_LOADS.flatMap((pattern) =>
        Array.from(text.matchAll(pattern), ([, file]) => `import '${file ?? ''}';`),
      ).join('\n'),
  },
};

export default config;
