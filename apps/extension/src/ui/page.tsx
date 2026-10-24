/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What every page does before it draws: the fonts and the stylesheet (bundled — the pages load
// nothing from the network), the document's language, direction and title from the
// UI locale, then one render into `#app`.

import './fonts.css';
import './styles.css';

import { render } from 'preact';
import type { ComponentChild } from 'preact';

import { t, uiLocale } from '../i18n/t';
import type { AppMessageKey } from '../i18n/t';

/** Languages written right to left, by their primary subtag. */
const RTL_LANGUAGES: ReadonlySet<string> = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'yi', 'dv']);

export function mountPage(titleKey: AppMessageKey, view: ComponentChild): void {
  const locale = uiLocale();
  const language = locale.toLowerCase().split('-')[0] ?? 'en';
  const html = document.documentElement;
  html.lang = locale;
  html.dir = RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr';
  document.title = t(titleKey);
  const root = document.getElementById('app');
  if (root !== null) render(view, root);
}
