/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The worker's words: the toolbar tooltip, the one text the worker writes. A service worker
// cannot `import()`, so its catalogs are data (`data.ts`): English's words for core's keys are
// bundled (`generated/worker.ts`), and the UI language's are read once per worker life from the
// package — `i18n/<locale>.json`, which the build writes. English for any key a translation
// lacks; English entirely if its file cannot be read or is not a catalog. `{product}` and
// `{extension}` are always the brand's names.

import type { MessageKey } from '@mt/core';

import { EXTENSION_NAME, PRODUCT_NAME } from '../brand';
import { isDataCatalog, render } from './data';
import type { DataCatalog } from './data';
import type { AppMessageKey } from './generated';
import { PSEUDO_LOCALE, SOURCE_WORDS, WORKER_TRANSLATIONS } from './generated/worker';
import { pickCatalog, uiLanguage } from './locale';
import { createFormatter } from './runtime';
import type { Formatter, Params } from './runtime';

/** Reads a file of the package as JSON. */
export type ReadPackaged = (path: string) => Promise<unknown>;

/** Core's keys, when every one has English text; `never` — no call compiles — otherwise. */
type CoreKey = MessageKey extends AppMessageKey ? MessageKey : never;

const fetchPackaged: ReadPackaged = async (path) => {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${String(response.status)}`);
  return response.json();
};

/** The locales whose words are files: the pseudo-locale's only in a development build. */
function translations(): readonly string[] {
  return import.meta.env.MT_BUILD_MODE === 'development'
    ? [...WORKER_TRANSLATIONS, PSEUDO_LOCALE]
    : WORKER_TRANSLATIONS;
}

interface Words {
  readonly own: DataCatalog | null;
  readonly f: Formatter;
}

const SOURCE_FORMATTER = createFormatter(SOURCE_WORDS.locale);

async function loadWords(tag: string, read: ReadPackaged): Promise<Words> {
  const loaders = Object.fromEntries(
    translations().map((locale) => [
      locale,
      async (): Promise<DataCatalog> => {
        const data = await read(`/i18n/${locale}.json`);
        if (!isDataCatalog(data, locale)) throw new Error(`i18n/${locale}.json: not a catalog`);
        return data;
      },
    ]),
  );
  const catalog = await pickCatalog(tag, SOURCE_WORDS, loaders);
  return catalog === SOURCE_WORDS
    ? { own: null, f: SOURCE_FORMATTER }
    : { own: catalog, f: createFormatter(catalog.locale) };
}

/**
 * Words over `read`, in the UI language `tag`: one read at most, on the first call. The worker's
 * own is {@link tCore}; tests make their own.
 */
export function createWorkerWords(
  tag: () => string,
  read: ReadPackaged,
): (key: CoreKey, params?: Params) => Promise<string> {
  let words: Promise<Words> | null = null;
  return async (key, params = {}) => {
    words ??= loadWords(tag(), read);
    const { own, f } = await words;
    const all: Params = { ...params, product: PRODUCT_NAME, extension: EXTENSION_NAME };
    const nodes = own !== null && Object.hasOwn(own.messages, key) ? own.messages[key] : undefined;
    if (nodes !== undefined) {
      try {
        return render(nodes, all, f);
      } catch {
        // A broken translation falls back to English below.
      }
    }
    const source = Object.hasOwn(SOURCE_WORDS.messages, key)
      ? SOURCE_WORDS.messages[key]
      : undefined;
    return source === undefined ? key : render(source, all, SOURCE_FORMATTER);
  };
}

/**
 * A key core decides on — the icon's tooltip — in the UI language. It takes core's
 * `MessageKey`, so a key core adds without English text is a compile error, not a blank
 * tooltip.
 */
export const tCore = createWorkerWords(uiLanguage, fetchPackaged);
