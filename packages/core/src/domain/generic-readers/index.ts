/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ServiceReading } from '../reading';
import type { Snapshot } from '../snapshot';
import { readAddress } from './address';
import { readDocumentTitle } from './document-title';
import { readJsonLd } from './json-ld';
import { readMediaSession } from './media-session';
import { readOpenGraph } from './open-graph';

/**
 * Every generic reader that found something, in order of trust: JSON-LD (0.8), Media Session
 * (0.7), Open Graph (0.6), the document title (0.4), the page's address (0.3).
 * A generic reader never states a duration: only a module's is trusted for that.
 */
export function readGeneric(snapshot: Snapshot): readonly ServiceReading[] {
  return [
    readJsonLd(snapshot),
    readMediaSession(snapshot),
    readOpenGraph(snapshot),
    readDocumentTitle(snapshot),
    readAddress(snapshot),
  ].filter((r): r is ServiceReading => r !== null);
}
