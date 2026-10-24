/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const TRAILING_YEAR = /\s*[([]\d{4}[)\]]\s*$/u;
// Diacritics are optional in Latin, Greek and Cyrillic; in every other script a mark is part of the letter.
const OPTIONAL_MARKS = /([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{M}+/gu;
const PUNCTUATION_AND_SYMBOLS = /[\p{P}\p{S}]/gu;
const WHITESPACE = /\s+/gu;

/**
 * Passes after which `normalizeTitle` stops looking for its fixpoint. A pass after the first
 * only removes what the one before exposed (a mark that a removed symbol stood in front of, a
 * sequence that composes once its middle is gone), so two or three reach it.
 */
const MAX_PASSES = 4;

/** One pass of the comparison form. Not idempotent on its own: see `normalizeTitle`. */
function normalizeOnce(text: string): string {
  const folded = text.normalize('NFKC').toLocaleLowerCase('und');
  const unmarked = folded.normalize('NFD').replace(OPTIONAL_MARKS, '$1').normalize('NFC');
  return unmarked
    .replaceAll('&', ' and ')
    .replace(TRAILING_YEAR, '')
    .replace(PUNCTUATION_AND_SYMBOLS, '')
    .replace(WHITESPACE, ' ')
    .trim();
}

function fixpoint(text: string): string {
  let current = normalizeOnce(text);
  for (let pass = 1; pass < MAX_PASSES; pass += 1) {
    const next = normalizeOnce(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

/**
 * Titles already normalised, by their text. One observation compares the same few titles about
 * a dozen times (its key, the bound viewing's, the show's), and each pass runs three Unicode
 * normalisations; the answer depends on the text alone. Bounded: emptied when full.
 */
const NORMALIZED = new Map<string, string>();
const NORMALIZED_MAX = 64;

/**
 * The comparison form of a title: what two spellings of the same title share.
 * NFKC, case-folded, diacritics stripped from Latin/Greek/Cyrillic only, "&" read as "and", a
 * trailing bracketed year removed, punctuation and symbols dropped, whitespace collapsed.
 *
 * **Normalising twice changes nothing**: one pass can expose what it should have
 * removed — `𝐀𝅗𝅥` gives `a` and a combining stem once the note's head, a symbol, is dropped — so
 * the pass is repeated until it changes nothing, at most `MAX_PASSES` times. A stored key,
 * normalised again, is the same key. Each pass is linear in the text.
 */
export function normalizeTitle(text: string): string {
  const known = NORMALIZED.get(text);
  if (known !== undefined) return known;
  const normalized = fixpoint(text);
  if (NORMALIZED.size >= NORMALIZED_MAX) NORMALIZED.clear();
  NORMALIZED.set(text, normalized);
  return normalized;
}
