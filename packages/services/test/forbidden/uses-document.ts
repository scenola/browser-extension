/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A module reading the page itself. Under tsconfig.modules.json there is no DOM library,
// so `document` does not exist; the page reaches a module only as a snapshot.
export const title: string = document.title;
