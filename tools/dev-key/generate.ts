/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The development manifest key: run once. It makes an RSA-2048 key pair, keeps only
// the public half — base64 SPKI DER, what the manifest's `key` takes — and discards the private
// one: an unpacked build needs no private key, and Chrome derives the extension id from the
// public one. That id is what the dev backend's `MT_SCROBBLING_DEV_EXTENSION_IDS` lists.
//
//   node tools/dev-key/generate.ts            write apps/extension/dev-key.pub and
//                                             dev-extension-id.txt (refuses to replace them)
//   node tools/dev-key/generate.ts --dry-run  print them instead
//   node tools/dev-key/generate.ts --id       print the id of the committed key

import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const DEV_KEY_FILE = fileURLToPath(
  new URL('../../apps/extension/dev-key.pub', import.meta.url),
);
export const DEV_ID_FILE = fileURLToPath(
  new URL('../../apps/extension/dev-extension-id.txt', import.meta.url),
);

const A = 'a'.charCodeAt(0);

/**
 * Chrome's id for a public key: the first 32 hex digits of SHA-256 over the DER key, each digit
 * `0`–`f` written as `a`–`p`.
 */
export function extensionIdFromKey(spkiBase64: string): string {
  const der = Buffer.from(spkiBase64.trim(), 'base64');
  if (der.length === 0) throw new Error('the key is not base64');
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return Array.from(hex, (digit) => String.fromCharCode(A + Number.parseInt(digit, 16))).join('');
}

/** A fresh public key, base64 SPKI DER; the private key never leaves this function. */
export function generatePublicKey(): string {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      id: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (values.id) {
    process.stdout.write(`${extensionIdFromKey(await readFile(DEV_KEY_FILE, 'utf8'))}\n`);
    return;
  }
  const key = generatePublicKey();
  const id = extensionIdFromKey(key);
  if (values['dry-run']) {
    process.stdout.write(`dev-key.pub:\n${key}\n\ndev-extension-id.txt:\n${id}\n`);
    return;
  }
  if (existsSync(DEV_KEY_FILE) || existsSync(DEV_ID_FILE)) {
    process.stderr.write(
      'dev-key.pub already exists: the dev backend allowlists its id. Remove it first to replace it.\n',
    );
    process.exitCode = 1;
    return;
  }
  await writeFile(DEV_KEY_FILE, `${key}\n`);
  await writeFile(DEV_ID_FILE, `${id}\n`);
  process.stdout.write(`development extension id: ${id}\n`);
}

if (import.meta.main) await main();
