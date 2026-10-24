/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ReadingSource } from './reading';

/**
 * A snapshot's parts as a captured page sample names them, in the order it lists them:
 * the address, the page's title, its Open Graph, its structured data, its Media Session, the page
 * data a module declared (its selectors and page state) and the signals.
 */
export const SNAPSHOT_PARTS = [
  'address',
  'page_title',
  'open_graph',
  'structured_data',
  'media_session',
  'page_data',
  'signals',
] as const;

export type SnapshotPart = (typeof SNAPSHOT_PARTS)[number];

/** The part each generic reader reads. */
export const PART_READ_BY: Readonly<Record<Exclude<ReadingSource, 'module'>, SnapshotPart>> = {
  'json-ld': 'structured_data',
  'media-session': 'media_session',
  'open-graph': 'open_graph',
  'document-title': 'page_title',
  address: 'address',
};

/** What a page looked like at one moment, as plain data a reader can interpret. */
export interface Snapshot {
  readonly url: {
    readonly hostname: string;
    readonly pathname: string;
    /** Only the query parameters a module declared. */
    readonly query: Readonly<Record<string, string>>;
    readonly hash: string;
  };
  readonly lang: string | null;
  readonly documentTitle: string;
  readonly selectors: Readonly<Record<string, readonly string[]>>;
  readonly jsonLd: readonly unknown[];
  readonly mediaSession: {
    readonly title?: string;
    readonly artist?: string;
    readonly album?: string;
  } | null;
  readonly openGraph: Readonly<Record<string, string>>;
  readonly pageState: Readonly<Record<string, unknown>>;
  readonly signals: {
    readonly endOfContent: boolean;
    readonly adPlaying: boolean;
  };
}
