/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The stack build: the e2e build (e2e/build.ts) pointed at the dev backend, its test sign-in
// approving through the backend's real authorize route. Run by the stack's global setup:
//
//   node e2e-stack/build.ts

import { fileURLToPath } from 'node:url';

import { build } from 'wxt';

import { STACK_API_URL, STACK_APPROVE_URL, STACK_OUT_DIR, STACK_WEB_APP_URL } from './config.ts';

const APP = fileURLToPath(new URL('..', import.meta.url));

Object.assign(process.env, {
  MT_API_BASE_URL: STACK_API_URL,
  MT_WEB_APP_BASE_URL: STACK_WEB_APP_URL,
  MT_AUTH_STRATEGIES: 'test',
  MT_TEST_APPROVE_URL: STACK_APPROVE_URL,
});

await build({ root: APP, mode: 'e2e', outDir: STACK_OUT_DIR });
