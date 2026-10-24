/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { boundLabelText, findEpisodeLabel } from '../labels';
import { EPISODE_NUMBER_MAX, SEASON_NUMBER_MAX, clampTitle } from '../play';
import type { ServiceReading } from '../reading';
import type { Snapshot } from '../snapshot';
import { field, orNull, text, workFields } from './shared';

/** Punctuation that joins a title to its label: not part of the title. */
const TRAILING_JOINERS = /[\s,:.\-–—|([]+$/u;

/**
 * Season and episode out of `text`, and the text before the label: the label the
 * grammar chose, in the bounded text it examined (one pass, whatever the length). Within the
 * wire's bounds: numbers past the server's limits are no label, and the
 * text before it is cut to 200 code points (empty when there is none).
 */
export function splitLabel(
  value: string,
): { season: number; episode: number; before: string } | null {
  const label = findEpisodeLabel(value);
  if (label === null) return null;
  if (label.season > SEASON_NUMBER_MAX || label.episode > EPISODE_NUMBER_MAX) return null;
  const before = boundLabelText(value).slice(0, label.index).replace(TRAILING_JOINERS, '');
  return { season: label.season, episode: label.episode, before: clampTitle(before) ?? '' };
}

export function readDocumentTitle(snapshot: Snapshot): ServiceReading | null {
  const title = text(snapshot.documentTitle);
  if (title === undefined) return null;
  const split = splitLabel(title);
  if (split === null) return null;
  const src = 'document-title';
  return orNull({
    kind: field(src, 'episode'),
    // The text before the label is the show's name, a work's title.
    ...workFields(src, split.before, ['showTitle', 'showYear']),
    season: field(src, split.season),
    episode: field(src, split.episode),
  });
}
