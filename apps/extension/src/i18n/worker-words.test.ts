/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The worker's words: English bundled, the UI language's catalog read from the package
// once, on the first call; English for a key it lacks and for a file that cannot be read or is
// not a catalog. The tests build as development builds do, so the pseudo-locale is the one
// translation a file can hold.

import { describe, expect, test, vi } from 'vitest';

import { PRODUCT_NAME } from '../brand';
import { isDataCatalog } from './data';
import type { DataCatalog } from './data';
import { PSEUDO_LOCALE } from './generated/worker';
import { createWorkerWords } from './worker-words';
import type { ReadPackaged } from './worker-words';

const PSEUDO: DataCatalog = {
  locale: PSEUDO_LOCALE,
  messages: {
    'status.idle': ['[', ['s', 'product'], ' — ñöţĥîñĝ~~~]'],
    'status.waiting': [
      ['p', 'count', 0, false, { one: [['#', 'count', 0], ' ṽîéŵîñĝ'], other: ['ɱåñý'] }],
    ],
  },
};

const reader = (data: unknown): ReturnType<typeof vi.fn<ReadPackaged>> =>
  vi.fn<ReadPackaged>(() => Promise.resolve(data));

describe('the worker in English', () => {
  test('reads no file and renders the bundled English, the brand filled in', async () => {
    const read = reader(PSEUDO);
    const tCore = createWorkerWords(() => 'en-US', read);
    expect(await tCore('status.idle')).toBe(`${PRODUCT_NAME} — nothing playing`);
    expect(await tCore('status.waiting', { count: 2 })).toBe(
      `2 viewings to confirm in ${PRODUCT_NAME}`,
    );
    expect(read).not.toHaveBeenCalled();
  });

  test("a caller's parameters cannot replace the brand's names", async () => {
    const tCore = createWorkerWords(() => 'en', reader(null));
    expect(await tCore('status.idle', { product: 'Other' })).toBe(
      `${PRODUCT_NAME} — nothing playing`,
    );
  });
});

describe("the worker in a translation's language", () => {
  test('reads its file once, at its path, and falls back to English key by key', async () => {
    const read = reader(PSEUDO);
    const tCore = createWorkerWords(() => PSEUDO_LOCALE, read);
    expect(await tCore('status.idle')).toBe(`[${PRODUCT_NAME} — ñöţĥîñĝ~~~]`);
    expect(await tCore('status.waiting', { count: 1 })).toBe('1 ṽîéŵîñĝ');
    expect(await tCore('status.blocked')).toBe(`${PRODUCT_NAME} doesn't track this site`);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(`/i18n/${PSEUDO_LOCALE}.json`);
  });

  test.each<readonly [string, ReadPackaged]>([
    ['a read that fails', () => Promise.reject(new Error('404'))],
    ['a file of another locale', () => Promise.resolve({ ...PSEUDO, locale: 'de' })],
    [
      'a file that is not a tree',
      () => Promise.resolve({ locale: PSEUDO_LOCALE, messages: { a: 1 } }),
    ],
  ])('%s: English', async (_, read) => {
    const tCore = createWorkerWords(() => PSEUDO_LOCALE, read);
    expect(await tCore('status.idle')).toBe(`${PRODUCT_NAME} — nothing playing`);
  });
});

describe('isDataCatalog', () => {
  test('takes a well-formed tree and refuses anything else, and a tree too deep', () => {
    expect(isDataCatalog(PSEUDO, PSEUDO_LOCALE)).toBe(true);
    expect(isDataCatalog(PSEUDO, 'de')).toBe(false);
    for (const bad of [
      ['?', 'x'],
      ['s'],
      ['s', 'x', 'extra'],
      ['n', 'x', 'currency'],
      ['d', 'x', 'yearly'],
      ['p', 'x', 0.5, false, {}],
      ['p', 'x', 0, 'no', {}],
      ['x', 'x', { a: [1] }],
      ['#', 'x', 'one'],
      ['s', ''],
      42,
    ]) {
      expect(isDataCatalog({ locale: 'de', messages: { k: [bad] } }, 'de')).toBe(false);
    }
    let deep: unknown = ['leaf'];
    for (let i = 0; i < 12; i += 1) deep = [['x', 'v', { other: deep }]];
    expect(isDataCatalog({ locale: 'de', messages: { k: deep } }, 'de')).toBe(false);
  });
});
