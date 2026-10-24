/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The server's latest DPoP nonce: in memory, and in `chrome.storage.session` so a restarted
// worker does not pay a round trip for it. The nonce is not a secret and losing it costs one
// retry, never a play; `storage.session` is closed to content scripts by default.

import { parseDpopNonce } from '@mt/api';
import type { NonceStore } from '@mt/api';
import type { Browser } from 'wxt/browser';

const KEY = 'dpopNonce';

export class SessionNonceStore implements NonceStore {
  readonly #area: Browser.storage.StorageArea;
  #current: string | null = null;

  constructor(area: Browser.storage.StorageArea) {
    this.#area = area;
  }

  async get(): Promise<string | null> {
    if (this.#current !== null) return this.#current;
    const stored = await this.#area.get(KEY);
    const nonce = parseDpopNonce(stored[KEY]);
    if (nonce !== null) this.#current = nonce;
    return nonce;
  }

  /** Keeps `nonce` only when it is one; otherwise the previous stays (`NonceStore`). */
  async set(nonce: string): Promise<void> {
    const parsed = parseDpopNonce(nonce);
    if (parsed === null) return;
    this.#current = parsed;
    await this.#area.set({ [KEY]: parsed });
  }
}
