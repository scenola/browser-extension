/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The guard rails' control: a module that uses what a module may — the SDK and its
// helpers, the allowed globals, literal keys, an array indexed by a number, types from
// the ES2023 library — and must compile and lint clean under the modules' rules. If it
// does not, the harness is broken and the forbidden files prove nothing.

import { field, jsonAt, parseEpisodeLabel } from '../../src/helpers';
import { defineService, matchPlayerRoute } from '../../src/sdk';
import type { ServiceReading, Snapshot } from '../../src/sdk';

const ROUTES: readonly RegExp[] = [/^\/watch\/(\d+)$/];
const DIGITS = new RegExp('^\\d+$');

function lastOf(values: readonly string[]): string | undefined {
  return values[values.length - 1];
}

function readTitle(snapshot: Snapshot): string | undefined {
  const fromState = jsonAt(snapshot.pageState.player, ['video', 'title']);
  if (typeof fromState === 'string') return fromState;
  return lastOf(snapshot.selectors.title ?? [])?.trim();
}

function readYear(snapshot: Snapshot): number | undefined {
  const stated: unknown = JSON.parse(snapshot.openGraph['video:release_date'] ?? 'null');
  const year = jsonAt(stated, ['year']);
  return typeof year === 'number' && Number.isInteger(year) ? Math.min(year, 2200) : undefined;
}

function interpret(snapshot: Snapshot): ServiceReading | null {
  const id = matchPlayerRoute(ROUTES, snapshot.url.pathname)?.[1];
  const title = readTitle(snapshot);
  if (id === undefined || title === undefined || !DIGITS.test(id)) return null;
  const label = parseEpisodeLabel(title);
  const year = readYear(snapshot);
  const readings: Readonly<Record<string, number>> = { length: Date.UTC(1970, 0, 1, 0, 2) / 1000 };
  return {
    title: field(title, 0.8),
    ...(label === null ? {} : { season: field(label.season, 0.8) }),
    ...(year === undefined ? {} : { year: field(year, 0.5) }),
    providerIds: [{ level: 'title', key: 'id', value: String(Number(id)) }],
    contentEnded: snapshot.signals.endOfContent,
    ...(readings.length === undefined ? {} : { contentDurationSeconds: readings.length }),
  };
}

export const control = defineService({
  id: 'control',
  name: 'Control',
  version: '1.0.0',
  hosts: ['control.example'],
  verified: null,
  playerRoutes: ROUTES,
  collect: {
    selectors: { title: { css: 'h1', max: 1 } },
    openGraph: true,
    pageState: { player: ['player', 'state'] },
    signals: { endOfContent: '.credits' },
  },
  interpret,
});

export const collected: readonly string[] = Array.from(Object.keys(control.collect));
