/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// WXT's fake browser as `chrome` and `browser`: what WXT's own Vitest plugin installs, without
// loading wxt.config.ts. Its state is reset before every test. The APIs it does not implement
// (`permissions`, `scripting`, `offscreen`) are handed to the classes under test as hand-written
// fakes.

import { beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

vi.stubGlobal('chrome', fakeBrowser);
vi.stubGlobal('browser', fakeBrowser);

beforeEach(() => {
  fakeBrowser.reset();
});
