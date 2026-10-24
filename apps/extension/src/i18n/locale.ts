/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Which catalog a UI language gets, for the pages (`t.ts`) and the worker (`worker-words.ts`)
// alike: the browser's UI language (`i18n.getUILanguage()`) matched by BCP 47 fallback to the
// nearest catalog, which is loaded on demand; English when none matches, or when the one that
// matches cannot be loaded.

import { browser } from 'wxt/browser';

/** Tags a browser reports that name a catalog by another spelling (Chrome's and BCP 47's). */
const ALIASES: Readonly<Record<string, string>> = {
  zh: 'zh-Hans',
  'zh-cn': 'zh-Hans',
  'zh-sg': 'zh-Hans',
  'zh-hans': 'zh-Hans',
  'zh-tw': 'zh-Hant',
  'zh-hk': 'zh-Hant',
  'zh-mo': 'zh-Hant',
  'zh-hant': 'zh-Hant',
  no: 'nb',
  nn: 'nb',
  sr: 'sr-Cyrl',
  'sr-cyrl': 'sr-Cyrl',
  'sr-latn': 'sr-Latn',
  pt: 'pt-BR',
};

/**
 * The catalog for a language tag: the tag itself, its alias, then its language alone — or
 * `null`, which is English. Case and `_` / `-` do not matter.
 */
export function matchUiLocale(tag: string, available: readonly string[]): string | null {
  const wanted = tag.trim().replace(/_/gu, '-').toLowerCase().slice(0, 35);
  if (wanted === '') return null;
  const byLower = new Map(available.map((locale) => [locale.toLowerCase(), locale]));
  const language = wanted.split('-')[0] ?? wanted;
  const candidates = [wanted, ALIASES[wanted], language, ALIASES[language]];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const found = byLower.get(candidate.toLowerCase());
    if (found !== undefined) return found;
  }
  return null;
}

/** The browser's UI language; `navigator`'s where the extension API is missing (tests). */
export function uiLanguage(): string {
  try {
    return browser.i18n.getUILanguage();
  } catch {
    return typeof navigator === 'undefined' ? 'en' : navigator.language;
  }
}

/**
 * The catalog `tag` asks for among `source` (always there) and `translations` (each loaded on
 * demand): the source when none matches, without loading anything; the source again when the
 * match's loader fails or hands back a catalog of another locale.
 */
export async function pickCatalog<C extends { readonly locale: string }>(
  tag: string,
  source: C,
  translations: Readonly<Record<string, () => Promise<C>>>,
): Promise<C> {
  const locale = matchUiLocale(tag, [source.locale, ...Object.keys(translations)]);
  if (locale === null || locale === source.locale || !Object.hasOwn(translations, locale)) {
    return source;
  }
  try {
    const catalog = await translations[locale]?.();
    return catalog?.locale === locale ? catalog : source;
  } catch {
    return source;
  }
}
