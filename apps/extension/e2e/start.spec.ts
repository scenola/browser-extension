/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The account's lines, end to end: read from the connection check, one start sent once the
// story seconds played pass the start line, and the viewing still sent as its own play once they
// pass the finish line, with the four numbers and `ended` only from the end itself. The app's
// settings are played by the mock's `setStartThreshold`. Expected values are the contract's: the
// 600 s film's story ends at its credits estimate, 600 − 12 % = 528 s, so the start line at 10 %
// is max(ceil(52.8), 300) = 300 s played, and the finish line at 90 % is ceil(475.2) = 476 s.

import type { BrowserContext } from '@playwright/test';

import { expect, playsArrive, test } from './fixtures.ts';
import type { Api } from './fixtures.ts';
import { FILM_SECONDS, NETFLIX } from './site.ts';

/** What a start may carry: the viewing's play without its time and its end, plus `report`. */
const START_FIELDS = [
  'duration_seconds',
  'furthest_position_seconds',
  'ids',
  'kind',
  'played_seconds',
  'report',
  'story_seconds',
  'title',
  'year',
];

const STORY_SECONDS = 528;
const START_LINE = 300;
const FINISH_LINE = 476;

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
 * function sets its clock back, so the alarms after it (the receipts' +10 s) keep real time.
 */
async function letAMinutePass(context: BrowserContext): Promise<() => Promise<void>> {
  const worker = context.serviceWorkers().at(-1) ?? (await context.waitForEvent('serviceworker'));
  await worker.evaluate(travel, 61_000);
  return async () => {
    await worker.evaluate(travel, -61_000);
  };
}

/**
 * Settings opened: its port is a page opening, so the worker reads the connection — and with it
 * the account's lines — and the Counting section says them in words.
 */
async function openCounting(
  context: BrowserContext,
  extensionId: string,
  words: readonly string[],
): Promise<void> {
  const backInTime = await letAMinutePass(context);
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html#counting`);
  const counting = options.getByRole('region', { name: 'Counting' });
  for (const text of words) {
    await expect(counting.getByText(text, { exact: true })).toBeVisible({ timeout: 20_000 });
  }
  await backInTime();
  await expect(counting.getByRole('link', { name: 'Change in Scenola' })).toBeVisible();
  await options.close();
}

const starts = (api: Api) => api.plays().filter((p) => p.evidence.report === 'start');
const FINISH_WORDS = "A film or an episode is added when you've played 90 % of its story";

test('starts at 10 %: past the line, one start with the play’s numbers, then the play itself', async ({
  api,
  context,
  extensionId,
  popup,
}) => {
  api.mock.setStartThreshold(10);
  api.mock.setFinishThreshold(90);
  await openCounting(context, extensionId, [
    FINISH_WORDS,
    'Films you start are saved in progress after 10 % (at least 5 min)',
  ]);

  const page = await context.newPage();
  await page.goto(NETFLIX.film());
  await page.evaluate(() => window.e2e.watch());
  await page.evaluate(() => window.e2e.ended());
  await playsArrive(api, 2);

  // The start came first, under its own key, and only one was sent.
  expect(starts(api)).toHaveLength(1);
  const [start, play] = api.plays();
  if (start === undefined || play === undefined) throw new Error('two plays expected');
  expect(start.evidence.report).toBe('start');
  expect(start.idempotencyKey).not.toBe(play.idempotencyKey);
  expect(api.playAttempts().filter((r) => r.status === 202)).toHaveLength(2);

  const body = start.evidence;
  expect(Object.keys(body).sort()).toEqual(START_FIELDS);
  expect(body).toMatchObject({
    report: 'start',
    kind: 'movie',
    title: 'The Irishman',
    year: 2019,
    duration_seconds: FILM_SECONDS,
    story_seconds: STORY_SECONDS,
  });
  expect(body.ids?.provider?.[0]?.namespace).toBe('provider.netflix');
  // Sent once the story seconds played passed the line, and before the story's end.
  expect(body.played_seconds).toBeGreaterThanOrEqual(START_LINE);
  expect(body.played_seconds).toBeLessThan(STORY_SECONDS);
  expect(body.furthest_position_seconds).toBeLessThan(STORY_SECONDS);

  // The viewing is its own play: a time, all four numbers, played past the finish line. It was
  // sent the moment they reached it, before the element ended: nothing had said the title played
  // out, so `ended` is false.
  expect(play.evidence.report).toBeUndefined();
  expect(typeof play.evidence.watched_at).toBe('string');
  expect(play.evidence.story_seconds).toBe(STORY_SECONDS);
  expect(play.evidence.played_seconds).toBeGreaterThanOrEqual(FINISH_LINE);
  expect(play.evidence.ended).toBe(false);

  // Recently: the start is a line of its own, and the server's answer reads in words.
  const view = await popup(page);
  await view.waitForText('Started · ');
  await view.waitForText('Saved in progress', 45_000);
});

test('starts off: no start is sent, and the film’s play is its one play', async ({
  api,
  context,
  extensionId,
}) => {
  api.mock.setFinishThreshold(90);
  await openCounting(context, extensionId, [FINISH_WORDS, 'Films you start', 'Off']);

  const page = await context.newPage();
  await page.goto(NETFLIX.film());
  await page.evaluate(() => window.e2e.watch());
  await page.evaluate(() => window.e2e.ended());
  await playsArrive(api, 1);

  expect(starts(api)).toEqual([]);
  expect(api.playAttempts()).toHaveLength(1);
  expect(api.plays()[0]?.evidence.played_seconds).toBeGreaterThanOrEqual(FINISH_LINE);
});
