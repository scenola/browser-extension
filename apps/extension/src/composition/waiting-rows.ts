/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// *Waiting for you*: one row per question. One answer in the app settles every play that shares
// a question key, so the popup shows them as one row; a play without a key stands alone. Rows
// are worded from the extension's own plays, never from anything the server said.

import type { HistoryEntry } from '@mt/core';

import type { WaitingRow } from '../messaging/protocol';
import { WEB_ROUTES } from '../web-routes';

/** Episodes named in a list before "and N more". */
const LISTED_EPISODES = 5;

/**
 * `entries` (the plays waiting for the person) as rows, newest first. A row links to its
 * question's card in the web app at `webAppBase`, or to Up Next when it has no key.
 */
export function waitingRows(entries: readonly HistoryEntry[], webAppBase: string): WaitingRow[] {
  const groups = new Map<string, { key: string | null; plays: HistoryEntry[] }>();
  for (const entry of entries) {
    const key = entry.receipt?.questionKey ?? null;
    const id = key === null ? `play:${entry.playId}` : `question:${key}`;
    const group = groups.get(id) ?? { key, plays: [] };
    group.plays.push(entry);
    groups.set(id, group);
  }
  const newestFirst = (a: HistoryEntry, b: HistoryEntry): number => b.sentAt - a.sentAt;
  return [...groups.entries()]
    .map(([id, { key, plays }]) => ({ id, key, plays: plays.sort(newestFirst) }))
    .sort((a, b) =>
      a.plays[0] === undefined || b.plays[0] === undefined
        ? 0
        : newestFirst(a.plays[0], b.plays[0]),
    )
    .map(({ id, key, plays }) => ({
      id,
      ...worded(plays),
      href: `${webAppBase}${key === null ? WEB_ROUTES.upNext : WEB_ROUTES.question(key)}`,
    }));
}

/** The words of a group of plays, newest first, and how many more it leaves unnamed. */
function worded(plays: readonly HistoryEntry[]): Pick<WaitingRow, 'label' | 'more' | 'count'> {
  const count = plays.length;
  const show = oneShow(plays);
  if (show !== null) return { ...episodes(show, plays), count };
  const labels = [...new Set(plays.map((p) => p.label))];
  return { label: labels[0] ?? '', more: labels.length - 1, count };
}

/** The show every play is an episode of; `null` when they are not all of one show. */
function oneShow(plays: readonly HistoryEntry[]): string | null {
  const shows = new Set(plays.map((p) => (p.body.kind === 'episode' ? p.body.show?.title : null)));
  const [only] = shows;
  return shows.size === 1 && typeof only === 'string' ? only : null;
}

function episodes(
  show: string,
  plays: readonly HistoryEntry[],
): Pick<WaitingRow, 'label' | 'more'> {
  const seen = new Set<string>();
  const numbered: { season: number; episode: number }[] = [];
  for (const { body } of plays) {
    const { season_number: season, episode_number: episode } = body;
    if (
      season === undefined ||
      episode === undefined ||
      seen.has(`${String(season)}/${String(episode)}`)
    ) {
      continue;
    }
    seen.add(`${String(season)}/${String(episode)}`);
    numbered.push({ season, episode });
  }
  numbered.sort((a, b) => a.season - b.season || a.episode - b.episode);

  const first = numbered.at(0);
  const last = numbered.at(-1);
  if (first === undefined || last === undefined) return { label: show, more: 0 };
  const consecutive = numbered.every(
    (n, i) => n.season === first.season && n.episode === first.episode + i,
  );
  if (consecutive) {
    const range =
      numbered.length === 1
        ? `S${String(first.season)} E${String(first.episode)}`
        : `S${String(first.season)} E${String(first.episode)}–E${String(last.episode)}`;
    return { label: `${show} · ${range}`, more: 0 };
  }

  // Not a run: the episodes by name, the season only where it changes.
  const named = numbered.slice(0, LISTED_EPISODES).map((n, i, all) => {
    const sameSeason = i > 0 && all[i - 1]?.season === n.season;
    return sameSeason ? `E${String(n.episode)}` : `S${String(n.season)} E${String(n.episode)}`;
  });
  return {
    label: `${show} · ${named.join(', ')}`,
    more: numbered.length - named.length,
  };
}
