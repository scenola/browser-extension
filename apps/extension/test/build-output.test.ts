/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What a built extension may not carry: the directory it was built in, and the JSX development
// transform that wrote it there; outside a development build, the pseudo-locale. The builds are
// made for real, with WXT's own API, into a temporary directory; the rule's own cases are files
// written here.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, test } from 'vitest';
import { build } from 'wxt';

import { buildOutputProblems, checkBuildOutput, pathSpellings } from '../build/output-check.ts';
import { NOTICES_FILE } from '../src/ui/source.ts';

const APP = fileURLToPath(new URL('..', import.meta.url));
const WORKSPACE = fileURLToPath(new URL('../../..', import.meta.url));
const BUILD_TIMEOUT_MS = 240_000;

const quiet = {
  debug: () => undefined,
  log: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  success: () => undefined,
  level: 0,
};

const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function folder(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mt-output-test-'));
  scratch.push(dir);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), text);
  }
  return dir;
}

describe('the rule', () => {
  const RULES = { forbiddenPaths: ['/home/builder/src/extension'] };

  test('a file naming the build directory is refused, by name', async () => {
    const dir = await folder({
      'chunks/popup-1.js': 'var O=`/home/builder/src/extension/apps/extension/src/ui/Icon.tsx`;',
      'chunks/clean-1.js': 'export const x = 1;',
    });
    expect(await buildOutputProblems(dir, RULES)).toEqual([
      'chunks/popup-1.js names the directory /home/builder/src/extension',
    ]);
    await expect(checkBuildOutput(dir, RULES)).rejects.toThrow(/chunks\/popup-1\.js/u);
  });

  test("the JSX development transform's source positions are refused, path or not", async () => {
    const dir = await folder({
      'chunks/options-1.js':
        'u(`span`,{},void 0,!1,{fileName:O,lineNumber:26,columnNumber:7},this)',
      'assets/page.css': ':root{color:red}',
    });
    expect(await buildOutputProblems(dir, RULES)).toEqual([
      "chunks/options-1.js carries the JSX development transform's source positions",
    ]);
  });

  test('pages, styles, data and the notices are read too; images are not', async () => {
    const path = '/home/builder/src/extension/x';
    const dir = await folder({
      'popup.html': `<script src="${path}"></script>`,
      'assets/a.css': `/* ${path} */`,
      'i18n/de.json': JSON.stringify({ path }),
      'THIRD_PARTY_NOTICES.txt': `Source: ${path}`,
      'icons/a.png': path,
    });
    expect(await buildOutputProblems(dir, RULES)).toEqual([
      'THIRD_PARTY_NOTICES.txt names the directory /home/builder/src/extension',
      'assets/a.css names the directory /home/builder/src/extension',
      'i18n/de.json names the directory /home/builder/src/extension',
      'popup.html names the directory /home/builder/src/extension',
    ]);
  });

  test('text a mode leaves out is refused wherever it is', async () => {
    const dir = await folder({
      'chunks/en-XA-1.js': 'const e={locale:`en-XA`,messages:{}};export{e as catalog}',
      'chunks/popup-1.js': 'export const x = 1;',
    });
    const rules = { ...RULES, forbiddenText: [{ text: 'en-XA', what: 'the pseudo-locale' }] };
    expect(await buildOutputProblems(dir, rules)).toEqual([
      'chunks/en-XA-1.js carries the pseudo-locale (en-XA)',
    ]);
  });

  test('a directory is looked for with either separator, and a one-segment one not at all', () => {
    expect(pathSpellings(['C:\\Users\\b\\repo\\', '/root', '/', '/home/b'])).toEqual([
      'C:\\Users\\b\\repo',
      'C:/Users/b/repo',
      '/home/b',
      '\\home\\b',
    ]);
  });
});

/** A real build of `mode` into a temporary directory, the process's environment put back. */
async function buildOf(mode: string, env: Readonly<Record<string, string>>): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), 'mt-output-build-'));
  scratch.push(outDir);
  // The build sets NODE_ENV (wxt.config.ts) and reads `MT_*`: both are put back afterwards.
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('MT_')) Reflect.deleteProperty(process.env, name);
  }
  Object.assign(process.env, env);
  try {
    await build({ root: APP, mode, outDir, logger: quiet });
    return join(outDir, 'chrome-mv3');
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in saved)) Reflect.deleteProperty(process.env, name);
    }
    Object.assign(process.env, saved);
  }
}

/** The pseudo-locale is in development builds only. */
const PSEUDO = [{ text: 'en-XA', what: 'the pseudo-locale' }];

const rulesOf = (pseudoAllowed: boolean) => ({
  forbiddenPaths: [WORKSPACE, homedir()],
  forbiddenText: pseudoAllowed ? [] : PSEUDO,
});

describe('a real build', () => {
  /** The store build the first test makes; the notices test reads it. */
  let storeBuild = '';

  test(
    'a store build names no directory, has no JSX development transform, no pseudo-locale',
    async () => {
      const dir = await buildOf('store', {
        MT_API_BASE_URL: 'https://api.example.com',
        MT_WEB_APP_BASE_URL: 'https://app.example.com',
      });
      expect(await buildOutputProblems(dir, rulesOf(false))).toEqual([]);
      storeBuild = dir;
    },
    BUILD_TIMEOUT_MS,
  );

  test('a store build lists what it bundles in its notices, and no tool', async () => {
    const text = await readFile(join(storeBuild, NOTICES_FILE), 'utf8');
    const listed = [...text.matchAll(/^={78}\n(\S+) /gmu)].map((m) => m[1]);
    // The runtime dependencies, the fonts the pages bundle, and Tailwind's CSS.
    for (const name of [
      'preact',
      '@preact/signals',
      'valibot',
      'idb',
      '@fontsource-variable/bricolage-grotesque',
      '@fontsource-variable/instrument-sans',
      'tailwindcss',
    ]) {
      expect(listed).toContain(name);
    }
    for (const tool of ['vitest', 'happy-dom', 'fake-indexeddb', 'typescript', 'axe-core']) {
      expect(listed).not.toContain(tool);
    }
  });

  test(
    'an e2e build names no directory, has no JSX development transform, no pseudo-locale',
    async () => {
      expect(await buildOutputProblems(await buildOf('e2e', {}), rulesOf(false))).toEqual([]);
    },
    BUILD_TIMEOUT_MS,
  );

  test(
    'a development build names no directory either, and carries the pseudo-locale',
    async () => {
      const dir = await buildOf('development', {});
      expect(await buildOutputProblems(dir, rulesOf(true))).toEqual([]);
      const problems = await buildOutputProblems(dir, rulesOf(false));
      expect(problems).toContain('i18n/en-XA.json carries the pseudo-locale (en-XA)');
      expect(problems.some((p) => /^chunks\/en-XA-[^ ]+\.js carries/u.test(p))).toBe(true);
    },
    BUILD_TIMEOUT_MS,
  );
});
