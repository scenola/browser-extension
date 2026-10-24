/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { playLabel } from '@mt/core';
import type { HistoryEntry, PlayBody } from '@mt/core';
import { describe, expect, test } from 'vitest';

import { waitingRows } from './waiting-rows';

const BASE = 'https://app.example.org';

let n = 0;

function play(body: PlayBody, key: string | null | undefined, sentAt: number): HistoryEntry {
  n += 1;
  return {
    playId: `p${String(n)}`,
    scrobbleId: `s${String(n)}`,
    body,
    sentAt,
    receipt: {
      state: 'needs_confirmation',
      reason: 'text_only',
      titleId: null,
      ...(key === undefined ? {} : { questionKey: key }),
    },
    receiptReadAt: sentAt,
    receiptGoneAt: null,
    label: playLabel(body) ?? '',
  };
}

const episode = (show: string, season: number, number: number): PlayBody => ({
  kind: 'episode',
  show: { title: show },
  season_number: season,
  episode_number: number,
  watched_at: '2026-10-22T21:10:00+02:00',
});

const film = (title: string): PlayBody => ({
  kind: 'movie',
  title,
  watched_at: '2026-10-22T21:10:00+02:00',
});

describe('waitingRows', () => {
  test('episodes of one show sharing a key are one row with their range and count', () => {
    const rows = waitingRows(
      [
        play(episode('Severance', 1, 4), 'q1:a', 3),
        play(episode('Severance', 1, 2), 'q1:a', 1),
        play(episode('Severance', 1, 3), 'q1:a', 2),
      ],
      BASE,
    );
    expect(rows).toEqual([
      {
        id: 'question:q1:a',
        label: 'Severance · S1 E2–E4',
        more: 0,
        count: 3,
        // The key is opaque, so it is encoded whole.
        href: `${BASE}/today?question=q1%3Aa`,
      },
    ]);
  });

  test('a row links to its question, or to Up Next when it has no key', () => {
    const rows = waitingRows(
      [play(film('Heat'), 'a b&c/d', 2), play(film('Alien'), null, 1)],
      BASE,
    );
    expect(rows.map((r) => r.href)).toEqual([
      `${BASE}/today?question=a%20b%26c%2Fd`,
      `${BASE}/today`,
    ]);
  });

  test('episodes that are not consecutive are listed, at most five, then "and N more"', () => {
    const numbers = [2, 4, 7, 8, 10, 12, 15];
    const rows = waitingRows(
      numbers.map((e, i) => play(episode('Severance', 1, e), 'q1:a', i)),
      BASE,
    );
    expect(rows[0]).toMatchObject({
      label: 'Severance · S1 E2, E4, E7, E8, E10',
      more: 2,
      count: 7,
    });
  });

  test('a season is named where it changes', () => {
    const rows = waitingRows(
      [play(episode('Severance', 1, 9), 'q1:a', 1), play(episode('Severance', 2, 1), 'q1:a', 2)],
      BASE,
    );
    expect(rows[0]?.label).toBe('Severance · S1 E9, S2 E1');
  });

  test('different titles under one key: the newest label and "and N more"', () => {
    const rows = waitingRows(
      [
        play(film('Heat'), 'q1:a', 1),
        play(episode('Severance', 1, 2), 'q1:a', 3),
        play(film('Alien'), 'q1:a', 2),
      ],
      BASE,
    );
    expect(rows[0]).toMatchObject({ label: 'Severance · S1 E2', more: 2, count: 3 });
  });

  test('the same title played twice names it once', () => {
    const rows = waitingRows([play(film('Heat'), 'q1:a', 1), play(film('Heat'), 'q1:a', 2)], BASE);
    expect(rows[0]).toMatchObject({ label: 'Heat', more: 0, count: 2 });
  });

  test('a play without a key stands alone, whether its key is null or was never read', () => {
    const rows = waitingRows(
      [
        play(film('Heat'), null, 1),
        play(film('Alien'), undefined, 2),
        play(film('Ran'), 'q1:a', 3),
      ],
      BASE,
    );
    expect(rows.map((r) => [r.label, r.count])).toEqual([
      ['Ran', 1],
      ['Alien', 1],
      ['Heat', 1],
    ]);
  });

  test('rows are ordered by their newest play', () => {
    const rows = waitingRows(
      [
        play(film('Old'), 'q1:a', 1),
        play(film('Older'), 'q1:b', 0),
        play(film('Newest'), 'q1:b', 9),
      ],
      BASE,
    );
    expect(rows.map((r) => r.id)).toEqual(['question:q1:b', 'question:q1:a']);
  });

  test('a show whose plays name no episode is the show alone', () => {
    const body: PlayBody = {
      kind: 'episode',
      show: { title: 'Severance' },
      watched_at: '2026-10-22T21:10:00+02:00',
    };
    expect(waitingRows([play(body, 'q1:a', 1)], BASE)[0]?.label).toBe('Severance');
  });
});
