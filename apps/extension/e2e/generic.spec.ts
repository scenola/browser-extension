/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Sites without a module: the generic readers. The e2e build holds every site's access, so a
// site's own words decide.

import { evidence, expect, nothingArrives, playsArrive, test } from './fixtures.ts';
import { EPISODE_SECONDS, GENERIC } from './site.ts';

test('a page that says, in JSON-LD, that it is a Movie: reported', async ({ api, context }) => {
  const page = await context.newPage();
  await page.goto(GENERIC.film);
  await page.evaluate(() => window.e2e.watch());
  await page.evaluate(() => window.e2e.ended());

  await playsArrive(api, 1);
  const play = evidence(api, 0);
  expect(play.kind).toBe('movie');
  expect(play.title).toBe('Arrival');
  // An IMDb id only when the page states it — here its JSON-LD `sameAs`.
  expect(play.ids?.imdb).toBe('tt2543164');
  // A site without a module has no service id of its own (the `provider.<service id>` ids are
  // for sites with a module).
  expect(play.ids?.provider ?? []).toEqual([]);
  expect(play.duration_seconds).toBe(EPISODE_SECONDS);
  // No URL, no hostname, no page title leaves.
  expect(JSON.stringify(play)).not.toContain('fixture.example');
  expect(JSON.stringify(play)).not.toContain('Fixture Films');
});

// Such a page still gets no play and no badge; only the popup says why.
test('a page whose og:type is video.other: no play', async ({ api, context }) => {
  const page = await context.newPage();
  await page.goto(GENERIC.clip);
  await page.evaluate(() => window.e2e.watch());
  await page.evaluate(() => window.e2e.ended());

  await nothingArrives(api, 8_000);
});
