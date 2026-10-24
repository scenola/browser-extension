/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// dependency-cruiser sees imports, not globals, so the half of `core-no-chrome` that
// is a bare `chrome.runtime` lives here. The other half, a core file importing a
// browser-extension runtime, is in .dependency-cruiser.cjs under the same name.

/** @param {string[]} names @param {string} rule @param {string} why */
function restrict(names, rule, why) {
  return names.map((name) => ({ name, message: `${rule}: ${why}` }));
}

/** @type {import('eslint').Linter.Config} */
export const coreNoChromeConfig = {
  files: ['packages/core/**/*.{ts,tsx}'],
  rules: {
    'no-restricted-globals': [
      'error',
      ...restrict(
        ['chrome', 'browser'],
        'core-no-chrome',
        'packages/core is pure; reach the browser through a port.',
      ),
      ...restrict(
        [
          'window',
          'document',
          'localStorage',
          'sessionStorage',
          'indexedDB',
          'navigator',
          'location',
        ],
        'core-no-dom',
        'packages/core has no DOM; reach the page or storage through a port.',
      ),
    ],
  },
};
