/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The modules' guard rails, proven able to fail. Every file in test/forbidden/
// is compiled with tsconfig.modules.json's own options and linted with the repository's
// real ESLint configuration, and each must be refused for its own reason; the control file
// beside them must pass both, so a harness that compiles or lints nothing cannot pass.

import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ESLint } from 'eslint';
import type { Linter, Rule } from 'eslint';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const FORBIDDEN_DIR = join(PACKAGE_ROOT, 'test', 'forbidden');
const CONTROL_FILE = join(PACKAGE_ROOT, 'test', 'control', 'clean-module.ts');
const MODULES_TSCONFIG = join(PACKAGE_ROOT, 'tsconfig.modules.json');

/** Where a real module lives; the rules must apply there, not only to the specimens. */
const MODULE_FILE = 'packages/services/src/services/example/definition.ts';

/** The globals a module may name: the brief's eight, and `undefined`, which is not a capability. */
const ALLOWED_GLOBALS = [
  'Array',
  'Date',
  'JSON',
  'Math',
  'Number',
  'Object',
  'RegExp',
  'String',
  'undefined',
];

/** TypeScript's "Cannot find name" diagnostics (plain, and with its DOM-library hint). */
const CANNOT_FIND_NAME = [2304, 2584];

interface Refusal {
  readonly ruleId: string;
  readonly needle: string;
  readonly line: number;
}

interface Specimen {
  /** `null`: compiles clean, so only ESLint stands between it and a module. */
  readonly undeclared: string | null;
  readonly refusals: readonly Refusal[];
}

const SPECIMENS: Readonly<Record<string, Specimen>> = {
  'uses-document.ts': {
    undeclared: 'document',
    refusals: [{ ruleId: 'no-undef', needle: "'document' is not defined", line: 7 }],
  },
  'uses-fetch.ts': {
    undeclared: 'fetch',
    refusals: [{ ruleId: 'no-undef', needle: "'fetch' is not defined", line: 8 }],
  },
  'uses-chrome.ts': {
    undeclared: 'chrome',
    refusals: [{ ruleId: 'no-undef', needle: "'chrome' is not defined", line: 7 }],
  },
  'eslint-escapes.ts': {
    undeclared: null,
    refusals: [
      { ruleId: 'no-restricted-globals', needle: "'globalThis'. services-globals:", line: 8 },
      { ruleId: 'no-restricted-globals', needle: "'Function'. services-globals:", line: 11 },
      { ruleId: 'no-restricted-syntax', needle: 'services-any:', line: 15 },
    ],
  },
  'uses-eval.ts': {
    undeclared: null,
    refusals: [
      { ruleId: 'no-restricted-globals', needle: "'eval'. services-globals:", line: 8 },
      { ruleId: 'no-restricted-globals', needle: "'eval'. services-globals:", line: 11 },
    ],
  },
  'dynamic-import.ts': {
    undeclared: null,
    refusals: [{ ruleId: 'no-restricted-syntax', needle: 'services-dynamic-import:', line: 8 }],
  },
  'computed-access.ts': {
    undeclared: null,
    refusals: [
      { ruleId: 'services/computed-access', needle: 'services-computed-access:', line: 9 },
      { ruleId: 'services/computed-access', needle: 'services-computed-access:', line: 13 },
      { ruleId: 'services/computed-access', needle: 'services-computed-access:', line: 18 },
    ],
  },
  'uses-builtin.ts': {
    undeclared: null,
    refusals: [
      { ruleId: 'no-restricted-globals', needle: "'Promise'. services-globals:", line: 8 },
      { ruleId: 'no-restricted-globals', needle: "'Reflect'. services-globals:", line: 10 },
    ],
  },
  'reaches-function.ts': {
    undeclared: null,
    refusals: [
      { ruleId: 'no-restricted-properties', needle: "'constructor'", line: 8 },
      { ruleId: 'no-restricted-properties', needle: "'__proto__'", line: 10 },
      { ruleId: 'no-restricted-properties', needle: "'Object.getPrototypeOf'", line: 12 },
      { ruleId: 'no-restricted-properties', needle: "'Object.getOwnPropertyDescriptor'", line: 15 },
    ],
  },
  'inline-disable.ts': {
    undeclared: null,
    refusals: [
      { ruleId: 'no-restricted-globals', needle: "'globalThis'. services-globals:", line: 9 },
    ],
  },
  'ts-nocheck.ts': {
    undeclared: null,
    refusals: [
      { ruleId: '@typescript-eslint/ban-ts-comment', needle: '@ts-nocheck', line: 5 },
      { ruleId: 'no-undef', needle: "'document' is not defined", line: 9 },
    ],
  },
};

function modulesConfig(): ts.ParsedCommandLine {
  const read = ts.readConfigFile(MODULES_TSCONFIG, (path) => ts.sys.readFile(path));
  if (read.error !== undefined) throw new Error(text(read.error));
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    PACKAGE_ROOT,
    undefined,
    MODULES_TSCONFIG,
  );
  if (parsed.errors.length > 0) throw new Error(parsed.errors.map(text).join('\n'));
  return parsed;
}

function text(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

/** One file, alone, under tsconfig.modules.json's options (emitting nothing). */
function compile(file: string): readonly ts.Diagnostic[] {
  const options: ts.CompilerOptions = {
    ...modulesConfig().options,
    composite: false,
    incremental: false,
    declaration: false,
    emitDeclarationOnly: false,
    noEmit: true,
  };
  return ts.getPreEmitDiagnostics(ts.createProgram({ rootNames: [file], options }));
}

interface EffectiveConfig {
  readonly rules?: Readonly<Record<string, readonly unknown[] | undefined>>;
  readonly linterOptions?: { readonly noInlineConfig?: boolean };
  readonly languageOptions?: {
    readonly ecmaVersion?: unknown;
    readonly parserOptions?: { readonly lib?: unknown };
  };
}

async function effectiveConfig(file: string): Promise<EffectiveConfig> {
  const eslint = new ESLint({ cwd: REPO_ROOT, ignore: false });
  return (await eslint.calculateConfigForFile(file)) as EffectiveConfig;
}

/** The guard rails' share of a file's effective configuration. */
async function guardRails(file: string): Promise<unknown> {
  const config = await effectiveConfig(file);
  const rules = config.rules ?? {};
  return {
    rules: Object.fromEntries(
      [
        'no-restricted-globals',
        'no-undef',
        'no-restricted-syntax',
        'no-restricted-properties',
        'services/computed-access',
        '@typescript-eslint/ban-ts-comment',
        'no-eval',
        'no-new-func',
      ].map((id) => [id, rules[id]]),
    ),
    noInlineConfig: config.linterOptions?.noInlineConfig,
    ecmaVersion: config.languageOptions?.ecmaVersion,
    lib: config.languageOptions?.parserOptions?.lib,
  };
}

function restrictedNames(entry: readonly unknown[] | undefined): Set<string> {
  return new Set(
    (entry ?? [])
      .slice(1)
      .map((item) => (typeof item === 'string' ? item : (item as { name: string }).name)),
  );
}

/** Reports every value global a file can see, by name, from ESLint's own scope analysis. */
const globalsProbe: Rule.RuleModule = {
  meta: { type: 'problem', schema: [], messages: { global: '{{name}}' } },
  create(context) {
    return {
      'Program:exit'(node) {
        let scope = context.sourceCode.getScope(node);
        while (scope.upper !== null) scope = scope.upper;
        for (const variable of scope.variables) {
          if ((variable as { isValueVariable?: boolean }).isValueVariable === false) continue;
          context.report({ node, messageId: 'global', data: { name: variable.name } });
        }
      },
    };
  },
};

const forbiddenFiles = readdirSync(FORBIDDEN_DIR)
  .filter((name) => name.endsWith('.ts'))
  .sort();
const lintMessages = new Map<string, readonly Linter.LintMessage[]>();

beforeAll(async () => {
  const eslint = new ESLint({ cwd: REPO_ROOT, ignore: false });
  const files = [...forbiddenFiles.map((name) => join(FORBIDDEN_DIR, name)), CONTROL_FILE];
  for (const result of await eslint.lintFiles(files)) {
    lintMessages.set(result.filePath, result.messages);
  }
}, 180_000);

function messagesOf(file: string): readonly Linter.LintMessage[] {
  const messages = lintMessages.get(file);
  if (messages === undefined) throw new Error(`ESLint did not lint ${file}`);
  return messages;
}

describe('tsconfig.modules.json', () => {
  it('has no DOM library and no ambient types, and compiles every module', () => {
    const config = modulesConfig();
    expect(config.options.lib).toEqual(['lib.es2023.d.ts']);
    expect(config.options.types).toEqual([]);
    const fileNames = config.fileNames.map((name) => resolve(name));
    for (const file of ['sdk.ts', 'helpers.ts', 'registry.ts', 'index.ts']) {
      expect(fileNames).toContain(join(PACKAGE_ROOT, 'src', file));
    }
    expect(fileNames.some((name) => name.endsWith('.test.ts'))).toBe(false);
    const raw = config.raw as { include?: unknown; exclude?: unknown };
    expect(raw.include).toEqual(['src/**/*.ts']);
    expect(raw.exclude).toEqual(['src/**/*.test.ts']);
  });

  it('is built by `pnpm typecheck` (the root tsconfig references it)', () => {
    const rootConfig = join(REPO_ROOT, 'tsconfig.json');
    const root = ts.readConfigFile(rootConfig, (path) => ts.sys.readFile(path));
    const references = (root.config as { references?: { path: string }[] }).references ?? [];
    expect(references.map((reference) => reference.path)).toContain(
      'packages/services/tsconfig.modules.json',
    );
  });
});

describe('the control module', () => {
  it('compiles clean under tsconfig.modules.json', () => {
    expect(compile(CONTROL_FILE).map(text)).toEqual([]);
  });

  it('lints clean under the modules’ rules', () => {
    expect(messagesOf(CONTROL_FILE)).toEqual([]);
  });
});

describe('the forbidden specimens', () => {
  it('are exactly the files in test/forbidden/, each with its expected refusal', () => {
    expect(forbiddenFiles).toEqual(Object.keys(SPECIMENS).sort());
  });

  describe.each(Object.entries(SPECIMENS))('%s', (name, specimen) => {
    const file = join(FORBIDDEN_DIR, name);

    if (specimen.undeclared === null) {
      it('compiles clean, so ESLint is what refuses it', () => {
        expect(compile(file).map(text)).toEqual([]);
      });
    } else {
      const undeclared = specimen.undeclared;
      it(`does not compile: '${undeclared}' is not declared`, () => {
        const diagnostics = compile(file);
        expect(diagnostics.length).toBeGreaterThan(0);
        for (const diagnostic of diagnostics) {
          expect(CANNOT_FIND_NAME).toContain(diagnostic.code);
          expect(text(diagnostic)).toMatch(new RegExp(`^Cannot find name '${undeclared}'\\.`));
          expect(diagnostic.file?.fileName).toBe(file);
        }
      });
    }

    it('is refused by ESLint for its own reason', () => {
      const messages = messagesOf(file);
      expect(messages.filter((message) => message.fatal === true)).toEqual([]);
      for (const refusal of specimen.refusals) {
        expect(messages).toContainEqual(
          expect.objectContaining({
            ruleId: refusal.ruleId,
            severity: 2,
            line: refusal.line,
            message: expect.stringContaining(refusal.needle) as unknown,
          }),
        );
      }
    });
  });
});

describe('the modules’ ESLint configuration', () => {
  it('applies to src/services/** exactly as to the specimens and the control', async () => {
    const real = await guardRails(MODULE_FILE);
    expect(await guardRails(join(FORBIDDEN_DIR, 'eslint-escapes.ts'))).toEqual(real);
    expect(await guardRails(CONTROL_FILE)).toEqual(real);
  });

  it('is on, at error, with inline configuration ignored and the library pinned', async () => {
    const config = await effectiveConfig(MODULE_FILE);
    expect(config.rules?.['no-undef']).toEqual([2, { typeof: true }]);
    expect(config.rules?.['no-restricted-globals']?.[0]).toBe(2);
    expect(config.rules?.['services/computed-access']).toEqual([2]);
    expect(config.linterOptions?.noInlineConfig).toBe(true);
    expect(config.languageOptions?.parserOptions?.lib).toEqual(['es2023']);
  });

  it('does not apply to the SDK, the registry or other packages', async () => {
    for (const file of [
      'packages/services/src/sdk.ts',
      'packages/services/src/registry.ts',
      'packages/core/src/index.ts',
      'apps/extension/src/index.ts',
    ]) {
      const config = await effectiveConfig(file);
      expect(config.rules?.['services/computed-access']).toBeUndefined();
      expect(config.linterOptions?.noInlineConfig).not.toBe(true);
    }
  });

  it('leaves a module no value global but the allowed ones', async () => {
    const restricted = restrictedNames(
      (await effectiveConfig(MODULE_FILE)).rules?.['no-restricted-globals'],
    );
    const eslint = new ESLint({
      cwd: REPO_ROOT,
      ignore: false,
      overrideConfig: [
        {
          files: ['packages/services/test/control/*.ts'],
          plugins: { probe: { rules: { globals: globalsProbe } } },
          rules: { 'probe/globals': 'error' },
        },
      ],
    });
    const [result] = await eslint.lintFiles([CONTROL_FILE]);
    const visible = (result?.messages ?? [])
      .filter((message) => message.ruleId === 'probe/globals')
      .map((message) => message.message);
    expect(visible.length).toBeGreaterThan(ALLOWED_GLOBALS.length);
    expect(visible.filter((name) => !restricted.has(name)).sort()).toEqual(ALLOWED_GLOBALS);
    expect([...restricted].filter((name) => ALLOWED_GLOBALS.includes(name))).toEqual([]);
  }, 120_000);
});
