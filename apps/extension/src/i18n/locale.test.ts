/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Which catalog a UI language gets (the tag, its alias, its language; English otherwise) and how
// it is loaded (on demand, English when the load fails).

import { describe, expect, test, vi } from 'vitest';

import { matchUiLocale, pickCatalog } from './locale';

const AVAILABLE = ['en', 'de', 'pt-BR', 'pt-PT', 'zh-Hans', 'zh-Hant', 'nb', 'sr-Cyrl', 'sr-Latn'];

describe('matchUiLocale', () => {
  test.each([
    ['de', 'de'],
    ['de-AT', 'de'],
    ['DE_at', 'de'],
    ['pt', 'pt-BR'],
    ['pt-PT', 'pt-PT'],
    ['zh-CN', 'zh-Hans'],
    ['zh-TW', 'zh-Hant'],
    ['zh', 'zh-Hans'],
    ['no', 'nb'],
    ['nn', 'nb'],
    ['sr', 'sr-Cyrl'],
    ['sr-Latn', 'sr-Latn'],
    ['en-GB', 'en'],
  ])('%s → %s', (tag, locale) => {
    expect(matchUiLocale(tag, AVAILABLE)).toBe(locale);
  });

  test('a language without a catalog, or no tag, is English: null', () => {
    expect(matchUiLocale('fr-FR', AVAILABLE)).toBeNull();
    expect(matchUiLocale('  ', AVAILABLE)).toBeNull();
  });
});

interface Fake {
  readonly locale: string;
}

const SOURCE: Fake = { locale: 'en' };

describe('pickCatalog', () => {
  test('the source for a tag it matches, or none matches, loading nothing', async () => {
    const de = vi.fn(() => Promise.resolve({ locale: 'de' }));
    expect(await pickCatalog('en-US', SOURCE, { de })).toBe(SOURCE);
    expect(await pickCatalog('fr', SOURCE, { de })).toBe(SOURCE);
    expect(de).not.toHaveBeenCalled();
  });

  test("the matching translation's loader, once", async () => {
    const german = { locale: 'de' };
    const de = vi.fn(() => Promise.resolve(german));
    expect(await pickCatalog('de-CH', SOURCE, { de })).toBe(german);
    expect(de).toHaveBeenCalledTimes(1);
  });

  test('the source when the load fails or hands back another locale', async () => {
    const failing = (): Promise<Fake> => Promise.reject(new Error('chunk missing'));
    expect(await pickCatalog('de', SOURCE, { de: failing })).toBe(SOURCE);
    const wrong = (): Promise<Fake> => Promise.resolve({ locale: 'fr' });
    expect(await pickCatalog('de', SOURCE, { de: wrong })).toBe(SOURCE);
  });
});
