/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment happy-dom

// The offscreen document's leg of the interpretation channel: the offscreen page
// forwards to the sandboxed iframe with postMessage(…, "*") and accepts answers only from that
// iframe's own contentWindow. The real page, loaded in happy-dom; the worker's side is the fake browser's
// `runtime.onMessage`.

import { beforeAll, describe, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (answer: unknown) => void,
) => unknown;

let listener: Listener;
let sandbox: Window;
const forwarded: { id: number; serviceId: unknown }[] = [];

beforeAll(async () => {
  // happy-dom loads no iframe page under Vitest, so the iframe's window is a stand-in: the one
  // object the page must take answers from.
  sandbox = {
    postMessage: (message: unknown) => {
      const m = message as { type?: unknown; id?: unknown; serviceId?: unknown };
      if (m.type === 'interpret/request' && typeof m.id === 'number') {
        forwarded.push({ id: m.id, serviceId: m.serviceId });
      }
    },
  } as unknown as Window;
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    get: () => sandbox,
  });
  const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
  await import('../entrypoints/offscreen/main');
  const registered = add.mock.calls[0]?.[0];
  if (registered === undefined) throw new Error('the offscreen page listens to nothing');
  listener = registered as unknown as Listener;
  expect(document.querySelector('iframe')?.src).toMatch(/\/sandbox\.html$/u);
  // Scripts only: no same origin, no forms, no popups, no navigating the page above it.
  expect(document.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts');
  // The sandbox says it is ready, from its own window.
  window.dispatchEvent(
    new MessageEvent('message', { data: { v: 1, type: 'interpret/ready' }, source: sandbox }),
  );
});

const WORKER = () => ({
  id: fakeBrowser.runtime.id,
  url: new URL('/background.js', location.href).href,
});

function ask(id: number, sender = WORKER()): ReturnType<typeof vi.fn> {
  const sendResponse = vi.fn();
  listener(
    {
      v: 1,
      target: 'mt-interpreter',
      type: 'interpret/request',
      id,
      serviceId: 'netflix',
      snapshot: {},
    },
    sender,
    sendResponse,
  );
  return sendResponse;
}

describe('the offscreen document', () => {
  // The worker's request is forwarded to the sandboxed iframe.
  test('forwards a request from the worker to the sandbox', () => {
    const before = forwarded.length;
    ask(1);
    expect(forwarded.length).toBe(before + 1);
    expect(forwarded.at(-1)?.serviceId).toBe('netflix');
  });

  // Answers are accepted only from that iframe's contentWindow.
  test('an answer posted by another window is ignored; the iframe’s own is passed on', () => {
    const sendResponse = ask(7);
    const local = forwarded.at(-1)?.id;
    if (local === undefined) throw new Error('nothing was forwarded');
    const forged = {
      v: 1,
      type: 'interpret/answer',
      id: local,
      ok: true,
      reading: { title: 'forged' },
    };
    window.dispatchEvent(new MessageEvent('message', { data: forged, source: window }));
    window.dispatchEvent(new MessageEvent('message', { data: forged, source: null }));
    expect(sendResponse).not.toHaveBeenCalled();

    const real = { v: 1, type: 'interpret/answer', id: local, ok: false, reason: 'threw' };
    window.dispatchEvent(new MessageEvent('message', { data: real, source: sandbox }));
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse.mock.calls[0]?.[0]).toMatchObject({ id: 7, ok: false, reason: 'threw' });
  });

  // A module's code holds against a malicious page: a request from a tab — a content script —
  // is not the worker's, and is not forwarded.
  test('a request from a content script is not forwarded', () => {
    const before = forwarded.length;
    ask(9, { ...WORKER(), tab: { id: 1 } } as never);
    ask(10, { id: 'another-extension', url: WORKER().url });
    expect(forwarded.length).toBe(before);
  });
});
