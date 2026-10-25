/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A local mock of the Scenola routes the extension uses, for contributors (who cannot run the
// private backend) and for the end-to-end tests: `pnpm mock-api` (port 8787), or
// `startMockApi({ port: 0 })` in a test. It behaves as the server does — the backend line each
// rule mirrors is named beside it — so code that passes against it passes against the server:
//
//   GET  /connect/extension             the approval page: one Approve button → 303 to the redirect
//   POST /__test/approve                what `TestAuth` calls: the approval body → `{redirect_to}`
//   POST /v1/integrations/oauth/token   PKCE + DPoP code exchange → the DPoP-bound credential
//   POST /v1/integrations/plays         a play → 202, under its `Idempotency-Key`
//   GET  /v1/integrations/plays/{id}    the play's receipt, on a progression
//   GET  /v1/integrations/connection    the connection's status and when its credential ends
//
// A request passes the server's layers in the server's order: the body cap (413), the idempotency
// layer (400 / replay / 422 / 409), the JSON parse (422), the credential and its proof (401), the
// budget (429), the body's schema (422), the route. A `MockScript` forces any answer of the token
// endpoint and the plays routes at the point where the server would give it (`TokenFault`,
// `PlayFault`, `ReceiptFault`). Node's `http` only, bound to 127.0.0.1 only.
//
// This file is the mock's surface and its dispatcher; the routes are routes.ts, what they answer
// with answers.ts, the script and the answers it forces script.ts, the credential credential.ts,
// the HTTP plumbing http.ts, and what the mock keeps state.ts. None of them imports this file.

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { parseArgs } from 'node:util';

import {
  APPROVAL_PATH,
  CONNECTION_PATH,
  DEFAULT_BODY_LIMIT,
  IDEMPOTENCY_EXEMPT,
  PLAYS_PATH,
  RECEIPT_PATH,
  TEST_APPROVE_PATH,
  TOKEN_PATH,
  WRITE_METHODS,
  ForcedQueue,
  httpError,
  internalError,
  keyMalformed,
  keyRequired,
  tooLarge,
} from './answers.ts';
import type { Answer, Ctx, Exchange } from './answers.ts';
import { keyOf } from './credential.ts';
import { declaredOver, deliver, send, unquote } from './http.ts';
import {
  approvalPageAnswer,
  approveOnPage,
  connectionRead,
  playsRoute,
  receiptOf,
  testApprove,
  token,
} from './routes.ts';
import { checkedScript } from './script.ts';
import type { CheckedScript, MockScript } from './script.ts';
import {
  MockState,
  createClock,
  defaultProgression,
  isFinishThreshold,
  isStartThreshold,
} from './state.ts';
import type {
  ConnectionStatus,
  FinishThresholdPercent,
  RecordedPlay,
  StartThresholdPercent,
} from './state.ts';

export type {
  ConnectionStatus,
  Decided,
  RecordedPlay,
  ReceiptReason,
  ReceiptState,
  ReceiptStep,
  FinishThresholdPercent,
  StartThresholdPercent,
} from './state.ts';

export type {
  ConnectionAnswer,
  ConnectionFault,
  MockScript,
  NotKept,
  PlayAnswer,
  PlayFault,
  RawAnswer,
  ReceiptAnswer,
  ReceiptFault,
  RetryLater,
  TokenAnswer,
  TokenFault,
} from './script.ts';

// ── the public surface ───────────────────────────────────────────────────────────────────────

export interface MockApiOptions {
  /** The port, on 127.0.0.1 only; 0 picks a free one. */
  readonly port: number;
  readonly script?: MockScript;
  /**
   * The base URL clients are configured with (`MT_API_BASE_URL`): a proof's `htu` must name it, as
   * the server's `api_public_base_url`. Default `http://127.0.0.1:<port>`.
   */
  readonly publicUrl?: string;
  /** Freezes the clock at this instant (epoch ms): it then moves only with `advance`. */
  readonly now?: number;
}

export interface MockApi {
  /** The public base URL: what the extension's API and web-app bases are set to. */
  readonly url: string;
  /** Every play stored, oldest first (a live view). */
  readonly plays: readonly RecordedPlay[];
  /** How many requests a forced `hang` holds right now. */
  readonly held: number;
  /** Moves the mock's clock forward: nonces, code lifetimes, receipts, budgets, locks. */
  advance(ms: number): void;
  /** The ids of the connections that authenticate now, oldest first (what `revoke` names). */
  connections(): readonly string[];
  /**
   * What the web app's *Disconnect* does: the connection `id` names (every live one when omitted)
   * is revoked, and from then on its credential gets the plays route's `401
   * scrobbling.credential_invalid` at every route — plays, receipts and the connection read.
   * Returns how many it revoked; an unknown id is a `RangeError`.
   */
  revoke(id?: string): number;
  /**
   * Sets the status the connection read states and the plays route applies: `braked` holds each
   * play (`held` / `braked`), `suspended` answers a play without keeping it (`dismissed` /
   * `account_deletion`). For the connection `id` names, or every live one.
   */
  setStatus(status: ConnectionStatus, id?: string): void;
  /**
   * What the app's start setting does: the share of a film after which a start saves it in
   * progress (5, 10 or 20), or `null` for starts off — the default. The connection read states
   * it; the plays route answers a start it does not take `ignored` / `not_completed`, not kept.
   */
  setStartThreshold(percent: StartThresholdPercent | null): void;
  /**
   * What the app's finish setting does: the share of the story after which a viewing counts
   * (50, 70 — the default — or 90). The connection read states it; the plays route answers a
   * viewing with numbers that neither ends nor reaches it `ignored` / `not_completed`, not kept.
   */
  setFinishThreshold(percent: FinishThresholdPercent): void;
  /**
   * The person signs in to another account in the web app: every sign-in from now on makes a
   * connection for `account` (`account-a` until this is called). Connections made before keep
   * the account they were made for. The connection read states the account as its `account_key`.
   */
  signInAs(account: string): void;
  /** Queues more forced answers behind those already queued (and replaces the progression). */
  force(script: MockScript): void;
  close(): Promise<void>;
}

// ── the mock ─────────────────────────────────────────────────────────────────────────────────

export async function startMockApi(options: MockApiOptions): Promise<MockApi> {
  const { port, now } = options;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError('port is an integer 0–65535');
  }
  if (!(now === undefined || Number.isFinite(now))) {
    throw new RangeError('now is a finite epoch ms');
  }
  const script = options.script === undefined ? null : checkedScript(options.script);
  const ctx: Ctx = {
    state: new MockState(createClock(now ?? null)),
    publicUrl: '',
    queues: {
      token: new ForcedQueue(),
      plays: new ForcedQueue(),
      receipts: new ForcedQueue(),
      connection: new ForcedQueue(),
    },
    progression: defaultProgression,
    held: 0,
  };
  const apply = (checked: CheckedScript): void => {
    ctx.queues.token.push(checked.token);
    ctx.queues.plays.push(checked.plays);
    ctx.queues.receipts.push(checked.receipts);
    ctx.queues.connection.push(checked.connection);
    if (checked.progression !== undefined) ctx.progression = checked.progression;
  };
  if (script !== null) apply(script);

  const server = createServer({ headersTimeout: 10_000, requestTimeout: 30_000 }, (req, res) => {
    void handle(req, res, ctx);
  });
  await listen(server, port);
  const address = server.address();
  const bound = typeof address === 'object' && address !== null ? address.port : port;
  ctx.publicUrl =
    options.publicUrl === undefined
      ? `http://127.0.0.1:${String(bound)}`
      : checkedBase(options.publicUrl);
  return controls(ctx, server, apply);
}

/** What a test holds of the running mock. */
function controls(ctx: Ctx, server: Server, apply: (checked: CheckedScript) => void): MockApi {
  let closing: Promise<void> | null = null;
  return {
    url: ctx.publicUrl,
    plays: ctx.state.plays,
    get held() {
      return ctx.held;
    },
    advance: (ms) => {
      ctx.state.clock.advance(ms);
    },
    connections: () => ctx.state.connectionIds(),
    revoke: (id) => ctx.state.revoke(id),
    setStatus: (status, id) => {
      if (!['active', 'braked', 'suspended'].includes(status)) {
        throw new RangeError('status is active, braked or suspended');
      }
      ctx.state.setStatus(status, id);
    },
    setStartThreshold: (percent) => {
      if (!isStartThreshold(percent))
        throw new RangeError('a start threshold is 5, 10, 20 or null');
      ctx.state.startThresholdPercent = percent;
    },
    setFinishThreshold: (percent) => {
      if (!isFinishThreshold(percent)) throw new RangeError('a finish threshold is 50, 70 or 90');
      ctx.state.finishThresholdPercent = percent;
    },
    signInAs: (account) => {
      if (account === '') throw new RangeError('an account has a name');
      ctx.state.account = account;
    },
    force: (more) => {
      apply(checkedScript(more));
    },
    close: () => (closing ??= close(server)),
  };
}

/** `api_public_base_url.rstrip("/")`: an absolute http(s) URL, no userinfo, query or fragment. */
function checkedBase(base: string): string {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new RangeError('publicUrl is an absolute URL');
  }
  if (
    !(url.protocol === 'http:' || url.protocol === 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    base.includes('?') ||
    base.includes('#') ||
    !/^[\x21-\x7e]+$/.test(base)
  ) {
    throw new RangeError('publicUrl is an http(s) base URL without userinfo, query or fragment');
  }
  return base.replace(/\/+$/, '');
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
    // Held and kept-alive connections end now, not when their clients give up.
    server.closeAllConnections();
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<void> {
  const x = exchangeOf(req, res);
  try {
    await route(x, ctx);
  } catch (error: unknown) {
    // The kind only: a message can carry what a request sent.
    const kind =
      error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'unknown';
    process.stderr.write(`mock-api: ${kind} while answering a request\n`);
    if (!res.headersSent && !res.destroyed) send(x, internalError(x, ctx));
    else res.destroy();
  }
}

function exchangeOf(req: IncomingMessage, res: ServerResponse): Exchange {
  const target = req.url ?? '';
  const q = target.indexOf('?');
  const rawPath = q < 0 ? target : target.slice(0, q);
  return {
    req,
    res,
    requestId: randomUUID(),
    path: target.startsWith('/') ? unquote(rawPath) : '',
    query: q < 0 ? '' : target.slice(q + 1),
    offeredNonce: null,
  };
}

async function route(x: Exchange, ctx: Ctx): Promise<void> {
  const method = x.req.method ?? '';
  const reads = method === 'GET' || method === 'HEAD';
  const posts = method === 'POST';
  switch (x.path) {
    case APPROVAL_PATH:
      if (reads) return deliver(x, ctx, approvalPageAnswer(x));
      return deliver(x, ctx, posts ? await approveOnPage(x, ctx) : unrouted(x, ctx, 405));
    case TEST_APPROVE_PATH:
      return deliver(x, ctx, posts ? await testApprove(x, ctx) : unrouted(x, ctx, 405));
    case TOKEN_PATH:
      return deliver(x, ctx, posts ? await token(x, ctx) : unrouted(x, ctx, 405));
    case PLAYS_PATH:
      if (posts) return playsRoute(x, ctx);
      return deliver(x, ctx, unrouted(x, ctx, 405));
    case CONNECTION_PATH:
      return deliver(x, ctx, reads ? await connectionRead(x, ctx) : unrouted(x, ctx, 405));
    default: {
      const receipt = RECEIPT_PATH.exec(x.path);
      if (receipt === null) return deliver(x, ctx, unrouted(x, ctx, 404));
      const segment = receipt[1] ?? '';
      return deliver(x, ctx, reads ? await receiptOf(x, ctx, segment) : unrouted(x, ctx, 405));
    }
  }
}

/** A path no route takes, or a method its route does not: the outer layers still run first. */
function unrouted(x: Exchange, ctx: Ctx, status: 404 | 405): Answer {
  if (WRITE_METHODS.has(x.req.method ?? '') && !IDEMPOTENCY_EXEMPT.has(x.path)) {
    if (declaredOver(x.req, DEFAULT_BODY_LIMIT)) return tooLarge(DEFAULT_BODY_LIMIT)(x, ctx);
    const key = keyOf(x);
    if (key === 'missing') return keyRequired(x, ctx);
    if (key === 'malformed') return keyMalformed(x, ctx);
  }
  return httpError(status, status === 404 ? 'Not Found' : 'Method Not Allowed')(x, ctx);
}

// ── `pnpm mock-api` ──────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { port: { type: 'string', default: '8787' }, 'public-url': { type: 'string' } },
    strict: true,
  });
  const publicUrl = values['public-url'];
  const api = await startMockApi({
    port: Number(values.port),
    ...(publicUrl === undefined ? {} : { publicUrl }),
  });
  process.stdout.write(
    `Mock Scenola API on ${api.url}\n` +
      `  set the extension's API and web-app base URLs to ${api.url}\n` +
      '  (a proof names the API base URL; pass --public-url if the extension uses another)\n',
  );
  const stop = (): void => {
    void api.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (import.meta.main) await main();
