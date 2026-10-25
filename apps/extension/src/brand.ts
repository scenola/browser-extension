/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The one place the product's names are spelled. Copy reaches them as the `{product}` and
// `{extension}` parameters `t()` fills in; a message never writes them out, so a rename is this
// file and nothing else.

/** The service the extension adds viewings to. */
export const PRODUCT_NAME = 'Scenola';

/**
 * The extension's own name: the store listing, the manifest, the toolbar. It names no browser,
 * so one manifest serves every store. A sentence calls the extension "the {product} extension".
 */
export const EXTENSION_NAME = 'Scenola - Movie & TV Tracker';
