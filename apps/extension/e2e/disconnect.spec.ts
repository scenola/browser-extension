/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// *Disconnect from this browser*, end to end: the account leaves with everything the extension
// kept for it, and the next connection is sent nothing of it. The fixture is the Netflix episodes
// of netflix.spec.ts; the two plays that wait are refused with a 503 by the mock.

import type { Page, Worker } from '@playwright/test';

import { expect, playsArrive, test } from './fixtures.ts';
import { NETFLIX } from './site.ts';

/** The worker's global, as a function evaluated in it sees it. */
declare const self: { dispatchEvent(event: Event): boolean };

/**
 * Evaluated in the worker: how many records each store of the account holds, read from the
 * extension's database itself.
 */
async function storedCounts(): Promise<Record<string, number>> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open('scenola');
    open.onsuccess = () => {
      resolve(open.result);
    };
    open.onerror = () => {
      reject(new Error('the database did not open'));
    };
  });
  const count = (name: string): Promise<number> =>
    new Promise((resolve) => {
      const request = db.transaction(name).objectStore(name).count();
      request.onsuccess = () => {
        resolve(request.result);
      };
    });
  const counts: Record<string, number> = {};
  for (const name of ['outbox', 'history', 'viewings', 'tabs']) counts[name] = await count(name);
  db.close();
  return counts;
}

/** Evaluated in the worker: its clock moves `ms` ahead, and `online` wakes the outbox. */
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

async function openOptions(page: Page, extensionId: string) {
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  return page.getByRole('region', { name: 'Connection' });
}

async function counts(sw: () => Promise<Worker>): Promise<Record<string, number>> {
  return (await sw()).evaluate(storedCounts);
}

test('disconnect and delete: no history, no queued plays, and a new connection sends nothing old', async ({
  api,
  context,
  extensionId,
  popup,
  sw,
}) => {
  // One play sent: the history. Then two that the server refuses for now: the outbox.
  const page = await context.newPage();
  await page.goto(NETFLIX.episode());
  await page.evaluate(() => window.e2e.watch());
  await page.evaluate(() => window.e2e.ended());
  await playsArrive(api, 1);
  api.mock.force({ plays: ['unavailable', 'unavailable'] });
  for (const [i, videoId] of [70196254, 70196255].entries()) {
    await page.evaluate((id) => window.e2e.nextEpisode(id), videoId);
    await page.evaluate(() => window.e2e.ended());
    await expect.poll(() => api.playAttempts().length, { timeout: 60_000 }).toBe(i + 2);
  }
  await expect.poll(() => counts(sw)).toMatchObject({ outbox: 2, history: 1 });
  await page.close();

  const options = await context.newPage();
  const connection = await openOptions(options, extensionId);
  await connection.getByRole('button', { name: 'Disconnect from this browser' }).click();
  const confirm = connection.getByRole('group');
  await expect(confirm).toContainText("2 plays haven't been sent yet");
  await expect(
    confirm.getByRole('button', { name: 'Send 2 first, then disconnect' }),
  ).toBeVisible();
  await confirm.getByRole('button', { name: 'Disconnect and delete them' }).click();

  await expect(connection.getByText(/^Disconnected\./u)).toBeVisible({ timeout: 20_000 });
  await expect(connection).toContainText("2 plays couldn't be sent and were deleted.");
  expect(await counts(sw)).toEqual({ outbox: 0, history: 0, viewings: 0, tabs: 0 });

  // The popup shows nothing of the account that left.
  const blank = await context.newPage();
  await blank.goto(NETFLIX.episode());
  const view = await popup(blank);
  const text = await view.waitForText('Not connected');
  expect(text).not.toContain('Breaking Bad');
  view.close();
  await blank.close();

  // Another connection: nothing old is sent, whatever wakes the outbox.
  const attempts = api.playAttempts().length;
  await connection.getByRole('button', { name: 'Connect Scenola' }).click();
  await expect(connection.getByText('Connected since')).toBeVisible({ timeout: 20_000 });
  await (await sw()).evaluate(travel, 10 * 60_000);
  await new Promise((r) => setTimeout(r, 5_000));
  expect(api.playAttempts()).toHaveLength(attempts);
  expect(api.plays()).toHaveLength(1);
  expect(await counts(sw)).toMatchObject({ outbox: 0, history: 0 });
});
