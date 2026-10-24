/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment happy-dom

// The sandbox page runs no module: it takes WebRTC away, starts the modules' worker, and carries
// its parent's requests to that worker and the worker's answers back — to its parent alone. The
// real page, loaded in happy-dom with the globals a browser defines; the worker is a stand-in
// that records what it is sent. In happy-dom the page is its own parent.

import { beforeAll, describe, expect, test, vi } from 'vitest';

const fake = vi.hoisted(() => {
  // What Chrome defines on a page's global object; happy-dom defines none of them.
  const global = globalThis as Record<string, unknown>;
  const standIn = (): undefined => undefined;
  global.RTCPeerConnection = standIn;
  global.webkitRTCPeerConnection = standIn;
  global.RTCDataChannel = standIn;
  const sent: unknown[] = [];
  const started: StandInWorker[] = [];
  const registry = { loaded: false };
  class StandInWorker extends EventTarget {
    readonly received: unknown[] = [];
    terminated = false;
    constructor() {
      super();
      started.push(this);
    }
    postMessage(message: unknown): void {
      sent.push(message);
      this.received.push(message);
    }
    terminate(): void {
      this.terminated = true;
    }
  }
  global.Worker = StandInWorker;
  return { sent, started, registry, Worker: StandInWorker };
});

// Loaded only if the page imports the modules itself rather than starting them as a worker.
vi.mock('@mt/services', () => {
  fake.registry.loaded = true;
  return { modulesForBuild: () => [] };
});

const toParent = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
/** What the page posted while it loaded; each test starts with the spy's calls cleared. */
let onLoad: unknown[][] = [];

beforeAll(async () => {
  await import('../entrypoints/sandbox/main');
  onLoad = [...toParent.mock.calls];
});

const REQUEST = {
  v: 1,
  type: 'interpret/request',
  id: 3,
  serviceId: 'netflix',
  snapshot: { a: 1 },
};

/** Where every message to the parent is addressed: the page's own address's origin, the extension's. */
const PARENT = location.origin;

function fromParent(data: unknown, source: MessageEventSource | null = window): void {
  window.dispatchEvent(new MessageEvent('message', { data, source }));
}

function fromWorker(data: unknown): void {
  fake.started[0]?.dispatchEvent(new MessageEvent('message', { data }));
}

describe('the sandbox page', () => {
  test('takes WebRTC away, loads no module, starts one worker and says it is ready', () => {
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) {
      expect(Object.hasOwn(globalThis, name)).toBe(false);
    }
    expect(fake.registry.loaded).toBe(false);
    expect(fake.started).toHaveLength(1);
    expect(onLoad).toEqual([[{ v: 1, type: 'interpret/ready' }, PARENT]]);
  });

  test('passes its parent’s request to the worker, its envelope and nothing else', () => {
    fromParent({ ...REQUEST, extra: 'not carried' });
    expect(fake.sent.at(-1)).toEqual(REQUEST);
  });

  test('takes a request from its parent only, and only one that is a request', () => {
    const before = fake.sent.length;
    fromParent(REQUEST, null);
    fromParent({ ...REQUEST, type: 'interpret/answer' });
    fromParent({ ...REQUEST, v: 2 });
    fromParent({ ...REQUEST, id: '3' });
    expect(fake.sent).toHaveLength(before);
  });

  test('passes the worker’s answer to its parent, and nothing else the worker says', () => {
    const answer = { v: 1, type: 'interpret/answer', id: 3, ok: true, reading: { title: 'x' } };
    toParent.mockClear();
    fromWorker({ v: 1, type: 'interpret/request', id: 3 });
    fromWorker('noise');
    expect(toParent).not.toHaveBeenCalled();
    fromWorker(answer);
    expect(toParent).toHaveBeenCalledWith(answer, PARENT);
  });
});

describe('a sandbox page whose worker cannot start', () => {
  test('answers each request `unavailable`', async () => {
    vi.resetModules();
    (globalThis as Record<string, unknown>).Worker = function blocked() {
      throw new Error('blocked');
    };
    await import('../entrypoints/sandbox/main');
    toParent.mockClear();
    fromParent({ ...REQUEST, id: 8 });
    expect(toParent).toHaveBeenCalledWith(unavailable(8), PARENT);
  });
});

describe('a sandbox page whose worker fails to load', () => {
  // A module that throws as the registry evaluates fails the worker's script after it started:
  // the worker says so with an `error`, and answers nothing it was sent.
  test('answers what the worker held `unavailable` at once, then each request', async () => {
    vi.resetModules();
    (globalThis as Record<string, unknown>).Worker = fake.Worker;
    await import('../entrypoints/sandbox/main');
    const worker = fake.started.at(-1);
    fromParent({ ...REQUEST, id: 4 });
    fromParent({ ...REQUEST, id: 5 });
    worker?.dispatchEvent(new MessageEvent('message', { data: answered(4) }));
    toParent.mockClear();

    worker?.dispatchEvent(new Event('error'));
    expect(toParent.mock.calls).toEqual([[unavailable(5), PARENT]]);
    expect(worker?.terminated).toBe(true);

    // The pages these tests loaded before still listen too: only this page's worker is checked.
    toParent.mockClear();
    fromParent({ ...REQUEST, id: 6 });
    expect(toParent).toHaveBeenCalledWith(unavailable(6), PARENT);
    expect(worker?.received.map((message) => (message as { id: number }).id)).toEqual([4, 5]);
  });
});

function unavailable(id: number) {
  return { v: 1, type: 'interpret/answer', id, ok: false, reason: 'unavailable' };
}

function answered(id: number) {
  return { v: 1, type: 'interpret/answer', id, ok: true, reading: null };
}
