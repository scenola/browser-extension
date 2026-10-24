/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The block list: YouTube is hard-blocked — the collector is never injected there, whatever
// the person allowed — even though the e2e build holds every site's access and the page says it
// is a film.

import { expect, nothingArrives, test } from './fixtures.ts';
import { NETFLIX, YOUTUBE } from './site.ts';

test('a blocked host: no collector, nothing sent, and the popup says so', async ({
  api,
  context,
  injected,
  popup,
}) => {
  const page = await context.newPage();
  await page.goto(YOUTUBE);
  await page.evaluate(() => window.e2e.watch());

  expect(await injected(page)).toEqual({ collector: false, bootstrap: false });
  const view = await popup(page);
  await view.waitForText("MediaTracker doesn't track this site");
  view.close();

  await page.evaluate(() => window.e2e.ended());
  await nothingArrives(api, 5_000);
  expect(await injected(page)).toEqual({ collector: false, bootstrap: false });
});

test('the control: the same check finds the collector on a tracked site', async ({
  context,
  injected,
}) => {
  const page = await context.newPage();
  await page.goto(NETFLIX.episode());
  await page.evaluate(() => window.e2e.play(0, 1));
  await expect
    .poll(() => injected(page), { timeout: 15_000 })
    .toEqual({ collector: true, bootstrap: true });
});
