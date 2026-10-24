/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The readability budget, imported by the root eslint.config.js: warnings when code grows past
// what a reader takes in at once — a function with too many paths through it, nested too deep,
// too long or taking too many arguments, a file too long to hold one idea. They warn rather than
// fail, so a change can land and be split after; in CI each warning is an annotation on the line
// that raised it (tools/lint/formatter.js). The code holds none today: a warning is news.
//
// A file may be excused only for a reason the code cannot change, written beside its entry
// below. A long function that is long because it does many things is split instead.

/** Lines that count: blank lines and comments do not. */
const COUNTED = { skipBlankLines: true, skipComments: true };

const SOURCES = ['**/*.{ts,tsx,js,cjs,mjs}'];

/** Generated code answers to its generator, not to these rules. */
const GENERATED = ['packages/api/src/generated/**', 'apps/extension/src/i18n/generated/**'];

/**
 * Tests and test infrastructure: a test file is many short cases, so it is long without being
 * hard to read; a case is a callback inside a `describe`'s; and a table's columns and a
 * property's generators arrive as one parameter each.
 */
const TESTS = [
  '**/*.test.{ts,tsx}',
  '**/*.test-d.ts',
  '**/*.spec.ts',
  '**/testing/**',
  // A module only tests import is named for it: test-world.ts, test-harness.ts, test-client.ts.
  '**/test-*.ts',
  'apps/extension/test/**',
  'apps/extension/e2e/**',
  'apps/extension/e2e-stack/**',
  'packages/services/test/**',
];

export const readabilityConfig = [
  {
    files: SOURCES,
    ignores: GENERATED,
    rules: {
      complexity: ['warn', 20],
      'max-depth': ['warn', 4],
      'max-params': ['warn', 5],
      'max-nested-callbacks': ['warn', 4],
      'max-lines-per-function': ['warn', { max: 120, ...COUNTED }],
      'max-lines': ['warn', { max: 500, ...COUNTED }],
    },
  },
  {
    files: TESTS,
    rules: {
      'max-lines-per-function': 'off',
      'max-params': 'off',
      'max-nested-callbacks': ['warn', 6],
      'max-lines': ['warn', { max: 1200, ...COUNTED }],
    },
  },
  {
    // Chrome serialises `readStatePath` and runs it in the page's MAIN world, where it must be
    // one self-contained function — no import, no helper outside its body — written against a
    // hostile page with indexed loops and its own bounds. Its length and branching are that.
    files: ['apps/extension/src/collector/state-path-reader.ts'],
    rules: { complexity: 'off', 'max-depth': 'off', 'max-lines-per-function': 'off' },
  },
];
