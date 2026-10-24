/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The values the build inlines (build/defines.ts). Nothing else of the environment reaches the
// bundle: Vite's own `envPrefix` stays WXT's, so no `MT_*` variable is exposed by name.

interface ImportMetaEnv {
  readonly MT_BUILD_MODE: 'development' | 'store' | 'e2e';
  readonly MT_API_BASE_URL: string;
  readonly MT_WEB_APP_BASE_URL: string;
  /** Comma-separated `AuthStrategyId`s. */
  readonly MT_AUTH_STRATEGIES: string;
  /** Empty unless an e2e build has the test sign-in. */
  readonly MT_TEST_APPROVE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
