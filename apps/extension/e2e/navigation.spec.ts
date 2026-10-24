/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A case seen on a real Netflix tab (2026-10-22): Netflix moves between its pages without
// loading a document (`history.pushState`), and Chrome's `MessageSender.url` stays at the
// document's first address. Browse → watch, and watch A → watch B, in one document.

import { evidence, expect, playsArrive, test } from './fixtures.ts';
import { NETFLIX } from './site.ts';

const { filmA, filmB } = NETFLIX;

test('browse, then watch: the player route reached by pushState opens a viewing of its id', async ({
  api,
  context,
  popup,
}) => {
  const page = await context.newPage();
  await page.goto(NETFLIX.browse);
  // The billboard plays with sound on /browse — not a player route, so it starts nothing.
  await page.evaluate(() => window.e2e.play(0, 1));
  await page.evaluate((s) => window.e2e.at(s), 5);
  await page.click('#play');
  expect(new URL(page.url()).pathname).toBe(`/watch/${String(filmA.videoId)}`);

  // A viewing binds on its second observation (~15 s): watch() plays 21 s at 1× first.
  await page.evaluate(() => window.e2e.watch());
  await page.evaluate(() => {
    window.e2e.rate(1);
  });
  const view = await popup(page);
  const text = await view.waitForText('Added at 70 %');
  expect(text).toContain(filmA.title);
  view.close();

  await page.evaluate(() => {
    window.e2e.rate(16);
  });
  await page.evaluate(() => window.e2e.ended());
  await playsArrive(api, 1);
  const play = evidence(api, 0);
  expect(play.kind).toBe('movie');
  expect(play.title).toBe(filmA.title);
  expect(play.ids?.provider).toEqual([
    expect.objectContaining({ namespace: 'provider.netflix', value: String(filmA.videoId) }),
  ]);
  expect(play.duration_seconds).toBe(filmA.seconds);
  // Exactly one: the billboard added nothing.
  expect(api.plays()).toHaveLength(1);
});

test('watch A, then watch B in the same document: two plays, two keys, nothing of B in A', async ({
  api,
  context,
}) => {
  const page = await context.newPage();
  await page.goto(NETFLIX.browse);
  await page.click('#play');
  await page.evaluate(() => window.e2e.watch());
  await page.evaluate(() => window.e2e.ended());
  await playsArrive(api, 1);

  // B on the same element, by pushState.
  await page.evaluate((id) => window.e2e.nextTitle(id), filmB.videoId);
  expect(new URL(page.url()).pathname).toBe(`/watch/${String(filmB.videoId)}`);
  await page.evaluate(() => window.e2e.ended());
  await playsArrive(api, 2);

  const [a, b] = [evidence(api, 0), evidence(api, 1)];
  expect(a.title).toBe(filmA.title);
  expect(b.title).toBe(filmB.title);
  expect(a.ids?.provider).toEqual([
    expect.objectContaining({ namespace: 'provider.netflix', value: String(filmA.videoId) }),
  ]);
  expect(b.ids?.provider).toEqual([
    expect.objectContaining({ namespace: 'provider.netflix', value: String(filmB.videoId) }),
  ]);
  expect(new Set(api.plays().map((p) => p.idempotencyKey)).size).toBe(2);
  // A's length and position are A's own (300 s), never B's (600 s).
  expect(a.duration_seconds).toBe(filmA.seconds);
  expect(a.furthest_position_seconds).toBeLessThanOrEqual(filmA.seconds);
  expect(b.duration_seconds).toBe(filmB.seconds);
});
