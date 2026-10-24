/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  alternation,
  boundLabelText,
  compileEpisodeOnlyGrammar,
  compileGrammar,
  findWith,
  parseEpisodeOnlyWith,
  parseWith,
} from './grammar';
import type { EpisodeLabel, FoundLabel, LabelLocale } from './grammar';
import { cs } from './locales/cs';
import { de } from './locales/de';
import { en } from './locales/en';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { it } from './locales/it';
import { ja } from './locales/ja';
import { ko } from './locales/ko';
import { nl } from './locales/nl';
import { pl } from './locales/pl';
import { pt } from './locales/pt';
import { sv } from './locales/sv';
import { tr } from './locales/tr';
import { uk } from './locales/uk';
import { zh } from './locales/zh';

export type { EpisodeLabel, FoundLabel, LabelLocale };
export { alternation, boundLabelText };

/** The single registry: a language arrives by adding its file here. */
export const LABEL_LOCALES: readonly LabelLocale[] = [
  en,
  es,
  pt,
  de,
  fr,
  it,
  nl,
  pl,
  uk,
  cs,
  sv,
  tr,
  ja,
  ko,
  zh,
];

const GRAMMAR = compileGrammar(LABEL_LOCALES);

/**
 * The label the grammar chose and where it starts, in `boundLabelText(text)`
 * (whitespace collapsed, at most 300 characters); null when there is none.
 */
export function findEpisodeLabel(text: string): FoundLabel | null {
  return findWith(GRAMMAR, text);
}

/** "S1:E2", "Staffel 1, Folge 2", "第1季 第2集" ... to numbers; null when it is not a label. */
export function parseEpisodeLabel(text: string): EpisodeLabel | null {
  return parseWith(GRAMMAR, text);
}

const EPISODE_ONLY_GRAMMAR = compileEpisodeOnlyGrammar(LABEL_LOCALES);

/**
 * "Еп. 3", "Folge 3", "第3集" ... — a text that is a label naming the episode alone — to the
 * episode number; null otherwise. It implies no season, and is never read from
 * inside a longer text: a single-season show's title area, not a page title.
 */
export function parseEpisodeOnlyLabel(text: string): number | null {
  return parseEpisodeOnlyWith(EPISODE_ONLY_GRAMMAR, text);
}
