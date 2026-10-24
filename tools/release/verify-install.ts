/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `pnpm verify:install <installed copy> <published fingerprint> [--zip <release zip>]`: is the extension Chrome runs the one a release published?
//
// - The fingerprint is recomputed from the installed copy's code (`fingerprint.ts`: every `.js`,
//   `.css` and `.html`, `_metadata/` left out) and compared with the one the release notes
//   publish. Nothing the store or Chrome adds is code, so a genuine copy always matches.
// - With the release zip as well (downloaded from the release, its attestation checked with
//   `gh attestation verify`), every other file is compared too: the manifest — its permissions,
//   its content security policy — the locales, the icons. The installed copy may hold
//   `_metadata/` (the store's signed hashes), and its manifest the keys the store and Chrome's
//   installer write into the copy they install: `update_url` (the store), `key` (the package's
//   public key, which gives the id) and `current_locale` (the language Chrome chose). Nothing
//   else may differ.

import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

import { readZip, ZipError } from './deterministic-zip.ts';
import { fingerprint } from './fingerprint.ts';

/** What the store and Chrome's installer add to an installed copy's top level. */
const INSTALLED_ONLY_DIR = '_metadata';
/** Manifest keys the store (`update_url`) and Chrome's installer write into the copy they install. */
const INSTALLED_ONLY_KEYS: readonly string[] = ['update_url', 'key', 'current_locale'];
const MANIFEST = 'manifest.json';
const SHA256 = /^[0-9a-f]{64}$/u;
/** An extension holds a few dozen files; a directory with more is not one. */
const MAX_FILES = 10_000;

export interface InstallCheck {
  /** The fingerprint of the installed copy's code. */
  readonly fingerprint: string;
  /** Whether it is the published one. */
  readonly matches: boolean;
  /** With a release zip: every file that is not the zip's (empty when all are); else `null`. */
  readonly differences: readonly string[] | null;
}

/** The installed copy's files, `/`-separated, without the store's `_metadata/`. */
async function installedFiles(dir: string): Promise<{ files: string[]; odd: string[] }> {
  const files: string[] = [];
  const odd: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      const name = relative(dir, path).split(sep).join('/');
      if (entry.isDirectory()) {
        if (at !== dir || entry.name !== INSTALLED_ONLY_DIR) await walk(path);
      } else if (entry.isFile()) {
        files.push(name);
      } else {
        odd.push(`${name}: not a regular file`);
      }
      if (files.length + odd.length > MAX_FILES) {
        throw new ZipError(`${dir} holds more than ${String(MAX_FILES)} files: not an extension`);
      }
    }
  };
  await walk(dir);
  return { files, odd };
}

/** JSON with every object's keys in order, so that two spellings of one value compare equal. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

/** The manifest as a release would have written it: the installer's keys taken out. */
function releasedManifest(bytes: Uint8Array): string | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const manifest = { ...(value as Record<string, unknown>) };
  for (const key of INSTALLED_ONLY_KEYS) Reflect.deleteProperty(manifest, key);
  return JSON.stringify(canonical(manifest));
}

async function differencesFrom(dir: string, zipPath: string): Promise<string[]> {
  const released = readZip(await readFile(zipPath));
  const { files, odd } = await installedFiles(dir);
  const differences = [...odd];
  const installed = new Set(files);
  for (const name of [...released.keys()].sort()) {
    if (!installed.has(name)) differences.push(`${name}: missing from the installed copy`);
  }
  for (const name of files.sort()) {
    const expected = released.get(name);
    if (expected === undefined) {
      differences.push(`${name}: not in the release`);
      continue;
    }
    const actual = await readFile(join(dir, ...name.split('/')));
    if (name === MANIFEST) {
      const want = releasedManifest(expected);
      if (want === null || want !== releasedManifest(actual)) {
        differences.push(`${name}: differs beyond ${INSTALLED_ONLY_KEYS.join(', ')}`);
      }
    } else if (!Buffer.from(expected).equals(actual)) {
      differences.push(`${name}: differs`);
    }
  }
  return differences;
}

/**
 * Recomputes the fingerprint of an installed copy (`dir`: the version folder under the
 * profile's `Extensions/<id>/`) and compares it with `published`, the release notes' value.
 * With `zip`, the release zip, every file is compared as well (see the top of this file).
 */
export async function verifyInstall(
  dir: string,
  published: string,
  zip?: string,
): Promise<InstallCheck> {
  const expected = published.trim().toLowerCase();
  if (!SHA256.test(expected)) {
    throw new RangeError('the published fingerprint is 64 hexadecimal digits (SHA-256)');
  }
  const root = resolve(dir);
  if (!(await lstat(root)).isDirectory()) throw new ZipError(`${dir} is not a directory`);
  const computed = await fingerprint(root);
  return {
    fingerprint: computed,
    matches: computed === expected,
    differences: zip === undefined ? null : await differencesFrom(root, resolve(zip)),
  };
}

const USAGE =
  'usage: pnpm verify:install <installed extension folder> <published fingerprint> ' +
  '[--zip <release zip>]';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { zip: { type: 'string' } },
    allowPositionals: true,
    strict: true,
  });
  const [dir, published] = positionals;
  if (dir === undefined || published === undefined || positionals.length > 2) {
    process.stderr.write(`${USAGE}\n`);
    if (dir !== undefined && positionals.length === 1) {
      const computed = await fingerprint(resolve(dir));
      process.stderr.write(
        `The installed copy's fingerprint is ${computed}. Compare it with the one the release ` +
          'notes publish, or pass that one as the second argument.\n',
      );
    }
    process.exitCode = 2;
    return;
  }
  const check = await verifyInstall(dir, published, values.zip);
  const say = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  say(`installed  ${check.fingerprint}`);
  say(`published  ${published.trim().toLowerCase()}`);
  say(
    check.matches
      ? 'The code is the code that release published.'
      : 'The code is NOT the code that release published.',
  );
  if (check.differences !== null) {
    if (check.differences.length === 0) {
      say(
        `Every file is the release zip's (${INSTALLED_ONLY_DIR}/ and the manifest's ` +
          `${INSTALLED_ONLY_KEYS.join(', ')} aside).`,
      );
    } else {
      say(`${String(check.differences.length)} file(s) differ from the release zip:`);
      for (const difference of check.differences) say(`  ${difference}`);
    }
  }
  if (!check.matches || (check.differences?.length ?? 0) > 0) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    // A refusal of ours, or a file system answer (a folder that is not there): said, not thrown.
    const said = error instanceof ZipError || error instanceof RangeError;
    if (!(said || (error instanceof Error && 'code' in error))) throw error;
    process.stderr.write(`verify:install: ${error.message}\n`);
    process.exitCode = 1;
  }
}
