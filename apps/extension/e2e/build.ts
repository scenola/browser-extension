/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The end-to-end build: the extension in e2e mode, pointed at the local mock (fixtures.ts serves
// it at E2E_BASE_URL), signing in through `TestAuth` — built into its own output directory,
// `.output/e2e/` (config.ts), so it never touches `.output/chrome-mv3/`, which other builds own.
// Run by the Playwright global setup, once per `pnpm e2e`:
//
//   node e2e/build.ts

import { fileURLToPath } from 'node:url';

import { build } from 'wxt';

import { E2E_BASE_URL, E2E_OUT_DIR } from './config.ts';

const APP = fileURLToPath(new URL('..', import.meta.url));

Object.assign(process.env, {
  MT_API_BASE_URL: E2E_BASE_URL,
  MT_WEB_APP_BASE_URL: E2E_BASE_URL,
  MT_AUTH_STRATEGIES: 'test',
  MT_TEST_APPROVE_URL: `${E2E_BASE_URL}/__test/approve`,
});

await build({ root: APP, mode: 'e2e', outDir: E2E_OUT_DIR });
