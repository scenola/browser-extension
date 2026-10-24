/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The files the build writes for the scripts that run in pages, spelled once: the manifest
// declares the bootstrap (build/manifest.ts), the run-time registration names it
// (platform/site-permissions.ts), and the worker injects the collector (platform/injection.ts).

/** The bootstrap content script (src/entrypoints/bootstrap.ts, an unlisted script). */
export const BOOTSTRAP_FILE = 'bootstrap.js';

/** The collector, injected after the first `play` (src/entrypoints/collector.ts). */
export const COLLECTOR_FILE = 'collector.js';
