/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Where the service modules run: a dedicated worker the sandbox page starts, and the one bundle
// that holds them — the ones this build ships, `modulesForBuild` of its mode (`e2e` counting as
// `development`) on its day. A worker has no document, so a module has nothing to add a `<link>`
// to, whose `dns-prefetch` or `preconnect` would look a name up before any policy is asked, and
// no WebRTC. What it does have — `fetch`, sockets, `importScripts`, a worker of its own — answers
// to the policy it inherits from the sandbox page: `default-src 'none'`.
//
// Each request runs one module's `interpret` on the snapshot, timed around the call: a reading
// that took more than 50 ms is discarded, as is one that throws, cannot be written as JSON or is
// over 64 KB written. What passes goes back as plain JSON for the service worker to validate.

import type { Snapshot } from '@mt/core';
import { modulesForBuild } from '@mt/services';
import type { ServiceDefinition } from '@mt/services';

import { INTERPRET_BUDGET_MS, INTERPRET_VERSION } from '../../messaging/interpret';
import type { InterpretAnswer, InterpretFailure } from '../../messaging/interpret';
import { SITES } from '../../sites';

/** The largest reading passed back, as JSON writes it; the service worker's schema is far smaller. */
const MAX_READING_CHARS = 64 * 1024;

/** This worker's global scope, as far as it is used here: the pages' types know only a window. */
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
};

function loadModules(): ReadonlyMap<string, ServiceDefinition> {
  try {
    const built = import.meta.env.MT_BUILD_MODE;
    const mode = built === 'e2e' ? 'development' : built;
    const modules = modulesForBuild(mode, SITES.builtFor.today);
    return new Map(modules.map((module) => [module.id, module]));
  } catch {
    // A registry that does not load interprets nothing; the generic readers still answer.
    return new Map();
  }
}

const MODULES = loadModules();

type Outcome =
  | { readonly ok: true; readonly reading: unknown }
  | { readonly ok: false; readonly reason: InterpretFailure };

function interpretOne(serviceId: unknown, snapshot: unknown): Outcome {
  if (typeof serviceId !== 'string' || typeof snapshot !== 'object' || snapshot === null) {
    return { ok: false, reason: 'bad_request' };
  }
  const module = MODULES.get(serviceId);
  if (module === undefined) return { ok: false, reason: 'unknown_service' };
  let reading: unknown;
  const started = performance.now();
  try {
    reading = module.interpret(snapshot as Snapshot);
  } catch {
    return { ok: false, reason: 'threw' };
  }
  if (performance.now() - started > INTERPRET_BUDGET_MS) return { ok: false, reason: 'slow' };
  let json: string;
  try {
    json = JSON.stringify(reading ?? null);
  } catch {
    return { ok: false, reason: 'unserializable' };
  }
  if (json.length > MAX_READING_CHARS) return { ok: false, reason: 'too_large' };
  return { ok: true, reading: JSON.parse(json) as unknown };
}

// The sandbox page is the only one that can reach this worker; it passes on its parent's requests.
scope.onmessage = (event) => {
  const data = event.data;
  if (typeof data !== 'object' || data === null) return;
  const { v, type, id, serviceId, snapshot } = data as {
    readonly v?: unknown;
    readonly type?: unknown;
    readonly id?: unknown;
    readonly serviceId?: unknown;
    readonly snapshot?: unknown;
  };
  if (v !== INTERPRET_VERSION || type !== 'interpret/request' || typeof id !== 'number') return;
  const outcome = interpretOne(serviceId, snapshot);
  const answer: InterpretAnswer = outcome.ok
    ? { v: INTERPRET_VERSION, type: 'interpret/answer', id, ok: true, reading: outcome.reading }
    : { v: INTERPRET_VERSION, type: 'interpret/answer', id, ok: false, reason: outcome.reason };
  scope.postMessage(answer);
};
