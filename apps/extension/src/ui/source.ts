/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Where the extension's source and its licence are published, for the About screen.

/**
 * The public repository. `null` until it exists: the maintainer sets it before the first
 * release, and the About screen shows the source link and the link to `docs/privacy.md` from
 * then on. Nothing is guessed meanwhile.
 */
export const SOURCE_REPOSITORY_URL: string | null = null;

/** The licence's own text (MPL-2.0, `LICENSE`). */
export const LICENCE_URL = 'https://mozilla.org/MPL/2.0/';

/**
 * The third-party software and fonts the build ships, each with its licence's text: a file the
 * build writes at the extension's root (build/notices.ts), opened from the About screen.
 */
export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt';
