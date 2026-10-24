/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { NOTICE_LINES } from '../lint/mpl-header.js';
import type { OpenApiDoc } from './extract-subset';
import { TYPES_HEADER, generateTypes } from './generate-types';

const SUBSET_FILE = fileURLToPath(new URL('./openapi.subset.json', import.meta.url));
const TYPES_FILE = fileURLToPath(
  new URL('../../packages/api/src/generated/schema.d.ts', import.meta.url),
);

// The half of `pnpm openapi:check` that needs no backend checkout, so `pnpm test` refuses a
// hand-edited `schema.d.ts` too.
describe('the generated types', () => {
  test('are exactly what the committed subset generates', async () => {
    const subset = JSON.parse(await readFile(SUBSET_FILE, 'utf8')) as OpenApiDoc;
    const before = JSON.stringify(subset);
    const generated = await generateTypes(subset);
    expect(JSON.stringify(subset)).toBe(before);
    expect(await readFile(TYPES_FILE, 'utf8')).toBe(generated);
  });

  test('open with the MPL-2.0 notice and say how they are made', () => {
    const notice = `/* ${NOTICE_LINES[0]}\n * ${NOTICE_LINES[1]}\n * ${NOTICE_LINES[2]} */\n`;
    expect(TYPES_HEADER.startsWith(notice)).toBe(true);
    expect(TYPES_HEADER).toContain('pnpm openapi:sync');
  });
});
