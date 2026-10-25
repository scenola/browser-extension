/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Where the extension's source and its licence are published, for the About screen.

/** The public repository: the About screen links to it, and to `docs/privacy.md` in it. */
export const SOURCE_REPOSITORY_URL = 'https://github.com/scenola/browser-extension';

/** The licence's own text (MPL-2.0, `LICENSE`). */
export const LICENCE_URL = 'https://mozilla.org/MPL/2.0/';

/**
 * The third-party software and fonts the build ships, each with its licence's text: a file the
 * build writes at the extension's root (build/notices.ts), opened from the About screen.
 */
export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt';
