/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The app's tests. They see the constants a development build inlines — the same `extensionDefines`
// wxt.config.ts hands Vite — so `src/config.ts` and `src/sites.ts` read what a development build
// would. Computing them imports `@mt/services`'s TypeScript source, which only Vite's module
// runner resolves: run Vitest with `--configLoader runner` (the root `test` script and this
// package's do).

import { defineConfig } from 'vitest/config';

import { extensionDefines } from './build/defines.ts';
import { buildDay, buildSitesData } from './build/sites-data.ts';
import { resolveConfig } from './src/config-rules.ts';

const config = resolveConfig('development', {});
const sites = buildSitesData(config.mode, buildDay(process.env, new Date()));

export default defineConfig({
  define: extensionDefines(config, sites),
  test: {
    name: 'extension',
    // `.test.tsx`: the pages' tests, in happy-dom by their own
    // `@vitest-environment` line; Preact's JSX as tsconfig.app.json compiles it.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts'],
    setupFiles: ['test/setup/fake-browser.ts'],
  },
});
