/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The build's configuration as the bundle carries it. Each value is replaced at build time by
// the one `resolveConfig` (config-rules.ts) accepted — the build refuses anything else — so
// nothing here reads or re-checks an environment, and nothing else is ever inlined: these
// names are read one by one, never as `import.meta.env` whole.
//
// The build mode is not among them. It is read as `import.meta.env.MT_BUILD_MODE` where it is
// tested: replaced there by its value, the test folds where it stands, and what it keeps out of
// a store build goes with it — an `import()` and its chunk included, which a constant read
// from here would leave in.

import type { AuthStrategyId } from './config-rules';

/** The public API origin; a proof's `htu` is built from it, never from an answer. */
export const API_BASE_URL: string = import.meta.env.MT_API_BASE_URL;

export const WEB_APP_BASE_URL: string = import.meta.env.MT_WEB_APP_BASE_URL;

/**
 * The sign-in strategies this build compiles in: read by the worker's wiring.
 *
 * @public
 */
export const AUTH_STRATEGIES: readonly AuthStrategyId[] = Object.freeze(
  import.meta.env.MT_AUTH_STRATEGIES.split(',') as AuthStrategyId[],
);

/**
 * Where `TestAuth` approves, in an e2e build that has it; `null` everywhere else.
 *
 * @public
 */
export const TEST_APPROVE_URL: string | null =
  import.meta.env.MT_TEST_APPROVE_URL === '' ? null : import.meta.env.MT_TEST_APPROVE_URL;
