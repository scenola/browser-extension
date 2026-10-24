/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// @vitest-environment happy-dom

// The settings page reads the settings again on every push. Over the worker's real router and
// root, that read must not itself be a change: if it were, each push would ask for the next read,
// and the worker would run its permissions and the toolbar over again for as long as the page is
// open.

import { cleanup, render } from '@testing-library/preact';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Browser } from 'wxt/browser';

import { startRouter } from '../messaging/router';
import { useSettings } from './data';
import { connectUi } from './store';
import { rootUi } from './test-harness';

const T0 = Date.UTC(2026, 9, 22, 19, 40);
const EXTENSION_ID = 'test-extension-id';
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;

type Listener = (message: unknown) => void;

/** One end of a port: what it posts reaches the other end's listeners, a structured clone later. */
function portEnd(name: string, sender: Browser.runtime.MessageSender | undefined) {
  const listeners = new Set<Listener>();
  let peer = new Set<Listener>();
  const port = {
    name,
    sender,
    postMessage: (message: unknown) => {
      const copy: unknown = structuredClone(message);
      queueMicrotask(() => {
        for (const listener of peer) listener(copy);
      });
    },
    disconnect: () => undefined,
    onMessage: { addListener: (listener: Listener) => listeners.add(listener) },
    onDisconnect: { addListener: () => undefined },
  };
  return {
    port: port as unknown as Browser.runtime.Port,
    listeners,
    link: (other: Set<Listener>) => {
      peer = other;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('the settings page reads the settings again only when something changed', async () => {
  const { root, deps } = await rootUi({ now: T0 });
  let accept: ((port: Browser.runtime.Port) => void) | undefined;
  const runtime = {
    id: EXTENSION_ID,
    onMessage: { addListener: () => undefined },
    onConnect: {
      addListener: (listener: (port: Browser.runtime.Port) => void) => {
        accept = listener;
      },
    },
    // The settings page, in a tab of its own.
    connect: ({ name }: { readonly name: string }) => {
      const page = portEnd(name, undefined);
      const tab = {} as Browser.tabs.Tab;
      const worker = portEnd(name, { id: EXTENSION_ID, url: `${ORIGIN}/options.html`, tab });
      page.link(worker.listeners);
      worker.link(page.listeners);
      accept?.(worker.port);
      return page.port;
    },
  };
  startRouter(root, runtime as never, ORIGIN);
  const reconciles = vi.spyOn(deps.permissions, 'reconcile');
  const ui = connectUi(runtime as never);
  const reads = vi.spyOn(ui, 'send');

  function Reader() {
    useSettings(ui);
    return null;
  }
  render(<Reader />);
  await vi.advanceTimersByTimeAsync(1_000);
  const settled = { reads: reads.mock.calls.length, reconciles: reconciles.mock.calls.length };
  expect(settled.reads).toBeGreaterThan(0);

  await vi.advanceTimersByTimeAsync(10_000);
  expect({ reads: reads.mock.calls.length, reconciles: reconciles.mock.calls.length }).toEqual(
    settled,
  );
});
