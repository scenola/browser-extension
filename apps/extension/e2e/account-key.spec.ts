/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A play belongs to the account it was recorded for, end to end. Account A queues two plays the
// server refuses for now, then its connection is ended in the web app. Whoever connects next is
// told apart only by the connection read's `account_key`: another account gets nothing of A's,
// and A's history goes; A itself gets its plays sent. The fixture is the Netflix episodes of
// netflix.spec.ts; the web app's part is the mock's `revoke()` and `signInAs()`.

import type { BrowserContext, Page, Worker } from '@playwright/test';

import { expect, playsArrive, test } from './fixtures.ts';
import type { Api } from './fixtures.ts';
import { NETFLIX } from './site.ts';

/** The worker's global, as a function evaluated in it sees it. */
declare const self: { dispatchEvent(event: Event): boolean };

/** Evaluated in the worker: how many records the outbox and the history hold. */
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
  for (const name of ['outbox', 'history']) counts[name] = await count(name);
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

const counts = async (sw: () => Promise<Worker>) => (await sw()).evaluate(storedCounts);

/** The plays of `account` the mock stored. */
const playsOf = (api: Api, account: string) => api.plays().filter((p) => p.account === account);

/**
 * Account A, connected by the fixture: one play sent, two the server refuses for now, then the
 * connection ended in the web app and the extension told so by a refused send.
 */
async function aLeavesTwoWaiting(
  api: Api,
  context: BrowserContext,
  sw: () => Promise<Worker>,
): Promise<void> {
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
  await page.close();
  await expect.poll(() => counts(sw)).toEqual({ outbox: 2, history: 1 });

  // The web app ends A's connection; the next send is refused with the route's 401.
  expect(api.mock.revoke()).toBe(1);
  await (await sw()).evaluate(travel, 2 * 60_000);
  await expect
    .poll(() => api.playAttempts().filter((a) => a.status === 401).length, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);
}

async function reconnect(context: BrowserContext, extensionId: string): Promise<Page> {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const connection = options.getByRole('region', { name: 'Connection' });
  await expect(connection.getByText('Reconnect needed')).toBeVisible({ timeout: 20_000 });
  await connection.getByRole('button', { name: 'Reconnect' }).click();
  await expect(connection.getByText('Connected since')).toBeVisible({ timeout: 20_000 });
  return options;
}

/** The connection read the new connection made, answered. */
async function accountRead(api: Api, before: number): Promise<void> {
  await expect
    .poll(
      () =>
        api.seen.filter(
          (r) => r.method === 'GET' && r.path === '/v1/integrations/connection' && r.status === 200,
        ).length,
      { timeout: 20_000 },
    )
    .toBeGreaterThan(before);
}

const answeredReads = (api: Api): number =>
  api.seen.filter(
    (r) => r.method === 'GET' && r.path === '/v1/integrations/connection' && r.status === 200,
  ).length;

test("another account connects: nothing of A's is sent, and A's history is gone", async ({
  api,
  context,
  extensionId,
  sw,
}) => {
  await aLeavesTwoWaiting(api, context, sw);
  const attempts = api.playAttempts().length;

  api.mock.signInAs('account-b');
  const reads = answeredReads(api);
  await reconnect(context, extensionId);
  await accountRead(api, reads);

  await expect.poll(() => counts(sw)).toEqual({ outbox: 0, history: 0 });
  // Whatever wakes the outbox now, nothing old goes.
  await (await sw()).evaluate(travel, 10 * 60_000);
  await new Promise((r) => setTimeout(r, 5_000));
  expect(api.playAttempts()).toHaveLength(attempts);
  expect(playsOf(api, 'account-b')).toEqual([]);
  expect(playsOf(api, 'account-a')).toHaveLength(1);
});

test('A reconnects instead: its plays are sent', async ({ api, context, extensionId, sw }) => {
  await aLeavesTwoWaiting(api, context, sw);

  await reconnect(context, extensionId);

  await expect.poll(() => playsOf(api, 'account-a').length, { timeout: 30_000 }).toBe(3);
  await expect.poll(() => counts(sw)).toEqual({ outbox: 0, history: 3 });
});
