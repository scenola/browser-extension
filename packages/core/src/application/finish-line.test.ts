/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// When a viewing's play is queued, from the rule in words: in the observation where the story
// seconds played first reach `ceil(finish % × story / 100)`, wherever in the story that is. Not
// before, not after, and once: the rest of the viewing adds nothing. The numbers and the moment
// sent are those of that observation, and `ended` says only whether the title had played out by
// then.

import { describe, expect, test } from 'vitest';

import type { ServiceReading } from '../domain/reading';
import { T0, filmReading, makeWorld, must, observe, watch } from './test-world';

/** A 400 s film whose service states its credits at 300 s: a story of 300 s. */
const SHORT = { sample: { duration: 400 } };
const film: ServiceReading = { ...filmReading('Short', 2020), creditsStartSeconds: 300 };

/** Where, in content seconds, each observation of a `watch` from `from` that reported was. */
const reportedAt = (results: readonly { readonly reported: boolean }[], from: number): number[] =>
  results.flatMap((r, i) => (r.reported ? [from + i * 15] : []));

describe('the play is queued the moment the line is reached', () => {
  test('at a 50 % line, a 300 s story is queued in the observation where 150 s have played', async () => {
    const w = makeWorld({ rule: { finishThresholdPercent: 50 } });
    const results = await watch(w, film, 0, 300, SHORT);
    // The tab binds at 15 s: 135 s played at the 150 s sample, 150 s at the 165 s one.
    expect(reportedAt(results, 0)).toEqual([165]);
    const [entry] = w.outbox.entries();
    // The moment the line was reached, and the numbers of that observation.
    expect(entry?.watchedAt).toBe(T0 + 165_000);
    expect(entry?.body).toMatchObject({
      watched_at: '2026-10-20T21:02:45+02:00',
      duration_seconds: 400,
      furthest_position_seconds: 165,
      story_seconds: 300,
      played_seconds: 150,
      // Mid-story: nothing had shown that the title played out.
      ended: false,
    });
  });

  test('one play: the rest of the viewing, to the credits and the element’s end, sends nothing again', async () => {
    const w = makeWorld({ rule: { finishThresholdPercent: 50 } });
    await watch(w, film, 0, 390, SHORT);
    await observe(w, film, 400, { sample: { duration: 400, ended: true, paused: true } });
    expect(w.outbox.entries()).toHaveLength(1);
    expect(must(w.viewings.all()[0]).state).toBe('reported');
    expect(w.outbox.entries()[0]?.body).toMatchObject({ played_seconds: 150, ended: false });
  });

  test('skipped time is not played: a skim to the end sends nothing', async () => {
    const w = makeWorld({ rule: { finishThresholdPercent: 50 } });
    // 60 s of the opening, a seek past the first 15 % (so no intro), the last 10 s of the story.
    await watch(w, film, 0, 75, SHORT);
    await watch(w, film, 290, 390, SHORT);
    await observe(w, film, 400, { sample: { duration: 400, ended: true, paused: true } });
    expect(w.outbox.entries()).toEqual([]);
    expect(must(w.viewings.all()[0])).toMatchObject({ state: 'open', contentEnded: true });
  });

  test('a length learned late: no line until it is known, then the play in the observation it arrives in', async () => {
    const w = makeWorld({ rule: { finishThresholdPercent: 50 } });
    const arrival = filmReading('Arrival', 2016);
    // A stream that states no length: 435 s played, and no story to draw a line on.
    await watch(w, arrival, 0, 450, { serviceId: 'svc', sample: { duration: null } });
    expect(w.outbox.entries()).toEqual([]);
    expect(w.rules.reads).toBe(0);
    // The service states 1000 s: the story is 880 s, its line 440 s, passed by the 450 s played.
    const stated = await observe(w, { ...arrival, contentDurationSeconds: 1000 }, 465, {
      serviceId: 'svc',
    });
    expect(stated.reported).toBe(true);
    expect(w.outbox.entries()[0]?.body).toMatchObject({
      story_seconds: 880,
      played_seconds: 450,
      ended: false,
    });
  });
});
