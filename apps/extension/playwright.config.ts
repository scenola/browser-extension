/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The end-to-end tests: Chromium with the e2e build loaded, against the mock API and the routed
// fixture sites. One test at a time — every test owns the mock's port (the build names it) and a
// fresh browser profile — and no retries: a flake is a finding.

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Playwright's own budget for one test: fixture media plays in real time at 16×.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI === undefined ? 'list' : [['list'], ['github']],
  outputDir: 'test-results',
  use: { trace: 'retain-on-failure' },
});
