/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The pages' words: `t(key, params)` over the compiled catalogs, in the browser's UI
// language (`i18n.getUILanguage()`) with BCP 47 fallback to the nearest catalog (`locale.ts`),
// and English for any key a translation lacks. `{product}` and `{extension}` are always the
// brand's names.
//
// **Loaded on demand**: English is in every page; the UI language's catalog is its own
// chunk, `import()`ed by this module's top-level await, so a page renders nothing before its
// words are there and loads no language it does not speak. The pseudo-locale is reachable in
// development builds alone. The worker never imports this module — a service worker cannot
// await at the top level or `import()` — and has its own words (`worker-words.ts`).

import { EXTENSION_NAME, PRODUCT_NAME } from '../brand';
import { PSEUDO_LOCALE, SOURCE_CATALOG, TRANSLATIONS, loadPseudoCatalog } from './generated';
import type { AppMessageKey } from './generated';
import { pickCatalog, uiLanguage } from './locale';
import { createFormatter } from './runtime';
import type { Catalog, Formatter, Params } from './runtime';

export type { AppMessageKey } from './generated';
export type { Params } from './runtime';

interface Active {
  readonly catalog: Catalog;
  readonly f: Formatter;
}

/** Every catalog a page may load: the pseudo-locale's only in a development build. */
function translations(): Readonly<Record<string, () => Promise<Catalog>>> {
  return loadPseudoCatalog === null
    ? TRANSLATIONS
    : { ...TRANSLATIONS, [PSEUDO_LOCALE]: loadPseudoCatalog };
}

const SOURCE: Active = { catalog: SOURCE_CATALOG, f: createFormatter(SOURCE_CATALOG.locale) };
const chosen = await pickCatalog(uiLanguage(), SOURCE_CATALOG, translations());
const active: Active =
  chosen === SOURCE_CATALOG ? SOURCE : { catalog: chosen, f: createFormatter(chosen.locale) };

/**
 * The locale the words are in: for any `Intl` formatting beside them (the pages).
 *
 * @public
 */
export function uiLocale(): string {
  return active.catalog.locale;
}

/**
 * The message for `key` in the UI language, English where the translation lacks it (or throws).
 * Callers' parameters cannot replace the brand's names. The pages' one way to words.
 *
 * @public
 */
export function t(key: AppMessageKey, params: Params = {}): string {
  const all: Params = { ...params, product: PRODUCT_NAME, extension: EXTENSION_NAME };
  const own = Object.hasOwn(active.catalog.messages, key)
    ? active.catalog.messages[key]
    : undefined;
  if (own !== undefined && active !== SOURCE) {
    try {
      return own(all, active.f);
    } catch {
      // A broken translation falls back to English below.
    }
  }
  const source = Object.hasOwn(SOURCE.catalog.messages, key)
    ? SOURCE.catalog.messages[key]
    : undefined;
  return source === undefined ? key : source(all, SOURCE.f);
}
