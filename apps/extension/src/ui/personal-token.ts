/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A store build has no personal tokens, so its pages must not name the strategy either. The mode
// is read from `import.meta.env` here, not through `config.ts`: the build replaces it with a
// literal, the comparison folds to `false` and takes the name with it — a constant imported from
// another module does not fold. The store build refuses a bundle that still names it
// (`wxt.config.ts`).

/** Whether a connection was made with a personal token. Always `false` in a store build. */
export function isPersonalToken(strategy: string): strategy is 'personal_token' {
  return import.meta.env.MT_BUILD_MODE !== 'store' && strategy === 'personal_token';
}
