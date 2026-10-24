/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The interpretation sandbox against code that tries to get a snapshot out. Its policy stops
// every fetch and load, but not every way out of a page: a peer connection's STUN and TURN
// requests go wherever the code names, a resource hint (`dns-prefetch`, `preconnect`) looks a
// name up before any policy is asked, and the policy says what the page loads, not where its
// frame goes. So the modules run in the page's worker, which has no document and no WebRTC, and
// the page runs only its own code and holds no WebRTC either. These tests do what hostile code
// would — in the worker, every way out a worker has; in the page, WebRTC, in the page and in a
// frame of its own, and sending its frame to another of the extension's pages — and watch what
// gets out: a STUN server on this machine that counts the requests reaching it, and Chromium's
// own network log for the names it looked up.
//
// The sandbox is the real one, in the real offscreen page's frame: `offscreen.html` opened in a
// tab builds the same frame the worker's offscreen document does.

import { randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import type { Socket } from 'node:dgram';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Frame, Page, Worker as PageWorker } from '@playwright/test';

import { expect, test } from './fixtures.ts';

/** A STUN server that answers nothing and counts the requests that reach it. */
async function stunCatcher(): Promise<{ port: number; received: () => number; close: () => void }> {
  const socket: Socket = createSocket('udp4');
  let received = 0;
  socket.on('message', () => {
    received += 1;
  });
  await new Promise<void>((resolve) => {
    socket.bind(0, '127.0.0.1', resolve);
  });
  return {
    port: socket.address().port,
    received: () => received,
    close: () => {
      socket.close();
    },
  };
}

/**
 * What a hostile module would run: a peer connection to `stun:127.0.0.1:<port>` from `where` —
 * the page's own globals, or those of a frame it appends (`about:blank`, or a `srcdoc` one).
 * `none` when there was no WebRTC to reach, or reaching for it was refused.
 */
interface Attempt {
  readonly port: number;
  readonly where: 'page' | 'blank-frame' | 'srcdoc-frame';
}

function tryWebRtc(args: Attempt): Promise<'none' | 'sent'> {
  type Rtc = new (config: RTCConfiguration) => RTCPeerConnection;
  let Peer: Rtc | undefined;
  try {
    let scope = globalThis as { RTCPeerConnection?: Rtc } | null;
    if (args.where !== 'page') {
      const frame = document.createElement('iframe');
      if (args.where === 'srcdoc-frame') frame.srcdoc = '<p></p>';
      document.body.append(frame);
      scope = frame.contentWindow as { RTCPeerConnection?: Rtc } | null;
    }
    Peer = scope?.RTCPeerConnection;
  } catch {
    // A frame of another origin: its globals are not the module's to read.
    Peer = undefined;
  }
  if (typeof Peer !== 'function') return Promise.resolve('none');
  const peer = new Peer({ iceServers: [{ urls: `stun:127.0.0.1:${String(args.port)}` }] });
  peer.createDataChannel('out');
  return peer
    .createOffer()
    .then((offer) => peer.setLocalDescription(offer))
    .then(
      () =>
        new Promise<'sent'>((resolve) => {
          setTimeout(() => {
            peer.close();
            resolve('sent');
          }, 3_000);
        }),
    );
}

/** The sandbox frame of an offscreen page opened in a tab, once its modules have loaded. */
async function sandboxFrame(page: Page, extensionId: string): Promise<Frame> {
  await page.goto(`chrome-extension://${extensionId}/offscreen.html`);
  await expect
    .poll(() => page.frames().some((frame) => frame.url().endsWith('/sandbox.html')))
    .toBe(true);
  const frame = page.frames().find((f) => f.url().endsWith('/sandbox.html'));
  if (frame === undefined) throw new Error('no sandbox frame');
  await frame.waitForLoadState('load');
  return frame;
}

test('the control: a web page reaches the STUN server, so the catcher hears one', async ({
  context,
}) => {
  const stun = await stunCatcher();
  try {
    const page = await context.newPage();
    await page.goto('about:blank');
    const attempt: Attempt = { port: stun.port, where: 'page' };
    expect(await page.evaluate(tryWebRtc, attempt)).toBe('sent');
    await expect.poll(() => stun.received(), { timeout: 5_000 }).toBeGreaterThan(0);
  } finally {
    stun.close();
  }
});

test('the sandbox page holds no WebRTC, and nothing leaves', async ({ context, extensionId }) => {
  const stun = await stunCatcher();
  try {
    const frame = await sandboxFrame(await context.newPage(), extensionId);
    const attempt: Attempt = { port: stun.port, where: 'page' };
    expect(await frame.evaluate(tryWebRtc, attempt)).toBe('none');
    expect(stun.received()).toBe(0);
  } finally {
    stun.close();
  }
});

// A frame a sandboxed page appends inherits the sandbox, and with it an opaque origin of its own:
// its fresh globals, WebRTC among them, are another origin's, which the page cannot read.
for (const where of ['blank-frame', 'srcdoc-frame'] as const) {
  test(`a frame made in the sandbox page (${where}) brings no WebRTC back, and nothing leaves`, async ({
    context,
    extensionId,
  }) => {
    const stun = await stunCatcher();
    try {
      const frame = await sandboxFrame(await context.newPage(), extensionId);
      const attempt: Attempt = { port: stun.port, where };
      const outcome = await frame.evaluate(tryWebRtc, attempt);
      // Given time to arrive, whatever the outcome said.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect({ outcome, received: stun.received() }).toEqual({ outcome: 'none', received: 0 });
    } finally {
      stun.close();
    }
  });
}

// `frame-src 'self'` keeps the frame on the extension's own pages. Chrome refuses to take it from
// the sandbox's opaque origin to one of them (none is web-accessible), and were that ever to
// change, the frame's own `sandbox` attribute keeps whatever it reaches sandboxed: an opaque
// origin, with no extension API for a module to have sent it there to use.
test('the sandbox frame, sent to another of the extension’s pages, has no extension API there', async ({
  context,
  extensionId,
}) => {
  const frame = await sandboxFrame(await context.newPage(), extensionId);
  await frame.evaluate(() => {
    location.href = new URL('/popup.html', location.href).href;
  });
  await expect.poll(() => frame.url()).not.toMatch(/\/sandbox\.html$/u);
  await frame.waitForLoadState('load');
  const there = await frame.evaluate(() => ({
    origin: self.origin,
    runtime: typeof (globalThis as { chrome?: { runtime?: { id?: unknown } } }).chrome?.runtime?.id,
  }));
  expect(there).toEqual({ origin: 'null', runtime: 'undefined' });
});

/** The modules' worker, which the sandbox page starts as it loads. */
async function modulesWorker(page: Page): Promise<PageWorker> {
  await expect.poll(() => page.workers().length).toBe(1);
  const [worker] = page.workers();
  if (worker === undefined) throw new Error('no modules worker');
  return worker;
}

/** A host of its own for each way out, so the network log says which one was taken. */
function hostsFor<K extends string>(
  where: string,
  ways: readonly K[],
): Readonly<Record<K, string>> {
  const name = (way: K) => `${way}-${where}-${randomUUID().slice(0, 8)}.mt-e2e.test`;
  return Object.fromEntries(ways.map((way) => [way, name(way)])) as Record<K, string>;
}

type HintRel = 'dns-prefetch' | 'preconnect' | 'prefetch';
type WorkerWay = 'fetch' | 'socket' | 'events' | 'script';

/** What a page's code can add: one `<link>` per hint, each naming its host. */
function addHints(hosts: Readonly<Record<HintRel, string>>): void {
  for (const [rel, host] of Object.entries(hosts)) {
    const link = document.createElement('link');
    link.rel = rel;
    link.href = `https://${host}/`;
    document.head.append(link);
  }
}

/** What a hostile module in the worker would try: each way out a worker has, to its own host. */
async function tryEveryWay(
  hosts: Readonly<Record<WorkerWay, string>>,
): Promise<{ document: string; webrtc: string }> {
  const quietly = async (attempt: () => unknown): Promise<void> => {
    try {
      await attempt();
    } catch {
      // Refused: what matters is whether the name was looked up.
    }
  };
  await quietly(() => fetch(`https://${hosts.fetch}/`));
  await quietly(() => new WebSocket(`wss://${hosts.socket}/`));
  await quietly(() => new EventSource(`https://${hosts.events}/`));
  await quietly(() => {
    (self as unknown as { importScripts(url: string): void }).importScripts(
      `https://${hosts.script}/x.js`,
    );
  });
  const global = globalThis as Record<string, unknown>;
  return { document: typeof global.document, webrtc: typeof global.RTCPeerConnection };
}

test.describe('what gets out, by Chromium’s own network log', () => {
  const netLog = join(tmpdir(), `mt-e2e-net-log-${String(process.pid)}.json`);
  test.use({ browserArgs: [`--log-net-log=${netLog}`] });

  // A page's `<link rel="dns-prefetch">` and `rel="preconnect"` look a name up before any policy
  // is asked, which is why no module runs in a page. The control is a web page adding them: the
  // log names its hosts, so a host missing from it was never looked up, not merely never logged.
  test('the modules’ worker has no document for a hint, and looks no name up; a web page’s hints do', async ({
    context,
    extensionId,
  }) => {
    const control = 'https://hints.mt-e2e.test/';
    await context.route(control, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>hints</title>' }),
    );
    const hints = hostsFor<HintRel>('page', ['dns-prefetch', 'preconnect', 'prefetch']);
    const ways = hostsFor<WorkerWay>('worker', ['fetch', 'socket', 'events', 'script']);
    const web = await context.newPage();
    await web.goto(control);
    await web.evaluate(addHints, hints);
    const page = await context.newPage();
    await sandboxFrame(page, extensionId);
    const reach = await (await modulesWorker(page)).evaluate(tryEveryWay, ways);
    // Hints are followed when the browser gets to them; the log is complete once it closes.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await context.close();
    const log = await readFile(netLog, 'utf8');
    await rm(netLog, { force: true });
    const lookedUp = (hosts: Readonly<Record<string, string>>) =>
      Object.entries(hosts)
        .filter(([, host]) => log.includes(host))
        .map(([way]) => way);
    expect({ reach, page: lookedUp(hints), worker: lookedUp(ways) }).toEqual({
      reach: { document: 'undefined', webrtc: 'undefined' },
      page: ['dns-prefetch', 'preconnect', 'prefetch'],
      worker: [],
    });
  });
});
