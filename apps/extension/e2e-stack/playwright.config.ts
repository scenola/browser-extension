/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `pnpm e2e:stack`: one sign-in, one play and its receipt against a real dev backend. The
// maintainer's: CI never runs it — `pnpm e2e` has its own config and directory (`e2e/`), and this
// one is reached only by name.

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Fixture media plays in real time at 16×, and the backend decides within seconds.
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  outputDir: '../test-results/e2e-stack',
  use: { trace: 'retain-on-failure' },
});
