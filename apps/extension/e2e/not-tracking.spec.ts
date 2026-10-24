/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A video that plays and is not tracked says why, in the popup and nowhere else (no badge, no
// play); the toolbar says whether the tab is tracked; and the help the popup offers opens Settings
// where it is.

import type { Browser } from 'wxt/browser';

import { expect, nothingArrives, test } from './fixtures.ts';
import { GENERIC, NETFLIX } from './site.ts';

/** The extension APIs, as the functions evaluated in its service worker see them. */
declare const chrome: Pick<typeof Browser, 'action' | 'tabs'>;

test('a clip that does not say it is a film: the popup says so and offers a sample; no play, no badge', async ({
  api,
  context,
  popup,
  sw,
}) => {
  const page = await context.newPage();
  await page.goto(GENERIC.clip);
  await page.evaluate(() => window.e2e.watch());
  await page.evaluate(() => {
    window.e2e.rate(1);
  });

  const view = await popup(page);
  const text = await view.waitForText("This page doesn't say what's playing");
  expect(text).toContain('fixture.example');
  expect(text).toContain('Send a page sample');
  expect(text).not.toContain('Added at');
  view.close();

  // No badge: the page is one the extension is right to ignore.
  const worker = await sw();
  const badge = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return chrome.action.getBadgeText({ tabId: tab?.id ?? -1 });
  });
  expect(badge).toBe('');
  await nothingArrives(api, 3_000);
});

test('Send a page sample opens Settings at the capture row, where the sample says what it holds', async ({
  context,
  popup,
}) => {
  const page = await context.newPage();
  await page.goto(GENERIC.clip);
  await page.evaluate(() => window.e2e.watch());
  await page.evaluate(() => {
    window.e2e.rate(1);
  });

  const view = await popup(page);
  await view.waitForText('Send a page sample');
  const opened = context.waitForEvent('page');
  await view.evaluate(
    `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Send a page sample')).click()`,
  );
  const options = await opened;
  await options.waitForLoadState();
  expect(options.url()).toMatch(/\/options\.html#capture$/u);
  await expect(options.getByText('Capture page sample')).toBeFocused();

  await options.getByRole('button', { name: 'Capture' }).click();
  await expect(options.getByText('What the sample holds')).toBeVisible();
  for (const part of [
    'Address',
    'Page title',
    'Open Graph',
    'Structured data',
    'Media Session',
    'Page data',
    'Signals',
  ]) {
    await expect(options.getByText(part, { exact: true }).first()).toBeVisible();
  }
  await expect(
    options.getByText(
      'Nothing is sent. The file is saved only when you press Save sample. If you attach it to a GitHub issue, anyone can read it.',
    ),
  ).toBeVisible();
});

test('the toolbar says whether the tab is tracked: ready on load, recording while it plays, dimmed after leaving', async ({
  context,
  sw,
}) => {
  const worker = await sw();
  const titleOfActiveTab = () =>
    worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return chrome.action.getTitle({ tabId: tab?.id ?? -1 });
    });

  const page = await context.newPage();
  await page.goto(NETFLIX.episode());
  // A tracked page with nothing playing is ready, from its address on load.
  await expect.poll(titleOfActiveTab, { timeout: 15_000 }).toBe('MediaTracker — nothing playing');

  await page.evaluate(() => window.e2e.watch());
  await page.evaluate(() => {
    window.e2e.rate(1);
  });
  await expect.poll(titleOfActiveTab, { timeout: 30_000 }).toBe('Tracking: Breaking Bad · S1 E2');

  // Leaving for a page the extension does not run on: Chrome's default again.
  await page.goto('about:blank');
  await expect
    .poll(titleOfActiveTab, { timeout: 15_000 })
    .toBe("MediaTracker isn't tracking this page");
});
