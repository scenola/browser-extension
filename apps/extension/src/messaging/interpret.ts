/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The interpretation channel: worker → offscreen document by `runtime.sendMessage`, offscreen
// document → sandboxed iframe by `postMessage`, and the answer back the same way. The worker
// validates every answer (platform/interpreter.ts); the offscreen page and the sandbox only
// carry. Types and constants only — nothing here runs, so the sandbox and the offscreen page take
// no validator with them.

import type { Snapshot } from '@mt/core';

export const INTERPRET_VERSION = 1;

/** The offscreen document's address on `runtime.sendMessage`: other pages ignore it. */
export const INTERPRETER_TARGET = 'mt-interpreter';

/** How long a module's `interpret` may take; a slower answer is discarded. */
export const INTERPRET_BUDGET_MS = 50;

/** Why there is no reading — counted in diagnostics, never shown. */
export type InterpretFailure =
  | 'unknown_service'
  | 'threw'
  | 'slow'
  | 'unserializable'
  | 'too_large'
  | 'bad_request'
  | 'timeout'
  | 'invalid'
  | 'unavailable';

/** Worker → offscreen document; the offscreen document passes it on to the sandbox. */
export interface InterpretRequest {
  readonly v: typeof INTERPRET_VERSION;
  readonly target: typeof INTERPRETER_TARGET;
  readonly type: 'interpret/request';
  readonly id: number;
  readonly serviceId: string;
  readonly snapshot: Snapshot;
}

/** Sandbox → offscreen document → worker. `reading` is whatever the module returned, as JSON. */
export type InterpretAnswer =
  | {
      readonly v: typeof INTERPRET_VERSION;
      readonly type: 'interpret/answer';
      readonly id: number;
      readonly ok: true;
      readonly reading: unknown;
    }
  | {
      readonly v: typeof INTERPRET_VERSION;
      readonly type: 'interpret/answer';
      readonly id: number;
      readonly ok: false;
      readonly reason: InterpretFailure;
    };

/** Sandbox → offscreen document, once its modules are loaded. */
export interface SandboxReady {
  readonly v: typeof INTERPRET_VERSION;
  readonly type: 'interpret/ready';
}
