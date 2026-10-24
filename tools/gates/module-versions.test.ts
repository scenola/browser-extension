/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The module-version gate (CONTRIBUTING: "Bump the module's `version` whenever a fixture or its
// `definition.ts` changes — CI refuses a pull request that does not"). Each case is a pull
// request in a temporary git repository in the OS temp dir: a `main` with one module, a branch
// with the change, and the real gate copied in and run as CI runs it (`--against main`).

import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const GATE = fileURLToPath(new URL('./module-versions.ts', import.meta.url));
const SERVICES = 'packages/services/src/services';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

const definition = (version: string, extra = ''): string =>
  `export const demo = defineService({\n  id: 'demo',\n  version: '${version}',\n${extra}});\n`;

class Repo {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.dir, env: GIT_ENV, stdio: 'pipe' }).toString();
  }

  async write(path: string, text: string): Promise<void> {
    await mkdir(join(this.dir, path, '..'), { recursive: true });
    await writeFile(join(this.dir, path), text);
  }

  async commit(message: string, files: Readonly<Record<string, string | null>>): Promise<void> {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) this.git('rm', '-q', '--', path);
      else await this.write(path, text);
    }
    this.git('add', '-A');
    this.git('commit', '-q', '--no-gpg-sign', '-m', message);
  }

  /** The gate's exit status for `--against main --head HEAD`. */
  gate(): number {
    try {
      execFileSync(process.execPath, ['tools/gates/module-versions.ts', '--against', 'main'], {
        cwd: this.dir,
        env: GIT_ENV,
        stdio: 'pipe',
      });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? -1;
    }
  }
}

/** `main` holding the gate and the modules demo (0.1.0) and other (1.0.0); a branch `pr` on it. */
async function repo(): Promise<Repo> {
  const dir = await mkdtemp(join(tmpdir(), 'mt-module-versions-test-'));
  scratch.push(dir);
  const r = new Repo(dir);
  r.git('init', '-q', '-b', 'main');
  await mkdir(join(dir, 'tools', 'gates'), { recursive: true });
  await copyFile(GATE, join(dir, 'tools', 'gates', 'module-versions.ts'));
  await r.commit('base', {
    [`${SERVICES}/demo/definition.ts`]: definition('0.1.0'),
    [`${SERVICES}/demo/README.md`]: '# Demo\n',
    [`${SERVICES}/demo/fixtures/episode.snapshot.json`]: '{"synthetic":true,"snapshot":{}}\n',
    [`${SERVICES}/other/definition.ts`]: definition('1.0.0'),
    [`${SERVICES}/other/fixtures/film.snapshot.json`]: '{"synthetic":true,"snapshot":{}}\n',
  });
  r.git('switch', '-q', '-c', 'pr');
  return r;
}

const FIXTURE = `${SERVICES}/demo/fixtures/episode.snapshot.json`;
const DEFINITION = `${SERVICES}/demo/definition.ts`;
const CHANGED = '{"synthetic":false,"snapshot":{"lang":"en"}}\n';

describe('the module-version gate', () => {
  it('passes a pull request that changes no module', async () => {
    const r = await repo();
    await r.commit('docs', { 'README.md': 'hello\n' });
    expect(r.gate()).toBe(0);
  });

  it('refuses a changed fixture without a version bump', async () => {
    const r = await repo();
    await r.commit('fixture', { [FIXTURE]: CHANGED });
    expect(r.gate()).not.toBe(0);
  });

  it('passes a changed fixture with the version bumped', async () => {
    const r = await repo();
    await r.commit('fixture', { [FIXTURE]: CHANGED, [DEFINITION]: definition('0.1.1') });
    expect(r.gate()).toBe(0);
  });

  it('refuses an added fixture, and a removed one, without a bump', async () => {
    const added = await repo();
    await added.commit('add', { [`${SERVICES}/demo/fixtures/film.snapshot.json`]: CHANGED });
    expect(added.gate()).not.toBe(0);
    const removed = await repo();
    await removed.commit('remove', { [FIXTURE]: null });
    expect(removed.gate()).not.toBe(0);
  });

  it('refuses a changed definition without a bump (CONTRIBUTING)', async () => {
    const r = await repo();
    await r.commit('definition', { [DEFINITION]: definition('0.1.0', '  name: "Demo",\n') });
    expect(r.gate()).not.toBe(0);
  });

  it('refuses a version that went down: that is no bump', async () => {
    const r = await repo();
    await r.commit('fixture', { [FIXTURE]: CHANGED, [DEFINITION]: definition('0.0.9') });
    expect(r.gate()).not.toBe(0);
  });

  it("refuses a fixture change when only another module's version moved", async () => {
    const r = await repo();
    await r.commit('fixture', {
      [FIXTURE]: CHANGED,
      [`${SERVICES}/other/definition.ts`]: definition('1.0.1'),
    });
    expect(r.gate()).not.toBe(0);
  });

  it('passes a change to a module’s README alone', async () => {
    const r = await repo();
    await r.commit('readme', { [`${SERVICES}/demo/README.md`]: '# Demo, explained\n' });
    expect(r.gate()).toBe(0);
  });

  it('judges the pull request as a whole: a bump in an earlier commit covers a later fixture change', async () => {
    const r = await repo();
    await r.commit('bump', { [DEFINITION]: definition('0.2.0') });
    await r.commit('fixture', { [FIXTURE]: CHANGED });
    expect(r.gate()).toBe(0);
  });

  it('refuses a fixture changed after main moved on, when the pull request did not bump', async () => {
    // Against the merge base: main's own later commits are not the pull request's.
    const r = await repo();
    await r.commit('fixture', { [FIXTURE]: CHANGED });
    r.git('switch', '-q', 'main');
    await r.commit('main moves', { 'NOTES.md': 'x\n' });
    r.git('switch', '-q', 'pr');
    expect(r.gate()).not.toBe(0);
  });
});
