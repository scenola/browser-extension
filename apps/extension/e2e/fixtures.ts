/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The end-to-end harness: for every test, a fresh mock API behind a recording proxy, a fresh
// Chromium profile with the e2e build loaded, the fixture sites routed, and the extension
// connected through `TestAuth` from its own settings page.
//
// - The mock runs on a free port with its public URL set to the build's (E2E_BASE_URL); the
//   proxy listens on that URL's port and forwards every request, recording each one's method,
//   path, `Idempotency-Key` and status — what the mock's own `plays` (stored plays only) cannot
//   show: a retry, and the key it carried.
// - Chromium autoplays with sound (`--autoplay-policy=no-user-gesture-required`): a muted
//   element never starts a viewing, so a fixture plays the way a person's click would make it
//   play.
// - Playwright does not surface an action popup as a page, so `popup()` opens the real one
//   (`action.openPopup()`, from the worker) and reads it over the DevTools protocol.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WirePlay } from '@mt/api';
import { test as base, chromium, expect } from '@playwright/test';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import type { Browser } from 'wxt/browser';

import { startMockApi } from '../../../tools/mock-api/server.ts';
import type { MockApi, MockScript, RecordedPlay } from '../../../tools/mock-api/server.ts';
import { E2E_BASE_URL, E2E_EXTENSION_DIR, E2E_PORT } from './config.ts';
import { routeSites } from './site.ts';

/** The extension APIs, as the functions evaluated in its service worker see them. */
declare const chrome: Pick<typeof Browser, 'action' | 'tabs' | 'scripting'>;

export interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly idempotencyKey: string | null;
  readonly status: number;
}

export interface Api {
  readonly mock: MockApi;
  /** Every request the extension made of the API, in order, with the answer's status. */
  readonly seen: SeenRequest[];
  /** The `POST /v1/integrations/plays` requests. */
  playAttempts(): SeenRequest[];
  /** The stored plays. */
  plays(): readonly RecordedPlay[];
}

export interface PopupView {
  text(): Promise<string>;
  evaluate(expression: string): Promise<unknown>;
  waitForText(needle: string | RegExp, timeoutMs?: number): Promise<string>;
  close(): void;
}

interface Fixtures {
  readonly script: MockScript;
  /** Switches Chromium is launched with beyond the harness's own (a spec's `test.use`). */
  readonly browserArgs: readonly string[];
  readonly api: Api;
  readonly context: BrowserContext;
  readonly extensionId: string;
  /** The extension's service worker as it runs now (a new one after `stopWorker`). */
  readonly sw: () => Promise<Worker>;
  /** Stops the extension's service worker, as Chrome does after 30 s idle. */
  readonly stopWorker: () => Promise<void>;
  /** Whether the worker running now started after the last `stopWorker`. */
  readonly workerIsFresh: () => Promise<boolean>;
  /** The toolbar popup, opened over `page`. */
  readonly popup: (page: Page) => Promise<PopupView>;
  /** Whether a collector (or the bootstrap) runs in the page's top frame, by its slots. */
  readonly injected: (page: Page) => Promise<{ collector: boolean; bootstrap: boolean }>;
}

function forward(target: number, seen: SeenRequest[]) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const key = req.headers['idempotency-key'];
    const proxied = httpRequest(
      { host: '127.0.0.1', port: target, path: req.url, method: req.method, headers: req.headers },
      (answer) => {
        seen.push({
          method: req.method ?? '',
          path: (req.url ?? '').split('?')[0] ?? '',
          idempotencyKey: typeof key === 'string' ? key : null,
          status: answer.statusCode ?? 0,
        });
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    proxied.on('error', () => {
      res.destroy();
    });
    req.pipe(proxied);
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      resolve();
    });
  });
}

/** The CDP endpoint of a browser started with `--remote-debugging-port=0`. */
async function devtoolsPort(profile: string): Promise<number> {
  for (let i = 0; i < 100; i += 1) {
    try {
      const text = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
      const port = Number(text.split('\n')[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // Not written yet.
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('no DevToolsActivePort');
}

interface Target {
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

/** A page target driven over its own DevTools WebSocket: evaluate and read, nothing else. */
async function attach(target: Target): Promise<PopupView> {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => {
      resolve();
    };
    ws.onerror = () => {
      reject(new Error('the popup target did not open'));
    };
  });
  let next = 1;
  const waiting = new Map<number, (value: unknown) => void>();
  ws.onmessage = (event: MessageEvent) => {
    const message = JSON.parse(String(event.data)) as { id?: number };
    if (message.id !== undefined) {
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  };
  const evaluate = (expression: string): Promise<unknown> =>
    new Promise((resolve) => {
      const id = next;
      next += 1;
      waiting.set(id, (message) => {
        const value = (message as { result?: { result?: { value?: unknown } } }).result?.result;
        resolve(value?.value);
      });
      ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
  const text = async (): Promise<string> => {
    const value = await evaluate('document.body ? document.body.innerText : ""');
    return typeof value === 'string' ? value.replace(/\s+/gu, ' ') : '';
  };
  return {
    text,
    evaluate,
    async waitForText(needle, timeoutMs = 15_000) {
      const end = Date.now() + timeoutMs;
      let last = '';
      while (Date.now() < end) {
        last = await text();
        if (typeof needle === 'string' ? last.includes(needle) : needle.test(last)) return last;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`the popup never said ${String(needle)}; it said: ${last}`);
    },
    close() {
      ws.close();
    },
  };
}

export const test = base.extend<Fixtures>({
  script: [{}, { option: true }],
  browserArgs: [[], { option: true }],

  api: async ({ script }, use) => {
    const target = await freePort();
    const mock = await startMockApi({ port: target, publicUrl: E2E_BASE_URL, script });
    const seen: SeenRequest[] = [];
    const proxy = createServer(forward(target, seen));
    await listen(proxy, E2E_PORT);
    await use({
      mock,
      seen,
      playAttempts: () =>
        seen.filter((r) => r.method === 'POST' && r.path === '/v1/integrations/plays'),
      plays: () => mock.plays,
    });
    await new Promise<void>((resolve) => {
      proxy.close(() => {
        resolve();
      });
      proxy.closeAllConnections();
    });
    await mock.close();
  },

  context: async ({ api, browserArgs }, use) => {
    // The mock and its proxy are up before the extension can call them.
    if (api.seen.length > 0) throw new Error('the API was called before the browser started');
    const profile = await mkdtemp(join(tmpdir(), 'mt-e2e-profile-'));
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: process.env.HEADFUL !== '1',
      viewport: { width: 1280, height: 800 },
      args: [
        `--disable-extensions-except=${E2E_EXTENSION_DIR}`,
        `--load-extension=${E2E_EXTENSION_DIR}`,
        '--autoplay-policy=no-user-gesture-required',
        '--remote-debugging-port=0',
        ...browserArgs,
      ],
    });
    (context as BrowserContext & { mtProfile?: string }).mtProfile = profile;
    await routeSites(context);
    await use(context);
    await context.close();
    await rm(profile, { recursive: true, force: true });
  },

  sw: async ({ context }, use) => {
    await use(async () => {
      const running = context.serviceWorkers().at(-1);
      if (running !== undefined) return running;
      return context.waitForEvent('serviceworker');
    });
  },

  // Every test starts connected: through `TestAuth`, from the settings page.
  extensionId: [
    async ({ context, sw }, use) => {
      const worker = await sw();
      const id = new URL(worker.url()).host;
      const options = await context.newPage();
      await options.goto(`chrome-extension://${id}/options.html`);
      const connection = options.getByRole('region', { name: 'Connection' });
      await connection.getByRole('button', { name: 'Connect MediaTracker' }).click();
      await expect(connection.getByText('Connected since')).toBeVisible({ timeout: 20_000 });
      await options.close();
      for (const page of context.pages()) {
        if (page.url().startsWith(`chrome-extension://${id}/`)) await page.close();
      }
      await use(id);
    },
    { auto: true },
  ],

  stopWorker: async ({ context, sw }, use) => {
    await use(async () => {
      const page = context.pages()[0] ?? (await context.newPage());
      const cdp = await context.newCDPSession(page);
      // Chrome says when the worker stopped; Playwright keeps one Worker object across the
      // restart (the same target), so its own `close` never fires.
      const stopped = new Promise<void>((resolve) => {
        cdp.on('ServiceWorker.workerVersionUpdated', (event) => {
          if (event.versions.some((v) => v.runningStatus === 'stopped')) resolve();
        });
      });
      await cdp.send('ServiceWorker.enable');
      // A mark only this worker's global holds: the next worker starts without it.
      const running = await sw();
      await running.evaluate(() => {
        (globalThis as Record<string, unknown>).__mtE2eMark = true;
      });
      await cdp.send('ServiceWorker.stopAllWorkers');
      await Promise.race([
        stopped,
        new Promise((_, reject) =>
          setTimeout(() => {
            reject(new Error('the worker did not stop'));
          }, 10_000),
        ),
      ]);
      await cdp.detach();
    });
  },

  workerIsFresh: async ({ sw }, use) => {
    await use(async () =>
      (await sw()).evaluate(
        () => (globalThis as Record<string, unknown>).__mtE2eMark === undefined,
      ),
    );
  },

  popup: async ({ context, sw }, use) => {
    const opened: PopupView[] = [];
    await use(async (page) => {
      await page.bringToFront();
      const worker = await sw();
      const answer = await worker.evaluate(() =>
        chrome.action.openPopup().then(
          () => 'opened',
          (error: unknown) => `refused: ${String(error)}`,
        ),
      );
      if (answer !== 'opened') throw new Error(`action.openPopup: ${answer}`);
      const profile = (context as BrowserContext & { mtProfile?: string }).mtProfile ?? '';
      const port = await devtoolsPort(profile);
      for (let i = 0; i < 100; i += 1) {
        const targets = (await (
          await fetch(`http://127.0.0.1:${String(port)}/json/list`)
        ).json()) as Target[];
        const target = targets.find((t) => t.type === 'page' && t.url.endsWith('/popup.html'));
        if (target !== undefined) {
          const view = await attach(target);
          opened.push(view);
          await view.waitForText('MediaTracker');
          return view;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('the popup never appeared');
    });
    for (const view of opened) view.close();
  },

  injected: async ({ sw }, use) => {
    await use(async (page) => {
      const worker = await sw();
      const url = page.url();
      return worker.evaluate(async (pageUrl: string) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => t.url === pageUrl);
        if (tab?.id === undefined) throw new Error('no such tab');
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const slots = globalThis as unknown as Record<symbol, unknown>;
            return {
              collector: slots[Symbol.for('mediatracker.collector')] != null,
              bootstrap: slots[Symbol.for('mediatracker.bootstrap')] != null,
            };
          },
        });
        return result?.result as { collector: boolean; bootstrap: boolean };
      }, url);
    });
  },
});

/** A port nothing listens on now, for the mock (which listens on 127.0.0.1 only). */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
  return port;
}

export { expect };

/** The body of the `index`-th stored play, as the mock validated it. */
export function evidence(api: Api, index: number): WirePlay {
  const play = api.plays()[index];
  if (play === undefined) throw new Error(`no play ${String(index)}`);
  return play.evidence;
}

/** Waits until `count` plays are stored. */
export async function playsArrive(api: Api, count: number, timeoutMs = 90_000): Promise<void> {
  await expect.poll(() => api.plays().length, { timeout: timeoutMs, intervals: [250] }).toBe(count);
}

/** Proves nothing arrives in `ms`: a negative is a wait, then a look. */
export async function nothingArrives(api: Api, ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  expect(api.playAttempts()).toEqual([]);
  expect(api.plays()).toEqual([]);
}
