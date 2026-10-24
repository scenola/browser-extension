/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, test } from 'vitest';

import { ViewingLock } from './viewing-lock';
import type { LockHeld } from './viewing-lock';

const tick = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

test('tasks run one at a time, in the order they asked, none collapsed', async () => {
  const lock = new ViewingLock();
  const log: string[] = [];
  const task = (name: string) => async () => {
    log.push(`${name}:start`);
    await tick(3);
    log.push(`${name}:end`);
    return name;
  };
  const results = await Promise.all([
    lock.run(task('a')),
    lock.run(task('b')),
    lock.run(task('c')),
  ]);
  expect(results).toEqual(['a', 'b', 'c']);
  expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
});

test('a task that fails releases the lock and fails only its caller', async () => {
  const lock = new ViewingLock();
  const failed = lock.run(() => Promise.reject(new Error('boom')));
  const after = lock.run(() => Promise.resolve('ran'));
  await expect(failed).rejects.toThrow('boom');
  await expect(after).resolves.toBe('ran');
});

test('the proof is good only while its own task runs', async () => {
  const lock = new ViewingLock();
  const leaked: LockHeld[] = [];
  await lock.run((held) => {
    leaked.push(held);
    expect(lock.holds(held)).toBe(true);
    return Promise.resolve();
  });
  const [old] = leaked;
  if (old === undefined) throw new Error('the task did not run');
  expect(lock.holds(old)).toBe(false);
  await lock.run((held) => {
    expect(lock.holds(old)).toBe(false);
    expect(lock.holds(held)).toBe(true);
    return Promise.resolve();
  });
});
