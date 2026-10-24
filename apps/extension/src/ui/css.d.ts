/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A stylesheet is imported for its effect alone (src/ui/page.tsx): the build bundles it and links
// it from the page. It exports nothing.

declare module '*.css';
