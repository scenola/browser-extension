/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `ended` on a play: true only when the title had played out by the moment the play was queued —
// the element of the viewing's own media reached its end, or the service's own credits or
// post-play signal showed. The extension's estimate of where the credits start is part of the
// story the line is drawn on, never whether the play says `ended`; neither is a credits start the
// service states. A wrong `ended` would record a skimmed film, so every doubtful case is false.

import { describe, expect, test } from 'vitest';

import { DAY_MS } from '../domain/time';
import { filmReading, makeWorld, must, observe, watch } from './test-world';
import type { World } from './test-world';

const film = filmReading('Arrival', 2016);

/** The play queued so far, which these tests expect to be one. */
async function onlyPlay(w: World) {
  const entries = await w.outbox.list();
  expect(entries).toHaveLength(1);
  return must(entries[0]).body;
}

describe('the element ends', () => {
  test('on the viewing’s own media, before the line is reached: `ended` is true', async () => {
    const w = makeWorld();
    // Bound at 315 s and played to the end: 565 s of the 880 s story, short of the 616 s line.
    await watch(w, film, 300, 990);
    await observe(w, film, 1000, { sample: { ended: true, paused: true } });
    expect(await w.outbox.list()).toEqual([]);
    expect(must(w.viewings.all()[0]).contentEnded).toBe(true);
    // The opening, played the next day, reaches the line: the element had ended by then.
    await w.viewings.dropTab(1);
    w.clock.advance(DAY_MS);
    await watch(w, film, 0, 90, { tabId: 2 });
    expect((await onlyPlay(w)).ended).toBe(true);
  });

  test('a play queued mid-story says false, and the element ending later sends nothing again', async () => {
    const w = makeWorld();
    await watch(w, film, 0, 885);
    // Bound at 15 s, so the 616 s line is reached at the sample at 645 s, the credits still ahead.
    expect(await onlyPlay(w)).toMatchObject({
      ended: false,
      furthest_position_seconds: 645,
      played_seconds: 630,
    });
    await observe(w, film, 1000, { sample: { ended: true, paused: true } });
    expect(await w.outbox.list()).toHaveLength(1);
  });

  test('before the viewing knows its media’s length, an element’s end ends nothing', async () => {
    const w = makeWorld();
    // Each sample states a slightly different length, so no two consecutive ones agree: nothing
    // yet vouches for the element's length, and the service states none.
    for (const [i, duration] of [1000, 1010, 1020, 1030].entries()) {
      await observe(w, film, i * 15, { sample: { duration } });
    }
    await observe(w, film, 100, { sample: { duration: 1030, ended: true, paused: true } });
    const viewing = must(w.viewings.all()[0]);
    expect(viewing.contentEnded).toBe(false);
  });

  test.each([
    ['the same length', 1000, true],
    ['a minute longer', 1060, true],
    ['a minute and a second longer', 1061, false],
    ['a minute shorter', 940, true],
    ['a minute and a second shorter', 939, false],
    ['a different length altogether', 300, false],
    ['a clip under two minutes', 90, false],
  ])('an element of %s ending: contentEnded is %s', async (_n, length, ended) => {
    const w = makeWorld();
    await watch(w, film, 0, 60);
    await observe(w, film, 100, { sample: { duration: length, ended: true, paused: true } });
    expect(must(w.viewings.all()[0]).contentEnded).toBe(ended);
  });

  test('the allowed difference grows with the length: 2 % of a long film', async () => {
    const w = makeWorld();
    const long = { sample: { duration: 10_000 } };
    await watch(w, film, 0, 60, long);
    // 2 % of 10 200 s is 204 s: a media 200 s longer is the same.
    await observe(w, film, 100, { sample: { duration: 10_200, ended: true, paused: true } });
    expect(must(w.viewings.all()[0]).contentEnded).toBe(true);
    const other = makeWorld();
    await watch(other, film, 0, 60, long);
    await observe(other, film, 100, { sample: { duration: 10_300, ended: true, paused: true } });
    expect(must(other.viewings.all()[0]).contentEnded).toBe(false);
  });

  test('an ad that ends is not the content ending', async () => {
    const w = makeWorld();
    await watch(w, film, 0, 60);
    await observe(w, film, 20, { sample: { adPlaying: true, ended: true, paused: true } });
    expect(must(w.viewings.all()[0]).contentEnded).toBe(false);
  });

  test('a service’s stated length vouches for the media when the element has not agreed twice', async () => {
    const w = makeWorld();
    const stated = { ...film, contentDurationSeconds: 1000 };
    await observe(w, stated, 0, { serviceId: 'svc' });
    await observe(w, stated, 15, { serviceId: 'svc' });
    await observe(w, stated, 30, {
      serviceId: 'svc',
      sample: { duration: 1000, ended: true, paused: true },
    });
    expect(must(w.viewings.all()[0]).contentEnded).toBe(true);
  });
});

describe('the service shows its credits or post-play screen', () => {
  test('`ended` is true, and the position where it first showed is where the story ends', async () => {
    const w = makeWorld();
    // 585 s of the 880 s story the estimate draws: short of its 616 s line.
    await watch(w, film, 0, 600);
    expect(await w.outbox.list()).toEqual([]);
    // The credits show at 615 s: the story is 615 s, its line 431 s, reached in that observation.
    await observe(w, { ...film, contentEnded: true }, 615);
    const body = await onlyPlay(w);
    expect(body.ended).toBe(true);
    expect(body.story_seconds).toBe(615);
  });
});

describe('what never says the title played out', () => {
  test('the extension’s estimate of the credits start', async () => {
    const w = makeWorld();
    // Past the 880 s estimate, short of the line; the opening, the next day, reaches it.
    await watch(w, film, 300, 900);
    await w.viewings.dropTab(1);
    w.clock.advance(DAY_MS);
    await watch(w, film, 0, 90, { tabId: 2 });
    expect((await onlyPlay(w)).ended).toBe(false);
  });

  test('a credits start the service states', async () => {
    const w = makeWorld({ rule: { finishThresholdPercent: 50 } });
    const stated = { ...film, creditsStartSeconds: 950 };
    await watch(w, stated, 0, 960, { serviceId: 'svc' });
    const body = await onlyPlay(w);
    expect(body.ended).toBe(false);
    expect(body.story_seconds).toBe(950);
  });

  test('a viewing skipped to its credits at a line it met', async () => {
    const w = makeWorld({ rule: { finishThresholdPercent: 50 } });
    await watch(w, film, 0, 450);
    await watch(w, film, 870, 900);
    expect((await onlyPlay(w)).ended).toBe(false);
  });
});
