/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The story through observation ingest: a viewing is recorded in the observation whose story
// seconds played reach the account's line, coverage measured over the story — from a skipped
// intro's end to the credits' start, as far as either is known at that moment.

import { describe, expect, test } from 'vitest';

import type { ServiceReading } from '../domain/reading';
import { storyCoverage, storyOf } from '../domain/viewing';
import type { Viewing } from '../domain/viewing';
import { episodeReading, filmReading, makeWorld, must, observe, watch } from './test-world';
import type { World } from './test-world';

const FILM_S = 7200;
const film = filmReading('Film', 2000);
const filmLength = { sample: { duration: FILM_S } };

const only = (w: World): Viewing => {
  const all = w.viewings.all();
  expect(all).toHaveLength(1);
  return must(all[0]);
};

/** Where, in content seconds, each observation of a `watch` from `from` that reported was. */
const reportedAt = (results: readonly { readonly reported: boolean }[], from: number): number[] =>
  results.flatMap((r, i) => (r.reported ? [from + i * 15] : []));

/**
 * A 2-hour film whose credits run its last 15 % (from 6120 s): watched 15–2430 s, a seek to
 * 5040 s, then on to the credits start, where the service shows its credits signal. Until that
 * signal nothing says where the credits start, so the story ends at the estimate
 * 7200 − min(12 %, 20 min) = 6336 s; from it, the story ends where the signal first appeared.
 * At the signal, 3495 s of the 6120 s story were played, 57 %.
 */
async function leaveAtTheCredits(w: World): Promise<void> {
  await watch(w, film, 0, 2430, filmLength);
  await watch(w, film, 5040, 6105, filmLength);
  const credits: ServiceReading = { ...film, contentEnded: true };
  await observe(w, credits, 6120, filmLength);
}

// The line is the account's (`finishThresholdPercent`), not a setting of the extension's.
describe('the account’s finish line, over the story', () => {
  test('at a 50 % line the 2-hour film is recorded where the line is reached, mid-story, on the story known then', async () => {
    const w = makeWorld({ rule: { finishThresholdPercent: 50 } });
    await leaveAtTheCredits(w);
    const v = only(w);
    expect(v.state).toBe('reported');
    // The line is 3168 s of the estimated 6336 s story, reached at the sample at 5805 s.
    expect(storyOf(v)).toEqual({ start: 0, end: 6336 });
    expect(w.outbox.entries()).toHaveLength(1);
    expect(w.outbox.entries()[0]?.body).toMatchObject({
      ended: false,
      furthest_position_seconds: 5805,
      story_seconds: 6336,
      played_seconds: 3180,
    });
  });

  test('a line the credits signal brings within reach is met there, and the play says `ended`', async () => {
    // 55 % of the estimated story is 3485 s, 5 s more than was played by 6105 s; 55 % of the
    // story the signal ends at 6120 s is 3366 s, which the 3495 s played pass.
    const w = makeWorld({ rule: { finishThresholdPercent: 55 } });
    await watch(w, film, 0, 2430, filmLength);
    const before = await watch(w, film, 5040, 6105, filmLength);
    expect(before.some((r) => r.reported)).toBe(false);
    const at = await observe(w, { ...film, contentEnded: true }, 6120, filmLength);
    expect(at.reported).toBe(true);
    expect(storyOf(only(w))).toEqual({ start: 0, end: 6120 });
    expect(storyCoverage(only(w))).toBeCloseTo(3495 / 6120, 6);
    expect(w.outbox.entries()[0]?.body).toMatchObject({
      ended: true,
      furthest_position_seconds: 6120,
      story_seconds: 6120,
      played_seconds: 3495,
    });
  });

  test('the same film at a 90 % line is not recorded, and stays open', async () => {
    const w = makeWorld({ rule: { finishThresholdPercent: 90 } });
    await leaveAtTheCredits(w);
    expect(only(w).state).toBe('open');
    expect(w.outbox.entries()).toEqual([]);
  });

  test('the same film at the never-read line, 70 %, is not recorded, and stays open', async () => {
    const w = makeWorld();
    await leaveAtTheCredits(w);
    expect(only(w).state).toBe('open');
    expect(w.outbox.entries()).toEqual([]);
  });

  test('a skipped 8-minute intro at the 90 % line, the rest watched: recorded on the story after it', async () => {
    const w = makeWorld({ rule: { finishThresholdPercent: 90 } });
    const hour = { sample: { duration: 3600 } };
    await watch(w, episodeReading(1), 0, 90, hour);
    // Skip intro: 90 s → 570 s in one sample interval, inside the first 15 % of the hour.
    const results = await watch(w, episodeReading(1), 570, 3600, hour);
    // The story is 570–3168 s, 2598 s; its line, 2339 s, is reached at the sample at 2910 s.
    expect(reportedAt(results, 570)).toEqual([2910]);
    const v = only(w);
    expect(v.skippedIntro).toEqual([90, 570]);
    expect(storyOf(v)).toEqual({ start: 570, end: 3168 });
    expect(w.outbox.entries()[0]?.body).toMatchObject({
      ended: false,
      furthest_position_seconds: 2910,
      story_seconds: 2598,
      played_seconds: 2340,
    });
  });

  test('a forward seek of 30 minutes at minute 2 is no intro: the story keeps its start and coverage drops', async () => {
    const w = makeWorld({ rule: { finishThresholdPercent: 90 } });
    await watch(w, film, 0, 120, filmLength);
    const results = await watch(w, film, 1920, FILM_S, filmLength);
    expect(results.some((r) => r.reported)).toBe(false);
    const v = only(w);
    expect(v.skippedIntro ?? null).toBeNull();
    expect(storyOf(v)?.start).toBe(0);
    expect(storyCoverage(v)).toBeLessThan(0.9);
    expect(v.state).toBe('open');
  });

  test('a skim — a seek to 95 % and the end played — is not recorded', async () => {
    const w = makeWorld();
    await watch(w, film, 0, 60, filmLength);
    await watch(w, film, 6840, 7185, filmLength);
    await observe(w, film, FILM_S, { sample: { duration: FILM_S, ended: true, paused: true } });
    const v = only(w);
    expect(v.contentEnded).toBe(true);
    expect(v.state).toBe('open');
    expect(w.outbox.entries()).toEqual([]);
  });

  test('a credits start the service states (Netflix’s creditsOffset) ends the story the line is drawn on', async () => {
    const length = { sample: { duration: 3000 } };
    // The estimate ends the story at 2640 s: its 70 % line, 1848 s, is reached at 1875 s.
    const estimated = makeWorld();
    expect(reportedAt(await watch(estimated, episodeReading(1), 0, 2685, length), 0)).toEqual([
      1875,
    ]);
    // The statement says 2700 s: the line is 1890 s, reached at 1905 s.
    const w = makeWorld();
    const marked: ServiceReading = { ...episodeReading(1), creditsStartSeconds: 2700 };
    expect(reportedAt(await watch(w, marked, 0, 2685, length), 0)).toEqual([1905]);
    expect(storyOf(only(w))).toEqual({ start: 0, end: 2700 });
    // A stated credits start draws the story; it never says the title played out.
    expect(w.outbox.entries()[0]?.body).toMatchObject({
      ended: false,
      furthest_position_seconds: 1905,
      story_seconds: 2700,
      played_seconds: 1890,
    });
  });
});
