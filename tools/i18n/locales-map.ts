/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The web app's 32 UI locales, the same list the web app translates into, and the
// `_locales/` folder each one ships as. Chrome fixes the folder names, so a few differ
// from the web's tags: Norwegian Bokmål is `no`, the two Chinese scripts are `zh_CN` / `zh_TW`,
// and Serbian is one `sr` — Cyrillic, the folder both scripts map to.

export const WEB_LOCALES = [
  'en',
  'ar',
  'bg',
  'cs',
  'da',
  'de',
  'el',
  'es',
  'fi',
  'fr',
  'he',
  'hi',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'nb',
  'nl',
  'pl',
  'pt-BR',
  'pt-PT',
  'ro',
  'sr-Cyrl',
  'sr-Latn',
  'sv',
  'th',
  'tr',
  'uk',
  'vi',
  'zh-Hans',
  'zh-Hant',
] as const;

/** The development-only pseudo-locale: never a `_locales` folder, never in a store build. */
export const PSEUDO_LOCALE = 'en-XA';

const FOLDER: Readonly<Record<string, string>> = {
  nb: 'no',
  'zh-Hans': 'zh_CN',
  'zh-Hant': 'zh_TW',
  'sr-Cyrl': 'sr',
  'sr-Latn': 'sr',
  'pt-BR': 'pt_BR',
  'pt-PT': 'pt_PT',
};

/** The `_locales/` folder a web locale's manifest strings ship in. */
function chromeLocaleFolder(locale: string): string {
  return Object.hasOwn(FOLDER, locale) ? (FOLDER[locale] ?? locale) : locale.replace(/-/gu, '_');
}

/**
 * One locale per folder, from the locales that have a catalog: where two map to one folder
 * (Serbian), the Cyrillic one, which is what the folder holds.
 */
export function folderLocales(locales: readonly string[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const locale of [...locales].sort((a, b) => preference(a) - preference(b))) {
    const folder = chromeLocaleFolder(locale);
    if (!out.has(folder)) out.set(folder, locale);
  }
  return out;
}

const preference = (locale: string): number => (locale === 'sr-Latn' ? 1 : 0);
