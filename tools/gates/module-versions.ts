/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `pnpm module-versions:check [--against <ref>] [--head <ref>]`: a service module's `version`
// moves forward whenever what it reads or answers changes. A change to
// a file under `packages/services/src/services/<id>/fixtures/`, or to that module's
// `definition.ts`, between the merge base of `--against` (default `main`) and `--head` (default
// `HEAD`) needs `version` to be greater at the head than at the merge base. A module new since
// the merge base needs no bump; a removed one is reported; anything the check cannot read (no
// merge base, a shallow clone, a version that is not one literal) fails, naming why — a check
// that cannot answer never passes.
//
// It compares commits, not the working tree: commit first, then run it.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SERVICES = 'packages/services/src/services/';
const DEFINITION = 'definition.ts';
const FIXTURES = 'fixtures/';
/** A definition, a fixture listing or a diff of the services folder is far below this. */
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

type Semver = readonly [number, number, number];

/** What git answered: its exit status, and its output as bytes (paths are NUL-separated). */
interface GitAnswer {
  readonly status: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

function git(args: readonly string[]): GitAnswer {
  try {
    const stdout = execFileSync('git', args, {
      cwd: ROOT,
      maxBuffer: MAX_GIT_OUTPUT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: Buffer; stderr?: Buffer };
    if (typeof failed.status !== 'number') throw error;
    return {
      status: failed.status,
      stdout: failed.stdout ?? Buffer.alloc(0),
      stderr: failed.stderr?.toString('utf8').trim() ?? '',
    };
  }
}

/** The commit a ref names, or `null` when this clone has no such commit. */
function commitOf(ref: string): string | null {
  const answer = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  return answer.status === 0 ? answer.stdout.toString('utf8').trim() : null;
}

function isShallow(): boolean {
  return git(['rev-parse', '--is-shallow-repository']).stdout.toString('utf8').trim() === 'true';
}

function nulSeparated(bytes: Buffer): string[] {
  return bytes
    .toString('utf8')
    .split('\0')
    .filter((part) => part !== '');
}

/** The text of `path` at `commit`, or `null` when that commit has no such file. */
function fileAt(commit: string, path: string): string | null {
  const listing = git(['ls-tree', '-z', commit, '--', path]);
  if (listing.status !== 0) throw new Error(`git ls-tree ${commit} ${path}: ${listing.stderr}`);
  const entry = nulSeparated(listing.stdout)[0];
  if (entry === undefined) return null;
  // `<mode> SP <type> SP <object> TAB <path>`
  const [meta] = entry.split('\t');
  const [, type, object] = (meta ?? '').split(' ');
  if (type !== 'blob' || object === undefined) return null;
  const blob = git(['cat-file', 'blob', object]);
  if (blob.status !== 0) throw new Error(`git cat-file ${object}: ${blob.stderr}`);
  return blob.stdout.toString('utf8');
}

/**
 * `version: 'MAJOR.MINOR.PATCH',` on a line of its own (a trailing `//` comment allowed), stated
 * exactly once — the form `defineService` definitions are written in. Anything else is unread.
 */
const VERSION_LINE = new RegExp(
  String.raw`^[ \t]*version:[ \t]*(['"])(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\1` +
    String.raw`,?[ \t]*(?:\/\/[^\n]*)?$`,
  'gmu',
);

function versionIn(source: string): Semver | null {
  const found = [...source.matchAll(VERSION_LINE)];
  const only = found.length === 1 ? found[0] : undefined;
  if (only === undefined) return null;
  return [Number(only[2]), Number(only[3]), Number(only[4])];
}

function compare(a: Semver, b: Semver): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const show = (version: Semver): string => version.join('.');

/** The module a changed path belongs to, and whether the change is one that needs a bump. */
function classify(path: string): { readonly id: string; readonly needsBump: boolean } | null {
  if (!path.startsWith(SERVICES)) return null;
  const rest = path.slice(SERVICES.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const inside = rest.slice(slash + 1);
  return {
    id: rest.slice(0, slash),
    needsBump: inside === DEFINITION || inside.startsWith(FIXTURES),
  };
}

export interface ModuleVersionReport {
  readonly base: string;
  readonly lines: readonly string[];
  readonly problems: readonly string[];
}

/** The check itself; throws only when git cannot be run at all. */
export function checkModuleVersions(against: string, head: string): ModuleVersionReport {
  const lines: string[] = [];
  const problems: string[] = [];

  const commits = commitsOf(against, head);
  if ('problems' in commits) return { base: '', lines, problems: commits.problems };
  const { base, headCommit } = commits;

  const changed = changedModules(base, headCommit);
  if (typeof changed === 'string') return { base, lines, problems: [changed] };
  for (const id of [...changed.keys()].sort()) {
    const verdict = judgeModule(id, changed.get(id) ?? [], { base, headCommit, head });
    (verdict.ok ? lines : problems).push(verdict.text);
  }
  return { base, lines, problems };
}

/** The head's commit and its merge base with `against`, or every reason they cannot be had. */
function commitsOf(
  against: string,
  head: string,
):
  | { readonly base: string; readonly headCommit: string }
  | { readonly problems: readonly string[] } {
  const headCommit = commitOf(head);
  const againstCommit = commitOf(against);
  const missing = [
    [head, headCommit],
    [against, againstCommit],
  ]
    .filter(([, commit]) => commit === null)
    .map(
      ([ref]) =>
        `${JSON.stringify(ref)} is not a commit in this clone` +
        (isShallow() ? ' (it is a shallow clone: check out with fetch-depth: 0).' : '.'),
    );
  if (headCommit === null || againstCommit === null) return { problems: missing };

  const mergeBase = git(['merge-base', againstCommit, headCommit]);
  const base = mergeBase.status === 0 ? mergeBase.stdout.toString('utf8').trim() : '';
  if (base !== '') return { base, headCommit };
  const problem =
    `${against} and ${head} have no merge base` +
    (isShallow()
      ? ': this is a shallow clone; check out with fetch-depth: 0.'
      : ': their histories are unrelated, so no change can be judged against it.') +
    (mergeBase.stderr === '' ? '' : ` (git: ${mergeBase.stderr})`);
  return { problems: [problem] };
}

/** Each module whose definition or fixtures changed, with the files that did; or why not read. */
function changedModules(base: string, headCommit: string): Map<string, string[]> | string {
  const diff = git(['diff', '--name-only', '-z', '--no-renames', base, headCommit, '--', SERVICES]);
  if (diff.status !== 0) return `git diff ${base}..${headCommit} failed: ${diff.stderr}`;
  const changed = new Map<string, string[]>();
  for (const path of nulSeparated(diff.stdout)) {
    const touched = classify(path);
    if (touched?.needsBump !== true) continue;
    const list = changed.get(touched.id) ?? [];
    list.push(path.slice(SERVICES.length + touched.id.length + 1));
    changed.set(touched.id, list);
  }
  return changed;
}

/** One module's verdict: a line when its version moved as it must (or need not), else a problem. */
function judgeModule(
  id: string,
  changedFiles: readonly string[],
  at: { readonly base: string; readonly headCommit: string; readonly head: string },
): { readonly ok: boolean; readonly text: string } {
  const files = [...changedFiles].sort();
  const named =
    files.length > 3
      ? `${files.slice(0, 3).join(', ')} and ${String(files.length - 3)} more`
      : files.join(', ');
  const short = at.base.slice(0, 12);
  const definitionPath = `${SERVICES}${id}/${DEFINITION}`;
  const before = fileAt(at.base, definitionPath);
  const after = fileAt(at.headCommit, definitionPath);
  const unreadable = (where: string) => ({
    ok: false,
    text:
      `${id}: the version cannot be read at ${where}: ${DEFINITION} must state ` +
      "`version: 'MAJOR.MINOR.PATCH',` exactly once, as a literal on a line of its own.",
  });

  if (before === null && after === null) {
    return {
      ok: false,
      text:
        `${id}: ${named} changed, but there is no ${definitionPath} at either end — ` +
        "fixtures belong beside a module's definition.",
    };
  }
  if (before === null) {
    const version = after === null ? null : versionIn(after);
    if (version === null) return unreadable(at.head);
    return {
      ok: true,
      text: `${id}: new since ${short}, version ${show(version)} — no bump needed.`,
    };
  }
  if (after === null) return { ok: true, text: `${id}: removed since ${short}.` };

  const was = versionIn(before);
  const now = versionIn(after);
  if (was === null || now === null) return unreadable(was === null ? short : at.head);
  const order = compare(now, was);
  if (order > 0) {
    return { ok: true, text: `${id}: ${named} changed; version ${show(was)} → ${show(now)}.` };
  }
  const moved = order === 0 ? `stayed ${show(now)}` : `went back from ${show(was)} to ${show(now)}`;
  return {
    ok: false,
    text:
      `${id}: ${named} changed, but version ${moved} — bump \`version\` in ` +
      `${definitionPath} above ${show(was)}.`,
  };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      against: { type: 'string', default: 'main' },
      head: { type: 'string', default: 'HEAD' },
    },
    strict: true,
  });
  const report = checkModuleVersions(values.against, values.head);
  const say = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  if (report.base !== '') {
    say(
      `Service modules between ${report.base.slice(0, 12)} (the merge base with ` +
        `${values.against}) and ${values.head}:`,
    );
  }
  for (const line of report.lines) say(`  ${line}`);
  for (const problem of report.problems) process.stderr.write(`  ${problem}\n`);
  if (report.problems.length > 0) {
    process.exitCode = 1;
    return;
  }
  if (report.lines.length === 0) say('  none whose fixtures or definition changed.');
}

if (import.meta.main) main();
