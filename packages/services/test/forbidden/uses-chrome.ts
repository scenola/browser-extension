/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A module reaching for the extension's own API. No `chrome` types are loaded under
// tsconfig.modules.json (and the sandbox has no `chrome.*`).
export const extensionId: unknown = chrome.runtime.id;
