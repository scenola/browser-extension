/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The development manifest key: an RSA-2048 key pair, only the base64 SPKI public key committed
// as `apps/extension/dev-key.pub`; the extension id is the first 32 hex digits of SHA-256 of the
// DER key, mapped `0-f` → `a-p`; a test recomputes the id from the committed key and pins it in
// `apps/extension/dev-extension-id.txt`.

import { createHash, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { extensionIdFromKey, generatePublicKey } from './generate';

const KEY = fileURLToPath(new URL('../../apps/extension/dev-key.pub', import.meta.url));
const ID = fileURLToPath(new URL('../../apps/extension/dev-extension-id.txt', import.meta.url));

/** Chrome's id of a public key, by its documented definition, spelled out here. */
function chromeId(spkiBase64: string): string {
  const der = Buffer.from(spkiBase64.trim(), 'base64');
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  let id = '';
  for (let i = 0; i < hex.length; i += 1) {
    id += 'abcdefghijklmnop'.charAt(Number.parseInt(hex.charAt(i), 16));
  }
  return id;
}

describe('the development key', () => {
  it('the committed key is an RSA-2048 public key in SPKI DER, base64', async () => {
    const der = Buffer.from((await readFile(KEY, 'utf8')).trim(), 'base64');
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    expect(key.asymmetricKeyType).toBe('rsa');
    expect(key.asymmetricKeyDetails?.modulusLength).toBe(2048);
  });

  it('the pinned id is the id of the committed key', async () => {
    const key = await readFile(KEY, 'utf8');
    const pinned = (await readFile(ID, 'utf8')).trim();
    expect(pinned).toMatch(/^[a-p]{32}$/u);
    expect(chromeId(key)).toBe(pinned);
  });

  it("the tool's id is the same computation", async () => {
    const key = await readFile(KEY, 'utf8');
    expect(extensionIdFromKey(key)).toBe(chromeId(key));
    const fresh = generatePublicKey();
    expect(extensionIdFromKey(fresh)).toBe(chromeId(fresh));
  });
});
