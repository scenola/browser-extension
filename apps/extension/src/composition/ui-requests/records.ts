/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the pages are given of stored records: an export keeps nothing that names the account,
// and a captured sample says which of its parts a reader took something from.

import { PART_READ_BY, SNAPSHOT_PARTS } from '@mt/core';
import type { ConnectionState, Field, SnapshotPart } from '@mt/core';
import type { CollectSpec } from '@mt/services';

import type { FrameEntry } from '../frame-table';

/**
 * The parts of a captured snapshot a reader took something from this time: each generic
 * reading's fields by their source; and, when the frame's module answered — a reading that names
 * no part it came from — the address it routes on and every part its definition declares.
 */
export function partsUsed(entry: FrameEntry, collect: CollectSpec | null): SnapshotPart[] {
  const used = new Set<SnapshotPart>();
  for (const reading of entry.generic) {
    for (const value of Object.values(reading)) {
      const source = (value as Partial<Field<unknown>> | undefined)?.source;
      if (source !== undefined && source !== 'module') used.add(PART_READ_BY[source]);
    }
  }
  if (entry.reading !== null && collect !== null) {
    used.add('address');
    if (collect.selectors !== undefined || collect.pageState !== undefined) used.add('page_data');
    if (collect.jsonLd === true) used.add('structured_data');
    if (collect.mediaSession === true) used.add('media_session');
    if (collect.openGraph === true) used.add('open_graph');
    if (collect.signals !== undefined) used.add('signals');
  }
  return SNAPSHOT_PARTS.filter((part) => used.has(part));
}

/** The connection as an export shows it: its kind and dates, nothing that identifies it. */
export function connectionSummary(state: ConnectionState): Readonly<Record<string, unknown>> {
  switch (state.kind) {
    case 'none':
      return { kind: state.kind };
    case 'broken':
      return { kind: state.kind, reason: state.reason };
    case 'connected':
      return {
        kind: state.kind,
        strategy: state.strategy,
        connectedAt: state.connectedAt,
        expiresAt: state.expiresAt,
      };
  }
}

/**
 * A record as the export writes it: without the account it was recorded for. The key is opaque,
 * and a file the person may hand on is no place for something that ties records to an account.
 */
export function withoutKey<T extends { readonly accountKey?: string | null }>(
  record: T,
): Omit<T, 'accountKey'> {
  const copy: { accountKey?: unknown } = { ...record };
  delete copy.accountKey;
  return copy as Omit<T, 'accountKey'>;
}
