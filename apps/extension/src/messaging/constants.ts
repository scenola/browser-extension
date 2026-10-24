/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The two facts a page needs to talk to the worker, alone: importing `protocol.ts` for them
// brought its validators, and through them the whole registry's data, into every page.
// `protocol.ts` re-exports both, so the worker reads them where it always did; a page imports
// them from here (`.dependency-cruiser.cjs`, pages-take-no-protocol).

/** The version every message carries, content and ui channels alike. */
export const PROTOCOL_VERSION = 1;

/** The name of the port the extension's own pages open to the worker. */
export const UI_PORT_NAME = 'ui';
