/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `pnpm openapi:sync`: read the backend's API document from the sibling checkout, write the
// subset the extension uses and the types generated from it.
// `pnpm openapi:check`: regenerate both in memory and fail if either committed file differs.
// Without the backend checkout, the check still regenerates the types from the committed
// subset, and says that the subset itself was not compared.
// `MT_BACKEND_OPENAPI` names the backend's document when it is not at the sibling path.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXTENSION_OPERATIONS, extractSubset, renderSubset } from './extract-subset.ts';
import type { OpenApiDoc } from './extract-subset.ts';
import { generateTypes } from './generate-types.ts';

const at = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

// <parent>/extension/tools/openapi -> <parent>/backend
const BACKEND_DOCUMENT =
  process.env.MT_BACKEND_OPENAPI ?? at('../../../backend/docs/ios/openapi.json');
const SUBSET_FILE = at('./openapi.subset.json');
const TYPES_FILE = at('../../packages/api/src/generated/schema.d.ts');

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const complain = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

async function main(check: boolean): Promise<number> {
  const backend = existsSync(BACKEND_DOCUMENT)
    ? (JSON.parse(await readFile(BACKEND_DOCUMENT, 'utf8')) as OpenApiDoc)
    : null;
  if (backend === null && !check) {
    complain(`openapi:sync needs the backend checkout: ${BACKEND_DOCUMENT} not found.`);
    return 1;
  }
  const committedSubset = await readIfPresent(SUBSET_FILE);
  const subset =
    backend === null ? committedSubset : renderSubset(extractSubset(backend, EXTENSION_OPERATIONS));
  if (subset === null) {
    complain(`No subset at ${SUBSET_FILE}: run pnpm openapi:sync with the backend checkout.`);
    return 1;
  }
  const types = await generateTypes(JSON.parse(subset) as OpenApiDoc);

  if (!check) {
    await writeFile(SUBSET_FILE, subset);
    await mkdir(dirname(TYPES_FILE), { recursive: true });
    await writeFile(TYPES_FILE, types);
    say(`Wrote ${SUBSET_FILE}`);
    say(`Wrote ${TYPES_FILE}`);
    return 0;
  }

  if (backend === null) {
    say(
      `Backend document not found at ${BACKEND_DOCUMENT}: the subset was not compared with it; ` +
        'the types were checked against the committed subset.',
    );
  }
  const stale = [
    ...(subset === committedSubset ? [] : [SUBSET_FILE]),
    ...(types === (await readIfPresent(TYPES_FILE)) ? [] : [TYPES_FILE]),
  ];
  for (const file of stale) complain(`Out of date: ${file}`);
  if (stale.length > 0) {
    complain('Run pnpm openapi:sync and commit the result.');
    return 1;
  }
  say('The OpenAPI subset and its types are up to date.');
  return 0;
}

process.exitCode = await main(process.argv.includes('--check'));
