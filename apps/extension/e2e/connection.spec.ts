/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The connection check, end to end (`GET /v1/integrations/connection`): a person disconnects in
// the web app and the extension must not keep saying Connected; and the two things a `200` adds,
// the server's end date and a status in words. The web app's part is played by the mock's
// `revoke()` and `setStatus()`. Expected values are written here from the requirements and the
// API's contract, never read from the build's output.

import type { Page, Worker } from '@playwright/test';
import type { Browser } from 'wxt/browser';

import { expect, playsArrive, test } from './fixtures.ts';
import type { Api } from './fixtures.ts';
import { NETFLIX } from './site.ts';

declare const self: { dispatchEvent(event: Event): boolean };
declare const chrome: Pick<typeof Browser, 'action'>;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Evaluated in the worker: its clock moves `ms` ahead (every later `Date.now()` too). The
 * worker asks at most once a minute, so a test that wants an ask moves the worker's
 * clock past the minute first.
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

/** The next page-open's ask is allowed: a minute and a bit has passed in the worker. */
async function letAMinutePass(sw: () => Promise<Worker>): Promise<void> {
  await (await sw()).evaluate(travel, 61_000);
}

/** How many times the extension has read the connection, from the proxy's record. */
const checks = (api: Api, status?: number): number =>
  api.seen.filter(
    (r) =>
      r.method === 'GET' &&
      r.path === '/v1/integrations/connection' &&
      (status === undefined || r.status === status),
  ).length;

const optionsUrl = (extensionId: string): string =>
  `chrome-extension://${extensionId}/options.html`;

test('disconnected in the web app: the popup stops saying Connected and offers Reconnect', async ({
  api,
  context,
  popup,
  sw,
}) => {
  const page = await context.newPage();
  await page.goto(NETFLIX.episode());

  // The web app's Disconnect.
  expect(api.mock.revoke()).toBe(1);
  await letAMinutePass(sw);

  const view = await popup(page);
  // The check's 401 is the plays route's: the connection is broken, and the words say it was
  // ended (the server does not say whether it was revoked or ran out).
  await view.waitForText('Reconnect needed');
  await view.waitForText('This connection was ended or has run out');
  const text = await view.text();
  expect(text).not.toContain('Connected');
  expect(
    await view.evaluate(
      `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Reconnect')`,
    ),
  ).toBe(true);
  // The ask was made, and the server refused it with the route's 401.
  expect(checks(api, 401)).toBeGreaterThanOrEqual(1);
});

test('the server’s end date replaces the estimate in Options: "Connection ends"', async ({
  api,
  context,
  extensionId,
  sw,
}) => {
  // A stored play slides the credential on the server to its arrival + 90 days. The mock's clock
  // is 20 days on (a play's `watched_at` must stay within 30), so the server's end is 110 days
  // after sign-in, and the extension's own estimate after the same play is 90: they differ.
  api.mock.advance(20 * DAY_MS);
  const page = await context.newPage();
  await page.goto(NETFLIX.episode());
  await page.evaluate(() => window.e2e.watch());
  await page.evaluate(() => window.e2e.ended());
  await playsArrive(api, 1);
  const arrival = api.plays()[0]?.receivedAt ?? 0;
  const serverEnd = arrival + 90 * DAY_MS;

  await letAMinutePass(sw);
  const options = await context.newPage();
  await options.goto(optionsUrl(extensionId));
  const connection = options.getByRole('region', { name: 'Connection' });
  // Before the server answers the row reads "Reconnect needed by" (the estimate); after, the
  // server's own date under its own label.
  await expect(connection.getByText('Connection ends', { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  const shown = await expectedDay(options, serverEnd);
  await expect(connection).toContainText(shown);
  // Not the estimate: 20 days earlier than the server's date.
  const estimate = await expectedDay(options, serverEnd - 20 * DAY_MS);
  expect(await connection.innerText()).not.toContain(estimate);
  await expect(connection.getByText('Reconnect needed by')).toHaveCount(0);
});

test('a braked connection says so in words, and on the icon', async ({
  api,
  context,
  popup,
  sw,
}) => {
  api.mock.setStatus('braked');
  const page = await context.newPage();
  await page.goto(NETFLIX.episode());
  await letAMinutePass(sw);

  const view = await popup(page);
  await view.waitForText('paused this connection, so plays are held until you review it');
  // The icon's existing braked problem: its title.
  await expect
    .poll(async () => (await sw()).evaluate(() => chrome.action.getTitle({})), { timeout: 15_000 })
    .toContain('paused this connection');
  // Braked is not broken: the connection stays connected.
  expect(await view.text()).not.toContain('Reconnect needed');
});

test('a suspended connection says so in words and leaves the icon alone', async ({
  api,
  context,
  popup,
  sw,
}) => {
  api.mock.setStatus('suspended');
  const page = await context.newPage();
  await page.goto(NETFLIX.episode());
  await letAMinutePass(sw);

  const view = await popup(page);
  await view.waitForText('Your account is being deleted');
  expect(await view.text()).not.toContain('Reconnect needed');
  expect(await (await sw()).evaluate(() => chrome.action.getTitle({}))).not.toContain(
    'paused this connection',
  );
});

/** `22 Oct 2026` as the page itself formats a day (the browser's own `Intl`, its own zone). */
function expectedDay(page: Page, at: number): Promise<string> {
  return page.evaluate(
    (ms) => new Intl.DateTimeFormat(navigator.language, { dateStyle: 'medium' }).format(ms),
    at,
  );
}
