/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A module calling out. Neither the DOM library nor Node's types are loaded under
// tsconfig.modules.json, so `fetch` does not exist (and the sandbox has no network).
export function send(title: string): unknown {
  return fetch(`https://collector.example/?t=${title}`);
}
