/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What a finished build may not carry, checked on the files WXT wrote, so a plugin, a
// dependency or a Vite default cannot put it back unnoticed:
//
// - **The builder's paths.** A file that names the directory it was built in leaks the builder's
//   home and username, and two honest builders in two directories get two fingerprints — so
//   nobody could rebuild a release and compare.
// - **The JSX development transform.** It is what put those paths there: every element carries
//   `{fileName, lineNumber, columnNumber}`. Every build is a production build (wxt.config.ts).
// - **What a mode leaves out** (`forbiddenText`): the pseudo-locale outside a development build
//   whose code is dropped only while its condition folds where it is.
//
// A build that breaks one is refused, in every mode, not shipped.

import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** The source position the JSX development transform hands every element, minified or not. */
const JSX_DEV_SOURCE = /lineNumber:\s*\d+,\s*columnNumber:\s*\d+/u;

/** The files a build writes that are text: code, styles, pages, data and the notices. */
const TEXT = /\.(?:js|mjs|css|html|json|txt)$/u;

export interface OutputRules {
  /** Absolute directories no file may name: the workspace, the builder's home. */
  readonly forbiddenPaths: readonly string[];
  /** Text no file may hold in this build, and what it is. */
  readonly forbiddenText?: readonly { readonly text: string; readonly what: string }[];
}

class BuildOutputError extends Error {
  override readonly name = 'BuildOutputError';
}

/**
 * The spellings of each directory a file could carry it in: as given, with `/` (what Vite
 * writes, on Windows too) and with `\`. A directory of fewer than two segments (`/`, `C:\`, `/root`)
 * would match text that is no path, so it is left out; the workspace always has more.
 */
export function pathSpellings(paths: readonly string[]): readonly string[] {
  const out = new Set<string>();
  for (const path of paths) {
    const trimmed = path.replace(/[\\/]+$/u, '');
    const segments = trimmed.split(/[\\/]/u).filter((s) => s !== '' && !/^[A-Za-z]:$/u.test(s));
    if (segments.length < 2) continue;
    out.add(trimmed);
    out.add(trimmed.replaceAll('\\', '/'));
    out.add(trimmed.replaceAll('/', '\\'));
  }
  return [...out];
}

async function textFiles(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await textFiles(root, path)));
    else if (entry.isFile() && TEXT.test(entry.name)) out.push(path);
  }
  return out;
}

/** Every problem in the build at `dir`, one line each, the file relative and `/`-separated. */
export async function buildOutputProblems(
  dir: string,
  rules: OutputRules,
): Promise<readonly string[]> {
  const spellings = pathSpellings(rules.forbiddenPaths);
  const problems: string[] = [];
  const files = (await textFiles(dir, dir)).sort();
  for (const file of files) {
    const name = relative(dir, file).split(sep).join('/');
    const text = await readFile(file, 'utf8');
    const path = spellings.find((spelling) => text.includes(spelling));
    if (path !== undefined) problems.push(`${name} names the directory ${path}`);
    if (JSX_DEV_SOURCE.test(text)) {
      problems.push(`${name} carries the JSX development transform's source positions`);
    }
    for (const { text: forbidden, what } of rules.forbiddenText ?? []) {
      if (text.includes(forbidden)) problems.push(`${name} carries ${what} (${forbidden})`);
    }
  }
  return problems;
}

/** Refuses the build at `dir` when it breaks a rule, naming every file that does. */
export async function checkBuildOutput(dir: string, rules: OutputRules): Promise<void> {
  const problems = await buildOutputProblems(dir, rules);
  if (problems.length > 0) {
    throw new BuildOutputError(`the build is refused:\n  ${problems.join('\n  ')}`);
  }
}
