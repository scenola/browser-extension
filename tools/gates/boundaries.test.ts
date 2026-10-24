/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cruise } from 'dependency-cruiser';
import extractDepcruiseConfig from 'dependency-cruiser/config-utl/extract-depcruise-config';
import { ESLint } from 'eslint';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HEADER = '// fixture\n';

interface Violation {
  rule: string;
  from: string;
}

const sandboxes: string[] = [];

function write(sandbox: string, relativePath: string, text: string): void {
  const target = join(sandbox, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

/**
 * A workspace package. When `linked`, it is symlinked into node_modules the way pnpm
 * links a package that the importer declares; when not, an import of it is unresolved,
 * the way a real undeclared `import '@mt/api'` is.
 */
function workspacePackage(sandbox: string, name: string, linked: boolean): void {
  write(
    sandbox,
    `packages/${name}/package.json`,
    JSON.stringify({ name: `@mt/${name}`, type: 'module', exports: { '.': './src/index.ts' } }),
  );
  write(sandbox, `packages/${name}/src/index.ts`, `${HEADER}export const ${name} = 1;\n`);
  if (!linked) return;
  mkdirSync(join(sandbox, 'node_modules', '@mt'), { recursive: true });
  symlinkSync(join(sandbox, 'packages', name), join(sandbox, 'node_modules', '@mt', name), 'dir');
}

function imports(sandbox: string, file: string, specifier: string): void {
  write(sandbox, file, `${HEADER}import '${specifier}';\n`);
}

async function violationsIn(
  sandbox: string,
  folders: readonly string[] = ['packages'],
): Promise<Violation[]> {
  const config = await extractDepcruiseConfig(join(repoRoot, '.dependency-cruiser.cjs'));
  const result = await cruise([...folders], {
    ...config.options,
    ruleSet: config,
    validate: true,
    baseDir: sandbox,
    tsPreCompilationDeps: true,
  });
  if (typeof result.output === 'string') throw new Error('expected an object report');
  return result.output.summary.violations.map((v) => ({ rule: v.rule.name, from: v.from }));
}

let linkedViolations: Violation[] = [];
let unlinkedViolations: Violation[] = [];

beforeAll(async () => {
  const linked = mkdtempSync(join(tmpdir(), 'mt-boundaries-linked-'));
  const unlinked = mkdtempSync(join(tmpdir(), 'mt-boundaries-unlinked-'));
  sandboxes.push(linked, unlinked);

  for (const name of ['core', 'api', 'services']) workspacePackage(linked, name, true);
  write(
    linked,
    'node_modules/webextension-polyfill/package.json',
    '{"name":"webextension-polyfill","main":"index.js"}',
  );
  write(linked, 'node_modules/webextension-polyfill/index.js', 'module.exports = {};\n');
  imports(linked, 'packages/core/src/x.ts', '@mt/api');
  imports(linked, 'packages/core/src/w.ts', 'webextension-polyfill');
  imports(linked, 'packages/services/src/x.ts', '@mt/api');
  imports(linked, 'packages/api/src/x.ts', '@mt/services');
  imports(linked, 'packages/api/src/z.ts', '@mt/core');
  // The extension: module code in the sandbox's worker alone, started by the sandbox page alone.
  const sandboxDir = 'apps/extension/src/entrypoints/sandbox';
  imports(linked, `${sandboxDir}/interpret-worker.ts`, '@mt/services');
  imports(linked, `${sandboxDir}/main.ts`, './interpret-worker?worker&inline');
  imports(linked, `${sandboxDir}/relay.ts`, '@mt/services');
  imports(linked, 'apps/extension/src/ui/x.ts', '../entrypoints/sandbox/interpret-worker');

  // Nothing is linked and nothing is installed: every import below is unresolved.
  for (const name of ['core', 'api', 'services']) workspacePackage(unlinked, name, false);
  imports(unlinked, 'packages/core/src/x.ts', '@mt/api');
  imports(unlinked, 'packages/core/src/s.ts', '@mt/services/deep');
  imports(unlinked, 'packages/core/src/a.ts', '@mt/extension');
  imports(unlinked, 'packages/core/src/w.ts', 'wxt');
  imports(unlinked, 'packages/core/src/p.ts', 'webextension-polyfill');
  imports(unlinked, 'packages/core/src/c.ts', '@types/chrome');
  imports(unlinked, 'packages/services/src/x.ts', '@mt/api');
  imports(unlinked, 'packages/api/src/x.ts', '@mt/services');
  imports(unlinked, 'packages/api/src/y.ts', '@mt/extension');
  imports(unlinked, 'packages/api/src/z.ts', '@mt/core');

  linkedViolations = await violationsIn(linked, ['packages', 'apps']);
  unlinkedViolations = await violationsIn(unlinked);
});

afterAll(() => {
  for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
});

describe('dependency-cruiser layers, packages linked', () => {
  it('refuses core importing @mt/api as core-is-pure', () => {
    expect(linkedViolations).toContainEqual({
      rule: 'core-is-pure',
      from: 'packages/core/src/x.ts',
    });
  });

  it('refuses services importing @mt/api as services-only-core', () => {
    expect(linkedViolations).toContainEqual({
      rule: 'services-only-core',
      from: 'packages/services/src/x.ts',
    });
  });

  it('refuses api importing @mt/services as api-only-core', () => {
    expect(linkedViolations).toContainEqual({
      rule: 'api-only-core',
      from: 'packages/api/src/x.ts',
    });
  });

  it('refuses core importing a browser-extension runtime as core-no-chrome', () => {
    expect(linkedViolations).toContainEqual({
      rule: 'core-no-chrome',
      from: 'packages/core/src/w.ts',
    });
  });

  it('allows api importing @mt/core', () => {
    expect(linkedViolations.filter((v) => v.from === 'packages/api/src/z.ts')).toEqual([]);
  });
});

describe('dependency-cruiser, the module code in the extension', () => {
  const from = (file: string) => linkedViolations.filter((v) => v.from === file);

  it('refuses @mt/services anywhere but the sandbox’s worker, the sandbox page’s folder included', () => {
    expect(linkedViolations).toContainEqual({
      rule: 'runtime-takes-no-module-code',
      from: 'apps/extension/src/entrypoints/sandbox/relay.ts',
    });
    expect(from('apps/extension/src/entrypoints/sandbox/interpret-worker.ts')).toEqual([]);
  });

  it('refuses the worker to anything but the sandbox page', () => {
    expect(linkedViolations).toContainEqual({
      rule: 'only-the-sandbox-starts-its-worker',
      from: 'apps/extension/src/ui/x.ts',
    });
    expect(from('apps/extension/src/entrypoints/sandbox/main.ts')).toEqual([]);
  });
});

describe('dependency-cruiser layers, imports that do not resolve', () => {
  const cases: [string, string, string][] = [
    ['core importing @mt/api', 'core-is-pure', 'packages/core/src/x.ts'],
    ['core importing @mt/services/deep', 'core-is-pure', 'packages/core/src/s.ts'],
    ['core importing @mt/extension', 'core-is-pure', 'packages/core/src/a.ts'],
    ['core importing wxt', 'core-no-chrome', 'packages/core/src/w.ts'],
    ['core importing webextension-polyfill', 'core-no-chrome', 'packages/core/src/p.ts'],
    ['core importing @types/chrome', 'core-no-chrome', 'packages/core/src/c.ts'],
    ['services importing @mt/api', 'services-only-core', 'packages/services/src/x.ts'],
    ['api importing @mt/services', 'api-only-core', 'packages/api/src/x.ts'],
    ['api importing @mt/extension', 'api-only-core', 'packages/api/src/y.ts'],
  ];

  it.each(cases)('names %s as %s', (_label, rule, from) => {
    expect(unlinkedViolations).toContainEqual({ rule, from });
  });

  it('flags any unresolved import in packages/, even an allowed one', () => {
    expect(unlinkedViolations).toContainEqual({
      rule: 'no-unresolvable-in-packages',
      from: 'packages/api/src/z.ts',
    });
  });
});

describe('core-no-chrome in the real ESLint config', () => {
  async function restrictedGlobals(file: string): Promise<string[]> {
    const eslint = new ESLint({ cwd: repoRoot });
    const config = (await eslint.calculateConfigForFile(file)) as {
      rules?: Record<string, unknown[] | undefined>;
    };
    const entry = config.rules?.['no-restricted-globals'];
    if (!entry) return [];
    return entry
      .slice(1)
      .map((item) => item as { name: string; message: string })
      .map((item) => `${item.name}|${item.message}`);
  }

  it('restricts chrome and browser in packages/core, naming core-no-chrome', async () => {
    const restricted = await restrictedGlobals('packages/core/src/index.ts');
    expect(restricted).toContainEqual(expect.stringMatching(/^chrome\|core-no-chrome:/));
    expect(restricted).toContainEqual(expect.stringMatching(/^browser\|core-no-chrome:/));
  });

  it('restricts the DOM globals in packages/core as core-no-dom', async () => {
    const restricted = await restrictedGlobals('packages/core/src/index.ts');
    expect(restricted).toContainEqual(expect.stringMatching(/^document\|core-no-dom:/));
  });

  it('does not restrict them in apps/extension or the other packages', async () => {
    for (const file of [
      'apps/extension/src/index.ts',
      'packages/api/src/index.ts',
      'packages/services/src/index.ts',
    ]) {
      expect(await restrictedGlobals(file)).toEqual([]);
    }
  });

  it('refuses a real chrome reference in core when the effective config lints it', async () => {
    const eslint = new ESLint({ cwd: repoRoot });
    const config = (await eslint.calculateConfigForFile('packages/core/src/index.ts')) as {
      rules?: Record<string, unknown[] | undefined>;
    };
    expect(config.rules?.['no-restricted-globals']?.[0]).toBe(2);
  });
});
