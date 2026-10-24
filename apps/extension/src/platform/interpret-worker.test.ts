/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment happy-dom

// The modules' worker: one request, one module's `interpret`, one answer — a reading as plain
// JSON, or why there is none. The real worker file, its global scope happy-dom's window; the
// registry is a stand-in whose modules each misbehave in one way.

import { beforeAll, describe, expect, test, vi } from 'vitest';

vi.mock('@mt/services', () => ({
  modulesForBuild: () => [
    { id: 'reads', interpret: (snapshot: { title?: unknown }) => ({ title: snapshot.title }) },
    {
      id: 'throws',
      interpret: () => {
        throw new Error('no');
      },
    },
    {
      id: 'slow',
      interpret: () => {
        const until = performance.now() + 60;
        while (performance.now() < until) {
          // Past the 50 ms budget.
        }
        return {};
      },
    },
    {
      id: 'cyclic',
      interpret: () => {
        const reading: Record<string, unknown> = {};
        reading.self = reading;
        return reading;
      },
    },
    { id: 'huge', interpret: () => ({ title: 'x'.repeat(64 * 1024) }) },
  ],
}));

const answered = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);

beforeAll(async () => {
  await import('../entrypoints/sandbox/interpret-worker');
});

function ask(serviceId: unknown, snapshot: unknown = { title: 'Dune' }): unknown {
  answered.mockClear();
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { v: 1, type: 'interpret/request', id: 4, serviceId, snapshot },
    }),
  );
  return answered.mock.calls[0]?.[0];
}

const failed = (reason: string) => ({ v: 1, type: 'interpret/answer', id: 4, ok: false, reason });

describe('the modules’ worker', () => {
  test('answers the module’s reading, as JSON writes it', () => {
    expect(ask('reads')).toEqual({
      v: 1,
      type: 'interpret/answer',
      id: 4,
      ok: true,
      reading: { title: 'Dune' },
    });
  });

  test.each([
    ['a service it has no module for', 'nobody', 'unknown_service'],
    ['a module that throws', 'throws', 'threw'],
    ['a module slower than 50 ms', 'slow', 'slow'],
    ['a reading JSON cannot write', 'cyclic', 'unserializable'],
    ['a reading over 64 KB written', 'huge', 'too_large'],
  ])('says why there is no reading: %s', (_what, serviceId, reason) => {
    expect(ask(serviceId)).toEqual(failed(reason));
  });

  test('a request without a service or a snapshot is a bad one', () => {
    expect(ask(7)).toEqual(failed('bad_request'));
    expect(ask('reads', null)).toEqual(failed('bad_request'));
  });

  test('answers nothing that is not a request', () => {
    answered.mockClear();
    window.dispatchEvent(new MessageEvent('message', { data: { v: 1, type: 'interpret/ready' } }));
    window.dispatchEvent(new MessageEvent('message', { data: 'noise' }));
    expect(answered).not.toHaveBeenCalled();
  });
});
