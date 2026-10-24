/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The offscreen document: it hosts the sandboxed interpretation iframe and carries
// messages between it and the worker, nothing else. A request is taken only from this
// extension's worker; an answer only from the iframe's own window. It reads no request beyond
// its envelope and judges no answer — the worker validates every one (platform/interpreter.ts).
//
// It closes itself after 120 s without a request, as the worker would: a worker that stopped
// before its own timer fired cannot close it.

import { browser } from 'wxt/browser';

import { INTERPRETER_TARGET, INTERPRET_VERSION } from '../../messaging/interpret';
import type { InterpretAnswer, InterpretFailure } from '../../messaging/interpret';

const IDLE_CLOSE_MS = 120_000;
/** A request the sandbox has not answered in this long is answered for it. */
const ANSWER_DEADLINE_MS = 5_000;
/** Requests waiting for the sandbox to load, at most. */
const MAX_WAITING = 64;

/** This extension's own pages, from this page's address (it is one of them). */
const WORKER_URL = new URL('/background.js', location.href).href;

const iframe = document.createElement('iframe');
// The manifest sandboxes sandbox.html itself; the attribute sandboxes the frame, so any page a
// module sends it to is sandboxed too — an opaque origin with no `chrome.*`.
iframe.setAttribute('sandbox', 'allow-scripts');
iframe.src = new URL('/sandbox.html', location.href).href;
document.body.append(iframe);

let ready = false;
let seq = 0;
const waiting: unknown[] = [];
/** Requests forwarded to the sandbox, by this page's own id for them. */
const pending = new Map<number, (answer: InterpretAnswer) => void>();
let idle: ReturnType<typeof setTimeout> | undefined;

function touch(): void {
  clearTimeout(idle);
  idle = setTimeout(() => {
    if (pending.size === 0 && waiting.length === 0) window.close();
    else touch();
  }, IDLE_CLOSE_MS);
}

function forward(message: unknown): void {
  // The sandbox's origin is opaque: `"*"` is the only target there is for it.
  iframe.contentWindow?.postMessage(message, '*');
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const sandbox = iframe.contentWindow;
  if (sandbox === null || event.source !== sandbox) return;
  const data = event.data;
  if (typeof data !== 'object' || data === null) return;
  const { v, type, id } = data as {
    readonly v?: unknown;
    readonly type?: unknown;
    readonly id?: unknown;
  };
  if (v !== INTERPRET_VERSION) return;
  if (type === 'interpret/ready') {
    ready = true;
    for (const message of waiting.splice(0)) forward(message);
    return;
  }
  if (type !== 'interpret/answer' || typeof id !== 'number') return;
  const respond = pending.get(id);
  if (respond === undefined) return;
  pending.delete(id);
  respond(data as InterpretAnswer);
});

function isRequest(message: unknown): message is {
  readonly id: number;
  readonly serviceId: unknown;
  readonly snapshot: unknown;
} {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as {
    readonly v?: unknown;
    readonly target?: unknown;
    readonly type?: unknown;
    readonly id?: unknown;
  };
  return (
    m.v === INTERPRET_VERSION &&
    m.target === INTERPRETER_TARGET &&
    m.type === 'interpret/request' &&
    typeof m.id === 'number'
  );
}

browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isRequest(message)) return false;
  // This extension's worker only: no tab, no other page of the extension.
  if (sender.id !== browser.runtime.id || sender.tab !== undefined || sender.url !== WORKER_URL) {
    return false;
  }
  touch();
  const workerId = message.id;
  const fail = (reason: InterpretFailure): void => {
    sendResponse({
      v: INTERPRET_VERSION,
      type: 'interpret/answer',
      id: workerId,
      ok: false,
      reason,
    });
  };
  if (!ready && waiting.length >= MAX_WAITING) {
    fail('unavailable');
    return false;
  }
  // The sandbox leg has ids of its own: a worker that restarted counts from 1 again, and an
  // answer to its predecessor's request must not answer its own.
  seq += 1;
  const local = seq;
  const timer = setTimeout(() => {
    pending.delete(local);
    fail('timeout');
  }, ANSWER_DEADLINE_MS);
  pending.set(local, (answer) => {
    clearTimeout(timer);
    sendResponse({ ...answer, id: workerId });
  });
  const request = {
    v: INTERPRET_VERSION,
    type: 'interpret/request',
    id: local,
    serviceId: message.serviceId,
    snapshot: message.snapshot,
  };
  if (ready) forward(request);
  else waiting.push(request);
  return true;
});

touch();
