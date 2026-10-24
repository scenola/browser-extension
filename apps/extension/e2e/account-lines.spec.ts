/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The account's lines decide what is sent, judged over the story by the seconds played. The
// 600 s film's story ends at its credits estimate, 600 − 12 % = 528 s; the start line at 10 % is
// max(ceil(52.8), 300) = 300 s played, the finish line at 50 % is 264 s and at 70 % ceil(369.6) =
// 370 s. A film that skips 80 s plays well under what its position reaches: the fixture's
// collector samples a 16× film every 15 s, so the seconds played come out near 300, between the
// two lines.
// The extension reads the lines when a page of its own opens, so each test makes it read them
// before the film plays.

import type { BrowserContext, Page } from '@playwright/test';

import { evidence, expect, nothingArrives, playsArrive, test } from './fixtures.ts';
import type { Api } from './fixtures.ts';
import { NETFLIX } from './site.ts';

const STORY_SECONDS = 528;
const FINISH_50 = 264;
const FINISH_70 = 370;

/**
 * Evaluated in the worker: its clock moves `ms` ahead (every later `Date.now()` too). The
 * connection was read when the fixture connected, and is read at most once a minute.
 */
function travel(ms: number): void {
  const g = globalThis as unknown as { __shift?: number; __realNow?: () => number };
  if (g.__realNow === undefined) {
    const real = Date.now.bind(Date);
    g.__realNow = real;
    Date.now = () => real() + (g.__shift ?? 0);
  }
  g.__shift = (g.__shift ?? 0) + ms;
}

/**
 * The next page-open's read is allowed: a minute and a bit passes in the worker. The returned
 * function sets its clock back, so the alarms after it keep real time.
 */
async function letAMinutePass(context: BrowserContext): Promise<() => Promise<void>> {
  const worker = context.serviceWorkers().at(-1) ?? (await context.waitForEvent('serviceworker'));
  await worker.evaluate(travel, 61_000);
  return async () => {
    await worker.evaluate(travel, -61_000);
  };
}

/** The account sets its finish line; the extension reads it, as the Counting section says. */
async function accountSets(
  api: Api,
  context: BrowserContext,
  extensionId: string,
  percent: 50 | 70 | 90,
): Promise<void> {
  api.mock.setFinishThreshold(percent);
  const backInTime = await letAMinutePass(context);
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html#counting`);
  await expect(
    options
      .getByRole('region', { name: 'Counting' })
      .getByText(
        `A film or an episode is added when you've played ${String(percent)} % of its story`,
        { exact: true },
      ),
  ).toBeVisible({ timeout: 20_000 });
  await backInTime();
  await options.close();
}

/** Plays the film, skips 80 s from 150 s, and plays on to the end. */
async function playWithASkip(page: Page): Promise<void> {
  await page.evaluate(() => window.e2e.watch());
  await page.evaluate((s) => window.e2e.at(s), 150);
  await page.evaluate(() => {
    window.e2e.seek(230);
  });
  await page.evaluate(() => window.e2e.ended());
}

test('a skim to the end plays too little to start or to count: nothing is sent', async ({
  api,
  context,
  extensionId,
}) => {
  api.mock.setStartThreshold(10);
  await accountSets(api, context, extensionId, 50);
  const page = await context.newPage();
  await page.goto(NETFLIX.film());
  await page.evaluate(() => window.e2e.watch());
  // The furthest position becomes the end of the film; the seconds played stay a few dozen.
  await page.evaluate((s) => {
    window.e2e.seek(s);
  }, 0.95 * 600);
  await page.evaluate(() => window.e2e.ended());

  await nothingArrives(api, 8_000);
});

test('the finish line from the account decides: 50 % counts a film that skipped 80 s, with the numbers it was judged by', async ({
  api,
  context,
  extensionId,
}) => {
  await accountSets(api, context, extensionId, 50);
  const page = await context.newPage();
  await page.goto(NETFLIX.film());
  await playWithASkip(page);

  await playsArrive(api, 1);
  const play = evidence(api, 0);
  expect(play.kind).toBe('movie');
  expect(play.report).toBeUndefined();
  expect(play.story_seconds).toBe(STORY_SECONDS);
  // Over the 50 % line and under the 70 % one: the skipped stretch is not played.
  expect(play.played_seconds).toBeGreaterThanOrEqual(FINISH_50);
  expect(play.played_seconds).toBeLessThan(FINISH_70);
  // The furthest position is far past what was played, and `ended` says only what the title did.
  expect(play.furthest_position_seconds).toBeGreaterThan(play.played_seconds ?? 0);
  expect(play.ended).toBe(false);
});

test('the same film at a 70 % line: held back, never sent', async ({
  api,
  context,
  extensionId,
}) => {
  await accountSets(api, context, extensionId, 70);
  const page = await context.newPage();
  await page.goto(NETFLIX.film());
  await playWithASkip(page);

  await nothingArrives(api, 8_000);
});

test('a line the account changed after it was read is the server’s to refuse: the play is dropped, not retried', async ({
  api,
  context,
  extensionId,
}) => {
  // The extension reads 50 %, then the account moves it to 90 % before the play is sent.
  await accountSets(api, context, extensionId, 50);
  api.mock.setFinishThreshold(90);
  const reads = () =>
    api.seen.filter((r) => r.method === 'GET' && r.path === '/v1/integrations/connection').length;
  const readsBefore = reads();
  const page = await context.newPage();
  await page.goto(NETFLIX.film());
  await playWithASkip(page);

  // The extension held to 50 % and sent; the server's 90 % does not count it, and says so.
  await expect
    .poll(() => api.playAttempts().length, { timeout: 30_000, intervals: [250] })
    .toBeGreaterThanOrEqual(1);
  expect(api.plays()).toEqual([]);
  // Not retried: one attempt, answered 202.
  await new Promise((r) => setTimeout(r, 3_000));
  expect(api.playAttempts()).toHaveLength(1);
  expect(api.playAttempts()[0]?.status).toBe(202);
  // And the connection was asked again at once, so the next viewing uses the account's line.
  expect(reads()).toBeGreaterThan(readsBefore);
});
