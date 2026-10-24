/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Netflix, end to end. The fixture is Breaking Bad S1 E2 "Cat's in the Bag...", video
// 70196253, and Netflix's film fixture, The Irishman (80175798). Every expected value is
// written here from the requirements, never read from the build.

import { evidence, expect, nothingArrives, playsArrive, test } from './fixtures.ts';
import { EPISODE_SECONDS, FILM_SECONDS, NETFLIX } from './site.ts';

/** These fields, and nothing else, may leave. */
const PLAY_FIELDS = new Set([
  'kind',
  'ids',
  'title',
  'year',
  'show',
  'season_number',
  'episode_number',
  'watched_at',
  'duration_seconds',
  'furthest_position_seconds',
  // The story's length and the story seconds played.
  'story_seconds',
  'played_seconds',
  'ended',
]);
/** ISO 8601 with an offset. */
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
/** Evaluated in the popup: the words of *Now playing*'s state line. */
const NOW_PLAYING_STATE =
  'document.querySelector(\'[aria-labelledby="now-playing-heading"] [aria-live="polite"]\')?.textContent ?? ""';

test('an episode played to the end: one play with only the allowed fields, and the popup says Added', async ({
  api,
  context,
  popup,
}) => {
  const page = await context.newPage();
  await page.goto(NETFLIX.episode());
  await page.evaluate(() => window.e2e.watch());
  await page.evaluate(() => window.e2e.ended());

  await playsArrive(api, 1);
  const play = evidence(api, 0);
  expect(Object.keys(play).filter((key) => !PLAY_FIELDS.has(key))).toEqual([]);
  expect(play.kind).toBe('episode');
  // An episode's own title; the show's under `show`; the numbers as the page numbers them.
  expect(play.title).toBe("Cat's in the Bag...");
  expect(play.show?.title).toBe('Breaking Bad');
  expect(play.season_number).toBe(1);
  expect(play.episode_number).toBe(2);
  // The service's own id at the level it belongs — the episode's, on the episode.
  expect(play.ids?.provider).toEqual([
    expect.objectContaining({ namespace: 'provider.netflix', value: '70196253' }),
  ]);
  expect(play.show?.ids?.provider ?? []).not.toContainEqual(
    expect.objectContaining({ value: '70196253' }),
  );
  expect(play.watched_at).toMatch(WITH_OFFSET);
  expect(play.duration_seconds).toBe(EPISODE_SECONDS);
  // Recorded the moment the story's seconds played reached the account's line, the server's
  // 70 % until it is changed in the app: wherever the sample that crossed it fell. With no
  // credits marker the story ends at `duration − min(12 %, 20 min)`. Nothing had said the title
  // played out by then, so `ended` is false.
  expect(play.furthest_position_seconds).toBeGreaterThanOrEqual(play.played_seconds ?? 0);
  expect(play.furthest_position_seconds).toBeLessThanOrEqual(EPISODE_SECONDS);
  const story = EPISODE_SECONDS - (12 * EPISODE_SECONDS) / 100;
  expect(play.story_seconds).toBe(story);
  expect(play.played_seconds).toBeGreaterThanOrEqual(Math.ceil((70 * story) / 100));
  expect(play.ended).toBe(false);
  // The play's id is its Idempotency-Key; one play, one key.
  expect(api.plays()[0]?.idempotencyKey).toBe(api.playAttempts()[0]?.idempotencyKey);

  // The now-playing line: *Recently* says "Added" of the play's receipt too.
  const view = await popup(page);
  await expect.poll(() => view.evaluate(NOW_PLAYING_STATE), { timeout: 15_000 }).toBe('Added');
});

test('while it plays, the popup shows what the page says: show, numbers, episode title', async ({
  context,
  popup,
}) => {
  const page = await context.newPage();
  await page.goto(NETFLIX.episode());
  // A viewing binds on its second observation (~15 s): watch() plays 21 s at 1× first.
  await page.evaluate(() => window.e2e.watch());
  await page.evaluate(() => {
    window.e2e.rate(1);
  });

  // Short of the account's line (70 % until it is changed in the app): the popup says where it
  // falls.
  const view = await popup(page);
  const text = await view.waitForText('Added at 70 %');
  expect(text).toContain('Netflix');
  expect(text).toContain('Breaking Bad');
  expect(text).toContain('S1 E2');
  // The line reads "S1 E2 · Cat's in the Bag…" — what the page says, the episode's title too.
  expect(text).toContain("Cat's in the Bag");
});

test('a film stopped at an early post-play screen: the credits start there, its line is met, ended: true', async ({
  api,
  context,
}) => {
  const page = await context.newPage();
  await page.goto(NETFLIX.film());
  await page.evaluate(() => window.e2e.watch());
  // At 55 % the film slows to 1× (a sample of its own), short of the line the estimated story
  // draws: 70 % of 528 s is 370 s, and about 310 s were played from where the tab bound. Then
  // Netflix's post-play screen shows (the module's end-of-content signal), seen within one 5 s
  // snapshot: the story ends where it first appears, and 70 % of that shorter story is within
  // what was played. A paused player is not sampled, so the person stops after.
  await page.evaluate((s) => window.e2e.at(s), 0.55 * FILM_SECONDS);
  await page.evaluate(() => {
    window.e2e.rate(1);
  });
  await page.evaluate(() => {
    window.e2e.showPostplay();
  });

  await playsArrive(api, 1, 30_000);
  await page.evaluate(() => {
    window.e2e.pause();
  });
  const play = evidence(api, 0);
  expect(play.kind).toBe('movie');
  expect(play.title).toBe('The Irishman');
  expect(play.year).toBe(2019);
  expect(play.duration_seconds).toBe(FILM_SECONDS);
  // The story ends where the post-play screen showed, at the sample that queued the play.
  expect(play.furthest_position_seconds).toBeGreaterThanOrEqual(0.55 * FILM_SECONDS);
  expect(play.furthest_position_seconds).toBeLessThan(0.7 * FILM_SECONDS);
  expect(play.story_seconds).toBe(play.furthest_position_seconds);
  expect(play.played_seconds).toBeGreaterThanOrEqual(
    Math.ceil((70 * (play.story_seconds ?? 0)) / 100),
  );
  // The service said the content ended before the play was queued.
  expect(play.ended).toBe(true);
});

test('a skim — bound, then a seek to 95 % and played to the end — sends nothing', async ({
  api,
  context,
}) => {
  const page = await context.newPage();
  await page.goto(NETFLIX.episode());
  await page.evaluate(() => window.e2e.watch());
  await page.evaluate((s) => {
    window.e2e.seek(s);
  }, 0.95 * EPISODE_SECONDS);
  await page.evaluate(() => window.e2e.ended());

  // Played to the end, `ended` fired, the furthest position 100 %: the story seconds played are
  // far under the account's line (70 % until it is changed in the app).
  await nothingArrives(api, 8_000);
});

test('autoplay into the next episode on the same element: two plays, two keys', async ({
  api,
  context,
}) => {
  const page = await context.newPage();
  await page.goto(NETFLIX.episode());
  await page.evaluate(() => window.e2e.watch());
  await page.evaluate(() => window.e2e.ended());
  await playsArrive(api, 1);

  await page.evaluate(() => window.e2e.nextEpisode(70196254));
  await page.evaluate(() => window.e2e.ended());
  await playsArrive(api, 2);

  const [first, second] = [evidence(api, 0), evidence(api, 1)];
  expect([first.episode_number, second.episode_number]).toEqual([2, 3]);
  expect(second.title).toBe("...And the Bag's in the River");
  expect(second.show?.title).toBe('Breaking Bad');
  expect(second.ids?.provider).toEqual([
    expect.objectContaining({ namespace: 'provider.netflix', value: '70196254' }),
  ]);
  // Two viewings, two Idempotency-Keys.
  const keys = api.plays().map((p) => p.idempotencyKey);
  expect(new Set(keys).size).toBe(2);
  // The second's coverage is its own: the first episode's ranges were not carried across.
  expect(second.furthest_position_seconds).toBeLessThanOrEqual(EPISODE_SECONDS);
});

test("after a skimmed episode, the next one's play names the next one's id, never the skimmed one's", async ({
  api,
  context,
}) => {
  // Identity: one title's id never reaches another title's play.
  const page = await context.newPage();
  await page.goto(NETFLIX.episode());
  await page.evaluate(() => window.e2e.watch());
  await page.evaluate((s) => {
    window.e2e.seek(s);
  }, 0.95 * EPISODE_SECONDS);
  await page.evaluate(() => window.e2e.ended());
  await page.evaluate(() => window.e2e.nextEpisode(70196254));
  await page.evaluate(() => window.e2e.ended());

  await playsArrive(api, 1);
  const play = evidence(api, 0);
  expect(play.episode_number).toBe(3);
  expect(play.title).toBe("...And the Bag's in the River");
  expect(play.ids?.provider).toEqual([
    expect.objectContaining({ namespace: 'provider.netflix', value: '70196254' }),
  ]);
});
