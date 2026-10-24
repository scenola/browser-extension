/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment happy-dom

// The interpreter, with fake offscreen/sandbox channels: a module that throws, answers the wrong
// shape or loops past 50 ms gives null, and the offscreen document is closed after 120 s idle.
// The worker side is the real `OffscreenInterpreter`; the sandbox side is the real modules'
// worker (the sandbox page only carries messages to it: sandbox-page.test.ts), loaded here with
// a registry of test modules; the channel between them — the offscreen document's leg — is the
// fake. A module that throws, exceeds 50 ms or
// returns junk is set aside for that snapshot and the failure is counted locally; the
// offscreen document is closed after 2 minutes without a snapshot; `interpret` takes at most
// 50 ms or is cut off.

import type { ServiceReading, Snapshot } from '@mt/core';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Mock } from 'vitest';

import { OffscreenInterpreter } from './interpreter';

const READING: ServiceReading = {
  kind: { value: 'movie', confidence: 0.95, source: 'module' },
  title: { value: 'Arrival', confidence: 0.95, source: 'module' },
};

vi.mock('@mt/services', () => {
  const reading = {
    kind: { value: 'movie', confidence: 0.95, source: 'module' },
    title: { value: 'Arrival', confidence: 0.95, source: 'module' },
  };
  const define = (id: string, interpret: () => unknown) => ({ id, interpret });
  return {
    modulesForBuild: () => [
      define('good', () => reading),
      define('throws', () => {
        throw new Error('module bug');
      }),
      define('junk', () => ({ kind: { value: 'series' } })),
      define('slow', () => {
        const start = performance.now();
        while (performance.now() - start < 120) {
          // a module looping past its 50 ms
        }
        return reading;
      }),
    ],
  };
});

const SNAPSHOT: Snapshot = {
  url: { hostname: 'www.netflix.com', pathname: '/watch/70196253', query: {}, hash: '' },
  lang: 'en',
  documentTitle: 'Netflix',
  selectors: {},
  jsonLd: [],
  mediaSession: null,
  openGraph: {},
  pageState: {},
  signals: { endOfContent: false, adPlaying: false },
};

/** What the modules' worker answered (its global scope is this window, in a test). */
const posted: unknown[] = [];

beforeAll(async () => {
  vi.spyOn(window, 'postMessage').mockImplementation((message: unknown) => {
    posted.push(message);
  });
  await import('../entrypoints/sandbox/interpret-worker');
});

interface Request {
  readonly id: number;
  readonly serviceId: string;
  readonly snapshot: unknown;
}

interface Channel {
  readonly offscreen: {
    createDocument: Mock<(options: unknown) => Promise<void>>;
    closeDocument: Mock<() => Promise<void>>;
  };
  readonly runtime: {
    sendMessage: Mock<(request: Request) => Promise<unknown>>;
    getContexts: Mock<() => Promise<unknown[]>>;
  };
  readonly failures: [string, string][];
  interpreter: OffscreenInterpreter;
}

/** The offscreen leg, faked: a request goes to the modules' worker as the sandbox page passes it on. */
function channel(options: { readonly answer?: 'sandbox' | 'never' } = {}): Channel {
  let open = false;
  const offscreen = {
    createDocument: vi.fn((options: unknown): Promise<void> => {
      open = options !== undefined;
      return Promise.resolve();
    }),
    closeDocument: vi.fn((): Promise<void> => {
      open = false;
      return Promise.resolve();
    }),
  };
  const runtime = {
    getContexts: vi.fn((): Promise<unknown[]> =>
      Promise.resolve(open ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []),
    ),
    sendMessage: vi.fn((request: Request): Promise<unknown> => {
      if (options.answer === 'never') return new Promise(() => undefined);
      const before = posted.length;
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            v: 1,
            type: 'interpret/request',
            id: request.id + 1000,
            serviceId: request.serviceId,
            snapshot: request.snapshot,
          },
          source: window,
        }),
      );
      const answer = posted
        .slice(before)
        .find((m) => (m as { type?: unknown }).type === 'interpret/answer') as
        Record<string, unknown> | undefined;
      return Promise.resolve(answer === undefined ? undefined : { ...answer, id: request.id });
    }),
  };
  const failures: [string, string][] = [];
  const c: Channel = {
    offscreen,
    runtime,
    failures,
    interpreter: undefined as unknown as OffscreenInterpreter,
  };
  c.interpreter = new OffscreenInterpreter({
    offscreen,
    runtime: runtime as unknown as ConstructorParameters<typeof OffscreenInterpreter>[0]['runtime'],
    offscreenUrl: 'chrome-extension://test-extension-id/offscreen.html',
    onFailure: (serviceId, reason) => failures.push([serviceId, reason]),
  });
  return c;
}

beforeEach(() => {
  posted.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OffscreenInterpreter through the sandbox page', () => {
  // the control: a module that answers well is heard (else every "→ null" below is vacuous)
  test('a module’s valid reading comes back', async () => {
    const c = channel();
    const reading = await c.interpreter.interpret('good', SNAPSHOT);
    expect(reading?.kind?.value).toBe('movie');
    expect(reading?.title?.value).toBe('Arrival');
    expect(c.failures).toEqual([]);
  });

  // A module that throws gives null; the failure is counted locally.
  test('a module that throws gives null, and the failure is counted', async () => {
    const c = channel();
    expect(await c.interpreter.interpret('throws', SNAPSHOT)).toBeNull();
    expect(c.failures.map(([id]) => id)).toEqual(['throws']);
  });

  // A module answering { kind: { value: "series" } } is rejected by validation (the worker
  // validates) and gives null.
  test('a reading of the wrong shape gives null', async () => {
    const c = channel();
    expect(await c.interpreter.interpret('junk', SNAPSHOT)).toBeNull();
    expect(c.failures.map(([id]) => id)).toEqual(['junk']);
  });

  // A module looping past 50 ms gives null.
  test('a module that takes longer than 50 ms gives null', async () => {
    const c = channel();
    expect(await c.interpreter.interpret('slow', SNAPSHOT)).toBeNull();
    expect(c.failures.map(([id]) => id)).toEqual(['slow']);
  });

  // A module this build does not ship reads nothing.
  test('an unknown service gives null', async () => {
    const c = channel();
    expect(await c.interpreter.interpret('nobody', SNAPSHOT)).toBeNull();
  });

  // The offscreen document is created on the first snapshot — one of it.
  test('two snapshots at once open one document', async () => {
    const c = channel();
    await Promise.all([
      c.interpreter.interpret('good', SNAPSHOT),
      c.interpreter.interpret('good', SNAPSHOT),
    ]);
    expect(c.offscreen.createDocument).toHaveBeenCalledTimes(1);
    expect(c.offscreen.createDocument.mock.calls[0]?.[0]).toMatchObject({
      reasons: ['IFRAME_SCRIPTING'],
    });
  });

  // The document is closed at once when an answer is overdue: a module that never returns holds
  // the sandbox's thread.
  test('a module that never answers gives null and its document is closed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const c = channel({ answer: 'never' });
    const pending = c.interpreter.interpret('good', SNAPSHOT);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBeNull();
    expect(c.offscreen.closeDocument).toHaveBeenCalled();
  });

  // Another tab's snapshot sent while a module hangs waits behind it on the sandbox's one thread.
  // Closing the hung document ends that wait unanswered (as Chrome ends a message whose listener's
  // document went); the request is then asked again of a fresh document, not lost.
  test('a request held behind a hung module is answered by a fresh document', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const c = channel();
    const send = c.runtime.sendMessage.getMockImplementation();
    const close = c.offscreen.closeDocument.getMockImplementation();
    if (send === undefined || close === undefined) throw new Error('the channel has no fakes');
    let hung = false;
    const held: ((error: Error) => void)[] = [];
    c.runtime.sendMessage.mockImplementation((request: Request) => {
      if (request.serviceId === 'hangs') hung = true;
      if (!hung) return send(request);
      return new Promise((_resolve, reject) => held.push(reject));
    });
    c.offscreen.closeDocument.mockImplementation(async () => {
      await close();
      hung = false;
      for (const reject of held.splice(0)) {
        reject(new Error('The message port closed before a response was received.'));
      }
    });

    const hanging = c.interpreter.interpret('hangs', SNAPSHOT);
    await vi.advanceTimersByTimeAsync(500);
    const other = c.interpreter.interpret('good', SNAPSHOT);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await hanging).toBeNull();
    expect((await other)?.title?.value).toBe('Arrival');
    expect(c.failures).toEqual([['hangs', 'timeout']]);
    expect(c.offscreen.closeDocument).toHaveBeenCalledTimes(1);
    expect(c.offscreen.createDocument).toHaveBeenCalledTimes(2);
  });

  // Idle for 120 s, the document is closed.
  test('120 s without a snapshot closes the document, and not before', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const c = channel();
    expect(await c.interpreter.interpret('good', SNAPSHOT)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(119_000);
    expect(c.offscreen.closeDocument).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(c.offscreen.closeDocument).toHaveBeenCalledTimes(1);
  });

  // Closed after 2 minutes without a snapshot — a snapshot in between restarts the wait.
  test('a snapshot within the 120 s keeps the document open', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const c = channel();
    await c.interpreter.interpret('good', SNAPSHOT);
    await vi.advanceTimersByTimeAsync(100_000);
    await c.interpreter.interpret('good', SNAPSHOT);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(c.offscreen.closeDocument).not.toHaveBeenCalled();
  });
});

describe('the worker refuses an answer to another request (the worker validates)', () => {
  test('an answer naming another request id gives null', async () => {
    const c = channel();
    c.runtime.sendMessage.mockImplementation((request: Request) =>
      Promise.resolve({
        v: 1,
        type: 'interpret/answer',
        id: request.id + 7,
        ok: true,
        reading: READING,
      }),
    );
    expect(await c.interpreter.interpret('good', SNAPSHOT)).toBeNull();
  });
});
