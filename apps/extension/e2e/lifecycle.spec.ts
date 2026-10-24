/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The worker's life and the network's: a worker stopped mid-viewing, a server that answers 503,
// a play MediaTracker asks about. The fixture is the Netflix episode of netflix.spec.ts.

import { expect, playsArrive, test } from './fixtures.ts';
import { NETFLIX } from './site.ts';

/** The worker's global, as a function evaluated in it sees it. */
declare const self: { dispatchEvent(event: Event): boolean };

/**
 * Evaluated in the worker: its clock moves `ms` ahead (every later `Date.now()` too), and the
 * browser's `online` event fires, which drains the outbox.
 */
function travel(ms: number): void {
  const g = globalThis as unknown as { __shift?: number; __realNow?: () => number };
  if (g.__realNow === undefined) {
    const real = Date.now.bind(Date);
    g.__realNow = real;
    Date.now = () => real() + (g.__shift ?? 0);
  }
  g.__shift = (g.__shift ?? 0) + ms;
  self.dispatchEvent(new Event('online'));
}

test.describe('a worker stopped mid-viewing', () => {
  test('the play still arrives, exactly once, since the worker may stop at any moment', async ({
    api,
    context,
    stopWorker,
    workerIsFresh,
  }) => {
    const page = await context.newPage();
    await page.goto(NETFLIX.episode());
    await page.evaluate(() => window.e2e.watch());
    // Mid-viewing, as Chrome does after 30 s idle: the next report wakes a new worker.
    await page.evaluate((s) => window.e2e.at(s), 120);
    await stopWorker();
    await page.evaluate(() => window.e2e.ended());

    await playsArrive(api, 1);
    // At the stop the episode was short of its line: the play was queued and sent by a worker
    // that started after it.
    expect(await workerIsFresh()).toBe(true);
    // Exactly once: nothing more arrives, and every attempt carried the one key.
    await new Promise((r) => setTimeout(r, 10_000));
    expect(api.plays()).toHaveLength(1);
    expect(new Set(api.playAttempts().map((a) => a.idempotencyKey)).size).toBe(1);
    expect(api.plays()[0]?.evidence).toMatchObject({ kind: 'episode', episode_number: 2 });
  });
});

test.describe('offline at the finish', () => {
  test.use({ script: { plays: ['unavailable', 'unavailable', 'unavailable'] } });

  test('503 three times, then the play arrives with the same Idempotency-Key', async ({
    api,
    context,
    sw,
  }) => {
    const page = await context.newPage();
    await page.goto(NETFLIX.episode());
    await page.evaluate(() => window.e2e.watch());
    await page.evaluate(() => window.e2e.ended());

    await expect.poll(() => api.playAttempts().length, { timeout: 60_000 }).toBe(1);
    // A 5xx backs off 1, 2, then 5 minutes (±10 % jitter). The worker's clock is moved past
    // each wait and the browser's `online` event wakes the outbox — the clock the outbox reads,
    // not the alarm's, decides what is due.
    const waits = [1, 2, 5];
    for (const [i, minutes] of waits.entries()) {
      const worker = await sw();
      await worker.evaluate(travel, minutes * 1.15 * 60_000);
      await expect.poll(() => api.playAttempts().length, { timeout: 30_000 }).toBe(i + 2);
    }

    await playsArrive(api, 1, 30_000);
    const attempts = api.playAttempts();
    expect(attempts.map((a) => a.status)).toEqual([503, 503, 503, 202]);
    const keys = new Set(attempts.map((a) => a.idempotencyKey));
    expect(keys.size).toBe(1);
    expect(api.plays()[0]?.idempotencyKey).toBe(attempts[0]?.idempotencyKey);
  });
});

test.describe('a play MediaTracker asks about', () => {
  test.use({
    script: {
      progression: () => [{ afterMs: 0, state: 'needs_confirmation', reason: 'text_only' }],
    },
  });

  test("the popup's Waiting for you shows it, linking to the web app", async ({
    api,
    context,
    popup,
  }) => {
    const page = await context.newPage();
    await page.goto(NETFLIX.episode());
    await page.evaluate(() => window.e2e.watch());
    await page.evaluate(() => window.e2e.ended());
    await playsArrive(api, 1);

    const view = await popup(page);
    const text = await view.waitForText('Waiting for you');
    expect(text).toContain('Confirm in MediaTracker');
    expect(text).toContain('Breaking Bad');
    // Up Next in the web app (WEB_APP_BASE_URL + /today); the e2e build's web app is the
    // mock's URL.
    const hrefs = await view.evaluate(
      '[...document.querySelectorAll("a")].map((a) => a.getAttribute("href"))',
    );
    expect(hrefs).toContain(`${api.mock.url}/today`);
  });
});
