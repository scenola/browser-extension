/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { WIRE_ERROR_FIELDS } from '../../packages/api/src/wire';

// The backend repository is a sibling of this one: <parent>/extension/tools/gates -> <parent>/backend.
const PLAYS_MD = fileURLToPath(
  new URL('../../../backend/docs/integrations/plays.md', import.meta.url),
);
const present = existsSync(PLAYS_MD);

/** The field names of plays.md's "One envelope: `{"error": {...}}`" sentence, or `null`. */
function envelopeFields(text: string): string[] | null {
  const match = /One envelope: `\{"error": \{([^}`]{0,2000})\}\}`/u.exec(text);
  if (match?.[1] === undefined) return null;
  return [...match[1].matchAll(/"([a-z_]{1,64})"/gu)].map((m) => m[1] ?? '');
}

describe('the error envelope and the backend contract', () => {
  test('envelopeFields reads the sentence across a line break, and nothing else', () => {
    expect(
      envelopeFields('One envelope: `{"error": {"code", "message",\n"retry_after_seconds"}}`.'),
    ).toEqual(['code', 'message', 'retry_after_seconds']);
    expect(envelopeFields('Two envelopes: `{"error": {"code"}}`')).toBeNull();
  });

  test.skipIf(!present)(`plays.md names exactly WIRE_ERROR_FIELDS (${PLAYS_MD})`, async () => {
    const fields = envelopeFields(await readFile(PLAYS_MD, 'utf8'));
    expect(
      fields,
      'plays.md no longer has the "One envelope: `{"error": {…}}`" sentence',
    ).not.toBeNull();
    expect(fields).toEqual([...WIRE_ERROR_FIELDS]);
  });

  test.skipIf(present)(`backend repo not found at ${PLAYS_MD}: contract not checked`, () => {
    // Skipped on purpose when the sibling backend checkout is absent.
  });
});
