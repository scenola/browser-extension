/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the e2e build and the e2e run must agree on. The mock API's public URL is compiled into
// the build (a DPoP proof names it), so it is fixed here; its port is not 8787, where
// `pnpm dev` runs the same mock for a person, so the two never meet.

import { fileURLToPath } from 'node:url';

export const E2E_PORT = Number(process.env.MT_E2E_PORT ?? '8790');

/** `localhost`, not `127.0.0.1`: the mock compares a proof's `htu` with exactly this string. */
export const E2E_BASE_URL = `http://localhost:${String(E2E_PORT)}`;

/**
 * The build's own directory. WXT empties only `<outDir>/chrome-mv3` before a build, so this one
 * (`.output/e2e/chrome-mv3`) and every other build's (`.output/chrome-mv3`) never touch; under
 * `.output/` it is ignored by git, ESLint and Prettier like every build.
 */
export const E2E_OUT_DIR = fileURLToPath(new URL('../.output/e2e', import.meta.url));

/** Where WXT writes the unpacked extension inside it. */
export const E2E_EXTENSION_DIR = `${E2E_OUT_DIR}/chrome-mv3`;
