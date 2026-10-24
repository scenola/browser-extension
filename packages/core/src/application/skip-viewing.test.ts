/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from 'vitest';

import { episodeReading, makeWorld, must, watch } from './test-world';

test('an open viewing is skipped and never reported, however it ends', async () => {
  const w = makeWorld();
  const [, bound] = await watch(w, episodeReading(1), 0, 15);
  const id = must(bound?.viewing).id;
  await w.skip.execute(id);
  expect((await w.viewings.byId(id))?.state).toBe('skipped');
  const rest = await watch(w, episodeReading(1), 30, 990);
  expect(rest.some((r) => r.reported)).toBe(false);
  expect(w.outbox.entries()).toEqual([]);
});

test('a reported viewing is not reopened by a late skip, and an unknown id is nothing', async () => {
  const w = makeWorld();
  const results = await watch(w, episodeReading(1), 0, 900);
  const reported = must(results.at(-1)?.viewing);
  expect(reported.state).toBe('reported');
  await w.skip.execute(reported.id);
  await w.skip.execute('no-such-viewing');
  expect(await w.viewings.byId(reported.id)).toEqual(reported);
  expect(w.viewings.all()).toHaveLength(1);
});
