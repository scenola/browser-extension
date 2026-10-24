/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `pnpm size`: each budget over what its surface loads, shared chunks and the largest catalog
// included (build/size.ts), measured on the build in `.output/chrome-mv3/`. The budgets are for
// what people install, so they are measured on a store build only: a development build also
// carries what never ships (the pseudo-locale, the personal-token and test sign-ins), and a
// number taken from it would hold the shipped code to a limit it does not share. A development
// build is refused here, by the one file only it can contain: the build refuses the
// pseudo-locale anywhere else.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PSEUDO_LOCALE } from '../../tools/i18n/locales-map.ts';
import { sizeChecks } from './build/size.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUTPUT = join(HERE, '.output', 'chrome-mv3');

const files = await readdir(OUTPUT, { recursive: true });
if (files.some((file) => file.includes(PSEUDO_LOCALE))) {
  throw new Error(
    'pnpm size measures a store build, and .output/chrome-mv3 holds a development build. ' +
      'Run `pnpm --filter @mt/extension build:store` first (it needs MT_API_BASE_URL and ' +
      'MT_WEB_APP_BASE_URL set to public https origins; any stand-ins will do).',
  );
}

export default await sizeChecks(OUTPUT, HERE);
