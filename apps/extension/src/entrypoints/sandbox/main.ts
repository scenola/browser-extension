/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The interpretation sandbox: a sandboxed page of the manifest — a unique origin, no `chrome.*`,
// no storage, and the manifest's `sandbox` policy: `default-src 'none'`, so nothing is fetched or
// loaded, and a worker only from a `blob:` address it makes itself. It runs no module. The
// modules run in the worker it starts (interpret-worker.ts), because a page has a document, and
// a `<link rel="dns-prefetch">` or `rel="preconnect"` added to one looks a name up before any
// policy is asked: a module here could spell a snapshot into a host name. A worker has no
// document.
//
// The page carries messages: its parent's requests to the worker, and the worker's answers back
// to its parent, the offscreen document, and to nobody else.

// First, so the page holds no WebRTC either (without-webrtc.ts).
import './without-webrtc';

import { INTERPRET_VERSION } from '../../messaging/interpret';
import type { InterpretAnswer, SandboxReady } from '../../messaging/interpret';
import InterpretWorker from './interpret-worker?worker&inline';

/** The parent's origin — the extension's — so an answer reaches nobody else. */
function parentOrigin(): string {
  try {
    const origin = new URL(location.href).origin;
    return origin === 'null' ? '*' : origin;
  } catch {
    return '*';
  }
}

const PARENT_ORIGIN = parentOrigin();

function startWorker(): Worker | null {
  try {
    return new InterpretWorker({ name: 'interpret' });
  } catch {
    // No worker, no modules: each request is answered `unavailable`, and the generic readers
    // still answer.
    return null;
  }
}

/** `null` once there is no worker to ask: it never started, or it failed to load. */
let worker = startWorker();
/** The requests the worker holds, by id: each is answered by the worker, or here if it fails. */
const unanswered = new Set<number>();

function answerUnavailable(id: number): void {
  const none: InterpretAnswer = {
    v: INTERPRET_VERSION,
    type: 'interpret/answer',
    id,
    ok: false,
    reason: 'unavailable',
  };
  window.parent.postMessage(none, PARENT_ORIGIN);
}

/** The fields of an interpret message this page reads; the rest is the worker's to judge. */
interface Envelope {
  readonly v?: unknown;
  readonly type?: unknown;
  readonly id?: unknown;
  readonly serviceId?: unknown;
  readonly snapshot?: unknown;
}

function envelopeOf(data: unknown, type: string): (Envelope & { readonly id: number }) | null {
  if (typeof data !== 'object' || data === null) return null;
  const envelope = data as Envelope;
  if (envelope.v !== INTERPRET_VERSION || envelope.type !== type) return null;
  return typeof envelope.id === 'number' ? { ...envelope, id: envelope.id } : null;
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent) return;
  const request = envelopeOf(event.data, 'interpret/request');
  if (request === null) return;
  if (worker === null) {
    answerUnavailable(request.id);
    return;
  }
  const { id, serviceId, snapshot } = request;
  unanswered.add(id);
  worker.postMessage({ v: INTERPRET_VERSION, type: 'interpret/request', id, serviceId, snapshot });
});

worker?.addEventListener('message', (event: MessageEvent<unknown>) => {
  const answer = envelopeOf(event.data, 'interpret/answer');
  if (answer === null) return;
  unanswered.delete(answer.id);
  window.parent.postMessage(event.data, PARENT_ORIGIN);
});

// The worker answers every request, whatever a module does, so an `error` is its script failing
// to load: a module that throws as the registry evaluates, say. From then on the page is one
// whose worker never started, and what the worker held is answered now, not at the deadline.
worker?.addEventListener('error', () => {
  worker?.terminate();
  worker = null;
  for (const id of unanswered) answerUnavailable(id);
  unanswered.clear();
});

// Requests posted before the worker has loaded its modules wait in its queue.
const ready: SandboxReady = { v: INTERPRET_VERSION, type: 'interpret/ready' };
window.parent.postMessage(ready, PARENT_ORIGIN);
