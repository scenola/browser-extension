/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parseEpisodeLabel } from '../labels';
import { clampTitle } from '../play';
import type { ServiceReading } from '../reading';
import type { Snapshot } from '../snapshot';
import { splitLabel } from './document-title';
import { field, isRecord, orNull, text, workFields } from './shared';

export function readMediaSession(snapshot: Snapshot): ServiceReading | null {
  const session = snapshot.mediaSession;
  if (!isRecord(session)) return null;
  const title = text(session.title);
  const artist = text(session.artist);
  const album = text(session.album);
  const src = 'media-session';

  // Numbers in the title win; the artist is where some players put them.
  const inTitle = title === undefined ? null : splitLabel(title);
  const inArtist = inTitle === null && artist !== undefined ? splitLabel(artist) : null;
  const label = inTitle ?? inArtist;

  let showTitle: string | undefined;
  if (label !== null) {
    const plain = (s: string | undefined): string | undefined =>
      s !== undefined && parseEpisodeLabel(s) === null ? s : undefined;
    showTitle =
      plain(album) ??
      plain(artist) ??
      (inArtist !== null && inArtist.before !== '' ? inArtist.before : undefined);
  }

  // The label is read from the whole text; the titles kept are cut to the wire's 200 code
  // points. Without a label the title is a film's as far as this reader knows, and a show's name
  // is a work's title either way (`workFields`).
  const labelled = clampTitle(title);
  return orNull({
    ...(label === null
      ? workFields(src, title, ['title', 'year'])
      : {
          ...(labelled !== undefined ? { title: field(src, labelled) } : {}),
          kind: field(src, 'episode' as const),
          season: field(src, label.season),
          episode: field(src, label.episode),
        }),
    ...workFields(src, showTitle, ['showTitle', 'showYear']),
  });
}
