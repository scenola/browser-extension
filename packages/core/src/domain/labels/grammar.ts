/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One language's way of writing "season 1, episode 2". Data only: a
 * contributor adds a language by adding a file, never by touching the parser.
 * `patterns` carry orderings the word lists cannot express (CJK); each must
 * capture the season in group 1 and the episode in group 2.
 *
 * The episode words also read a label that names the episode alone ("Еп. 3",
 * "Folge 3", as a single-season show writes it); `episodePatterns` carry the episode-only forms the
 * words cannot express ("第3集"), each capturing the episode in group 1. Such a
 * label is read as a whole text, never inside a longer one.
 */
export interface LabelLocale {
  readonly id: string;
  readonly season: readonly string[];
  readonly episode: readonly string[];
  readonly patterns?: readonly RegExp[];
  readonly episodePatterns?: readonly RegExp[];
}

export interface EpisodeLabel {
  season: number;
  episode: number;
}

const escape = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** The words as one regular-expression alternative, longest first so a prefix never wins. */
export const alternation = (words: readonly string[]): string =>
  [...words]
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join('|');

/** One class between a number and the next word: comma, colon, dot, hyphen, en/em dash, bar, space. */
const SEPARATORS = '[\\s,:.\\-–—|]';

/** A locale pattern's flags with `u`, and without the stateful `g` and `y`. */
const patternFlags = (pattern: RegExp): string => {
  const flags = pattern.flags.replace(/[gy]/gu, '');
  return flags.includes('u') ? flags : flags + 'u';
};

/** `<season word>[.] N <separators> <episode word>[.] M`, the locale's own words. */
function compileLocale(locale: LabelLocale): RegExp[] {
  const compiled: RegExp[] = [];
  if (locale.season.length > 0 && locale.episode.length > 0) {
    compiled.push(
      new RegExp(
        `(?<![\\p{L}\\p{N}])(?:${alternation(locale.season)})\\.?\\s{0,3}(\\d{1,3})${SEPARATORS}*` +
          `(?:${alternation(locale.episode)})\\.?\\s{0,3}(\\d{1,4})(?!\\d)`,
        'iu',
      ),
    );
  }
  for (const pattern of locale.patterns ?? []) {
    compiled.push(new RegExp(pattern.source, patternFlags(pattern)));
  }
  return compiled;
}

/**
 * `^<episode word>[.] M$` and the locale's `episodePatterns`, each anchored to the whole text:
 * an episode-only label is the label, never a number found inside a title. Bounded quantifiers
 * over literal alternatives, so each runs in linear time on the bounded text.
 */
function compileEpisodeOnly(locale: LabelLocale): RegExp[] {
  const compiled: RegExp[] = [];
  if (locale.episode.length > 0) {
    compiled.push(new RegExp(`^(?:${alternation(locale.episode)})\\.?\\s{0,3}(\\d{1,4})$`, 'iu'));
  }
  for (const pattern of locale.episodePatterns ?? []) {
    compiled.push(new RegExp(`^(?:${pattern.source})$`, patternFlags(pattern)));
  }
  return compiled;
}

const UNIVERSAL: readonly RegExp[] = [/(?<![\p{L}\p{N}])S(\d{1,3})[\s:.]{0,3}E(\d{1,4})(?!\d)/iu];

/**
 * `NxMM`, tried after every locale pattern. A dimension or a quantity writes
 * itself the same way ("24x36 cm", "Poster 24x36", "2x10 pack"), so it is
 * refused when a unit follows or a size noun precedes, and when it chains
 * into a third number ("24x36x2").
 */
const COMPACT =
  /(?<![\p{L}\p{N}])(?<!\b(?:poster|print|frame|canvas|size|pack|of)\s+)(\d{1,2})x(\d{2})(?![\p{L}\p{N}])(?!x\d)(?!\s*(?:cm|mm|in|inch|inches|px|ft|m|gb|tb|mb|kb|ghz|mhz|hz|mp|pack|packs|pcs|set|x)(?![\p{L}\p{N}]))/iu;

/** The most text a label is read from: a label is short, a page title can be anything. */
const MAX_LABEL_CHARS = 300;

export function compileGrammar(locales: readonly LabelLocale[]): readonly RegExp[] {
  return [...UNIVERSAL, ...locales.flatMap(compileLocale), COMPACT];
}

/** The episode-only forms of every locale, apart from the season-and-episode ones. */
export function compileEpisodeOnlyGrammar(locales: readonly LabelLocale[]): readonly RegExp[] {
  return locales.flatMap(compileEpisodeOnly);
}

export interface FoundLabel extends EpisodeLabel {
  /** Where the label starts in the bounded, whitespace-collapsed text the grammar examined. */
  index: number;
  length: number;
}

/** The text the grammar examines: whitespace collapsed, cut at `MAX_LABEL_CHARS`. */
export function boundLabelText(raw: string): string {
  return raw.replace(/\s+/gu, ' ').slice(0, MAX_LABEL_CHARS);
}

/** First match wins. Season 0 is a special; episode 0 is not an episode. */
export function findWith(grammar: readonly RegExp[], raw: string): FoundLabel | null {
  const text = boundLabelText(raw);
  for (const re of grammar) {
    const m = re.exec(text);
    if (!m) continue;
    const season = Number(m[1]);
    const episode = Number(m[2]);
    if (Number.isInteger(season) && Number.isInteger(episode) && episode >= 1) {
      return { season, episode, index: m.index, length: m[0].length };
    }
  }
  return null;
}

export function parseWith(grammar: readonly RegExp[], raw: string): EpisodeLabel | null {
  const found = findWith(grammar, raw);
  return found === null ? null : { season: found.season, episode: found.episode };
}

/**
 * The episode number of a text that is an episode-only label, read from the bounded,
 * whitespace-collapsed text, trimmed; `null` otherwise. First match wins; episode 0 is not an
 * episode. No season is ever implied.
 */
export function parseEpisodeOnlyWith(grammar: readonly RegExp[], raw: string): number | null {
  const text = boundLabelText(raw).trim();
  for (const re of grammar) {
    const m = re.exec(text);
    if (!m) continue;
    const episode = Number(m[1]);
    if (Number.isInteger(episode) && episode >= 1) return episode;
  }
  return null;
}
