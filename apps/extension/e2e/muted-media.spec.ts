/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What a page can show about media that is not the viewing: a muted element, and media beside
// the player, end to end.

import { evidence, expect, nothingArrives, playsArrive, test } from './fixtures.ts';
import { FILM_SECONDS, GENERIC, NETFLIX } from './site.ts';

test('a muted autoplay trailer, played to its end, opens nothing', async ({ api, context }) => {
  const page = await context.newPage();
  await page.goto(GENERIC.trailer);
  // It autoplays muted (the page's own `muted autoplay`); nobody unmutes it.
  await page.evaluate(() => window.e2e.watch());
  expect(await page.evaluate(() => window.e2e.video().muted)).toBe(true);
  await page.evaluate(() => window.e2e.ended());

  await nothingArrives(api, 8_000);
});

test('muted mid-episode, the next episode that autoplays muted is still tracked', async ({
  api,
  context,
}) => {
  const page = await context.newPage();
  await page.goto(NETFLIX.episode());
  await page.evaluate(() => window.e2e.watch());
  await page.evaluate((s) => window.e2e.at(s), 150);
  await page.evaluate(() => {
    window.e2e.mute();
  });
  await page.evaluate(() => window.e2e.ended());
  await playsArrive(api, 1);

  // Netflix autoplays the next episode on the same player, still muted.
  await page.evaluate(() => window.e2e.nextEpisode(70196254));
  expect(await page.evaluate(() => window.e2e.video().muted)).toBe(true);
  await page.evaluate(() => window.e2e.ended());

  await playsArrive(api, 2);
  expect([evidence(api, 0).episode_number, evidence(api, 1).episode_number]).toEqual([2, 3]);
});

test('a muted preview playing beside the paused film adds nothing', async ({ api, context }) => {
  const page = await context.newPage();
  await page.goto(GENERIC.filmAndPreview);
  await page.evaluate(() => window.e2e.watch(0));
  await page.evaluate((s) => window.e2e.at(s, 0), 0.5 * FILM_SECONDS);
  await page.evaluate(() => {
    window.e2e.pause(0);
  });
  // The preview (another length, muted) plays to its own end beside it.
  await page.evaluate(() => window.e2e.play(1, 16));
  await page.evaluate(() => window.e2e.ended(1));
  // Its samples neither finished the film nor added to its coverage: nothing was sent.
  await nothingArrives(api, 8_000);

  // The film resumes and finishes: one play, the film's own length and position.
  await page.evaluate(() => window.e2e.play(0, 16));
  await page.evaluate(() => window.e2e.ended(0));
  await playsArrive(api, 1);
  const play = evidence(api, 0);
  expect(play.title).toBe('Arrival');
  expect(play.duration_seconds).toBe(FILM_SECONDS);
});
