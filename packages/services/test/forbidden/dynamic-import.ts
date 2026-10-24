/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Loading code at run time. It type-checks (the specifier resolves to the control file);
// ESLint refuses `import()` in src/services/**, whatever it names.

export const later = (): unknown => import('../control/clean-module');
