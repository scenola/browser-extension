/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the stack build and the stack run must agree on (`pnpm e2e:stack`, the maintainer's).
// The API is a real Scenola backend on this machine, not the mock.

import { fileURLToPath } from 'node:url';

/** The dev backend. Compiled into the build, since a DPoP proof names it. */
export const STACK_API_URL = (process.env.MT_STACK_API_URL ?? 'http://localhost:8000').replace(
  /\/+$/u,
  '',
);

/** The dev web app: only the build's links to it read this; nothing here calls it. */
export const STACK_WEB_APP_URL = (
  process.env.MT_STACK_WEB_APP_URL ?? 'http://localhost:3000'
).replace(/\/+$/u, '');

/**
 * The backend's real approval route. `TestAuth` posts what the web app's approval page posts to
 * it, with the person's session as `Authorization: Bearer` (src/platform/auth-test.ts).
 */
export const STACK_APPROVE_URL =
  process.env.MT_STACK_APPROVE_URL ?? `${STACK_API_URL}/v1/me/scrobblers/authorize`;

/** The person's session: an access token of a development account with Plus. Never stored. */
export const SESSION_TOKEN_ENV = 'MT_TEST_USER_TOKEN';

/** Why a run without the token is skipped (CI never has one). */
export const SKIP_REASON =
  `${SESSION_TOKEN_ENV} is not set: pnpm e2e:stack runs against a real dev backend with a ` +
  `development account's access token (README, "Against a local backend"). Skipped.`;

/** Its own build directory: it shares nothing with `.output/e2e/` (the mock's build). */
export const STACK_OUT_DIR = fileURLToPath(new URL('../.output/e2e-stack', import.meta.url));

/** Where WXT writes the unpacked extension inside it. */
export const STACK_EXTENSION_DIR = `${STACK_OUT_DIR}/chrome-mv3`;
