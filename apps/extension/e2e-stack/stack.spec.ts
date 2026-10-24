/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// `pnpm e2e:stack` (the maintainer's, never CI's): the extension against a real dev backend, for
// the three things the mock cannot prove —
//
//   1. the sign-in: `TestAuth` approves through the real `POST /v1/me/scrobblers/authorize`
//      (`Authorization: Bearer $MT_TEST_USER_TOKEN`, a fresh `Idempotency-Key`), then the real
//      code-for-credential exchange binds the credential to the build's DPoP key;
//   2. a play: the Netflix fixture page is watched to its end, and the worker sends the play
//      with that DPoP credential;
//   3. its receipt: the worker reads `GET /v1/integrations/plays/{id}` back and the popup's
//      history says what the backend decided.
//
// What it needs of the backend (README, "Against a local backend"): the scrobbling gate open
// (`MT_FEATURE_SCROBBLING`), the development extension id in `MT_SCROBBLING_DEV_EXTENSION_IDS`,
// and a session token of an account with Plus. Without the token the test is skipped, loudly.
//
// The page is the fixture Netflix episode (e2e/site.ts), routed locally; only the extension's
// own calls leave the browser, and they go to the backend named in config.ts.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

import { NETFLIX, routeSites } from '../e2e/site.ts';
import { SESSION_TOKEN_ENV, SKIP_REASON, STACK_API_URL, STACK_EXTENSION_DIR } from './config.ts';

const SESSION_TOKEN = process.env[SESSION_TOKEN_ENV] ?? '';

/** The extension API, as the functions evaluated in the options page see it. */
declare const chrome: {
  readonly runtime: {
    connect(info: { readonly name: string }): {
      postMessage(message: unknown): void;
      readonly onMessage: { addListener(listener: (message: unknown) => void): void };
    };
  };
};

/** What the options page keeps of its `ui` port while the test drives it. */
interface Line {
  readonly port: { postMessage(message: unknown): void };
  readonly waiting: Map<number, (response: unknown) => void>;
  state: {
    readonly recent?: readonly { readonly view?: { readonly messageKey?: string } }[];
  } | null;
  next: number;
}

/** A receipt word that says the backend has not decided yet (or the outbox has not heard). */
const NOT_DECIDED = new Set(['receipt.received', 'receipt.unknown']);

/**
 * The words of a decided play (src/i18n/messages/en.json `receipt.*`). `awaiting_catalog` is
 * one: the backend stored the play and answered, and is looking the title up, which a dev
 * database with an empty catalog does for as long as its TMDB harvest takes.
 */
const isDecided = (messageKey: string | null): boolean =>
  messageKey !== null && messageKey.startsWith('receipt.') && !NOT_DECIDED.has(messageKey);

async function openLine(page: Page): Promise<void> {
  await page.evaluate(() => {
    const port = chrome.runtime.connect({ name: 'ui' });
    const line: Line = { port, waiting: new Map(), state: null, next: 1 };
    (globalThis as unknown as { __line: Line }).__line = line;
    port.onMessage.addListener((raw) => {
      const message = raw as {
        type?: string;
        id?: number;
        response?: unknown;
        state?: Line['state'];
      };
      if (message.type === 'ui/state') line.state = message.state ?? null;
      if (message.type === 'ui/response' && typeof message.id === 'number') {
        line.waiting.get(message.id)?.(message.response);
        line.waiting.delete(message.id);
      }
    });
  });
}

/** One request over the page's `ui` port, answered with the worker's `UiResponse`. */
function ask(page: Page, request: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(
    (body) =>
      new Promise((resolve) => {
        const line = (globalThis as unknown as { __line: Line }).__line;
        const id = line.next;
        line.next += 1;
        line.waiting.set(id, resolve);
        line.port.postMessage({ v: 1, id, ...body });
      }),
    request,
  );
}

/** The word of the newest play in the history the worker pushes, or `null` for none yet. */
function newestReceipt(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const line = (globalThis as unknown as { __line: Line }).__line;
    return line.state?.recent?.[0]?.view?.messageKey ?? null;
  });
}

test.describe('against the dev backend', () => {
  test.skip(SESSION_TOKEN === '', SKIP_REASON);

  let context: BrowserContext;
  let profile: string;

  test.beforeAll(async () => {
    // A backend that is not there is the commonest failure: say so before anything else does.
    try {
      await fetch(STACK_API_URL, { signal: AbortSignal.timeout(5_000) });
    } catch {
      throw new Error(`no backend answers at ${STACK_API_URL} (make dev, or MT_STACK_API_URL)`);
    }
    profile = await mkdtemp(join(tmpdir(), 'mt-e2e-stack-profile-'));
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: process.env.HEADFUL !== '1',
      viewport: { width: 1280, height: 800 },
      args: [
        `--disable-extensions-except=${STACK_EXTENSION_DIR}`,
        `--load-extension=${STACK_EXTENSION_DIR}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    await routeSites(context);
  });

  test.afterAll(async () => {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  });

  test('one sign-in, one play, its receipt', async () => {
    const worker = context.serviceWorkers().at(-1) ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await openLine(options);

    // 1. The sign-in: the real approval, the real token exchange.
    const connected = (await ask(options, {
      type: 'ui/connect',
      strategy: 'test',
      token: SESSION_TOKEN,
    })) as { ok?: boolean; error?: string; data?: { result?: { kind?: string } } };
    expect(
      connected.data?.result?.kind,
      `sign-in answered ${JSON.stringify(connected.data?.result ?? connected)}: forbidden means no ` +
        'session or no Plus; feature_closed means the scrobbling gate is shut; code_invalid ' +
        "means the redirect was refused (is the dev extension id in the backend's " +
        'MT_SCROBBLING_DEV_EXTENSION_IDS?); an error means the worker refused the request ' +
        "(a token over ui/connect's bound for the test strategy, say)",
    ).toBe('connected');

    // 2. A play: the fixture episode, watched to its end.
    const page = await context.newPage();
    await page.goto(NETFLIX.episode());
    await page.evaluate(() => window.e2e.watch());
    await page.evaluate(() => window.e2e.ended());

    // 3. Its receipt: the worker sent the play, read the receipt back, and pushed the history.
    await expect
      .poll(async () => isDecided(await newestReceipt(options)), {
        timeout: 120_000,
        intervals: [500],
        message: 'the backend never answered the play with a receipt',
      })
      .toBe(true);
    expect(isDecided(await newestReceipt(options))).toBe(true);
  });
});
