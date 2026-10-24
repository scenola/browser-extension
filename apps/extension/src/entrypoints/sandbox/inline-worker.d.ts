/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A worker imported with `?worker&inline` (main.ts): Vite bundles the file as a worker of its own
// and writes its code into the importer as a string, and the import is the constructor that
// starts it from a `blob:` address — the one kind of worker the sandbox's policy allows.

declare module '*?worker&inline' {
  const InlineWorker: new (options?: { readonly name?: string }) => Worker;
  export default InlineWorker;
}
