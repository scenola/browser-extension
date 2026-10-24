/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Plays that one answer in the app settles are one row in *Waiting for you*. The fixture is
// the Netflix episodes of netflix.spec.ts, three of one show sharing a question key.

import { expect, playsArrive, test } from './fixtures.ts';
import { NETFLIX } from './site.ts';

test.describe('three plays of one show waiting on one question', () => {
  test.use({
    script: {
      progression: () => [
        { afterMs: 0, state: 'needs_confirmation', reason: 'text_only', questionKey: 'q1:shared' },
      ],
    },
  });

  test('the popup shows one row with the episodes as a range, the count and a link to its question', async ({
    api,
    context,
    popup,
  }) => {
    const page = await context.newPage();
    await page.goto(NETFLIX.episode());
    await page.evaluate(() => window.e2e.watch());
    await page.evaluate(() => window.e2e.ended());
    await playsArrive(api, 1);
    for (const [i, videoId] of [70196254, 70196255].entries()) {
      await page.evaluate((id) => window.e2e.nextEpisode(id), videoId);
      await page.evaluate(() => window.e2e.ended());
      await playsArrive(api, i + 2);
    }

    const view = await popup(page);
    // The key arrives with the first receipt read, a few seconds after the plays.
    const text = await view.waitForText('Breaking Bad · S1 E2–E4', 45_000);
    expect(text).toContain('3 viewings');
    const hrefs = await view.evaluate(
      '[...document.querySelectorAll("section[aria-labelledby=waiting-heading] a")].map((a) => a.getAttribute("href"))',
    );
    expect(hrefs).toEqual([`${api.mock.url}/today?question=q1%3Ashared`]);
  });
});
