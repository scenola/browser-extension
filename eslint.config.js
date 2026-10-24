/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

import { servicesModulesConfig } from './packages/services/eslint.modules.js';
import { coreNoChromeConfig } from './tools/lint/core-purity.js';
import { ignoredByGit } from './tools/lint/git-files.js';
import mplHeader from './tools/lint/mpl-header.js';
import { readabilityConfig } from './tools/lint/readability.js';

// Generated code is held to its generator by `pnpm openapi:check` and `pnpm i18n:check`
// (regenerate, compare), not to the style rules; it is still parsed, so the MPL notice rule sees it.
const GENERATED = ['packages/api/src/generated/**', 'apps/extension/src/i18n/generated/**'];

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.output/**',
      '**/.wxt/**',
      'coverage/**',
      // What git ignores is not the repository's (tools/lint/git-files.js).
      ...ignoredByGit(import.meta.dirname),
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    ignores: GENERATED,
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `import { type X } from 'm'` keeps `import {} from 'm'` under verbatimModuleSyntax, so the
      // module still runs. The dependency rules exempt type-only imports of @mt/services
      // (.dependency-cruiser.cjs, runtime-takes-no-module-code) only because a type-only import
      // is then always `import type`, which compiles away.
      '@typescript-eslint/no-import-type-side-effects': 'error',
    },
  },
  {
    files: GENERATED,
    languageOptions: { parser: tseslint.parser },
  },
  {
    files: ['**/*.{js,cjs,mjs}'],
    extends: [js.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { module: 'readonly', require: 'readonly', process: 'readonly' },
    },
  },
  {
    files: ['**/*.{ts,tsx,js,cjs,mjs}'],
    plugins: { local: { rules: { 'mpl-header': mplHeader } } },
    rules: { 'local/mpl-header': 'error' },
  },
  coreNoChromeConfig,
  servicesModulesConfig,
  readabilityConfig,
);
