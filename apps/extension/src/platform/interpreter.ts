/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The `Interpreter` port: a service module's `interpret(snapshot)` runs in a sandboxed iframe (no
// network, no `chrome.*`, no page) hosted by an offscreen document. This worker side makes sure
// the document exists, sends it each snapshot, and validates every answer with the shared schema
// (messaging/schemas.ts) before core sees it — whatever the module returned, a reading of the
// wrong shape is `null`. A module that throws, takes more than 50 ms (measured in the sandbox),
// returns junk, or never answers is set aside for that snapshot (`null`, so the generic readers
// answer) and the failure goes to the diagnostics by name.
//
// The document is closed once no snapshot came for 120 s, and at once when an answer is
// overdue: a module that never returns holds the sandbox's thread, and closing the document is
// what stops it. The next snapshot opens it again.

import { IDENTITY_FIELDS } from '@mt/core';
import type { Interpreter, ServiceReading, Snapshot } from '@mt/core';
import * as v from 'valibot';
import type { Browser } from 'wxt/browser';

import { INTERPRETER_TARGET, INTERPRET_VERSION } from '../messaging/interpret';
import type { InterpretFailure, InterpretRequest } from '../messaging/interpret';
import { ServiceReadingSchema } from '../messaging/schemas';

/** The offscreen document's page (src/entrypoints/offscreen/index.html). */
export const OFFSCREEN_PAGE = 'offscreen.html';
/**
 * No snapshot for this long, and the offscreen document is closed.
 *
 * @public
 */
export const OFFSCREEN_IDLE_MS = 120_000;
/** An answer later than this is not coming: the document is closed, the snapshot set aside. */
const ANSWER_DEADLINE_MS = 2_000;
/** Opening the document may take a while on a busy machine; past this it failed. */
const CREATE_DEADLINE_MS = 10_000;
const JUSTIFICATION =
  'Runs the service modules that read streaming pages in a sandboxed iframe with no network access.';

const FAILURES = [
  'unknown_service',
  'threw',
  'slow',
  'unserializable',
  'too_large',
  'bad_request',
  'timeout',
  'invalid',
  'unavailable',
] as const satisfies readonly InterpretFailure[];

const AnswerSchema = v.variant('ok', [
  v.strictObject({
    v: v.literal(INTERPRET_VERSION),
    type: v.literal('interpret/answer'),
    id: v.number(),
    ok: v.literal(true),
    reading: v.unknown(),
  }),
  v.strictObject({
    v: v.literal(INTERPRET_VERSION),
    type: v.literal('interpret/answer'),
    id: v.number(),
    ok: v.literal(false),
    reason: v.picklist(FAILURES),
  }),
]);

const ReadingOrNull = v.nullable(ServiceReadingSchema);

/**
 * Every field of a module's reading says it came from the module, whatever the module wrote. The
 * fields that carry a provenance (`Field`) are core's one list, `IDENTITY_FIELDS`, which a type
 * test holds to every `Field`-wrapped key of `ServiceReading`.
 */
function fromModule(reading: ServiceReading): ServiceReading {
  const fixed: Record<string, unknown> = { ...reading };
  for (const key of IDENTITY_FIELDS) {
    const field = reading[key];
    if (field !== undefined) fixed[key] = { ...field, source: 'module' };
  }
  return fixed;
}

type Offscreen = Pick<typeof Browser.offscreen, 'createDocument' | 'closeDocument'>;
type Runtime = Pick<typeof Browser.runtime, 'sendMessage' | 'getContexts'>;

export interface OffscreenInterpreterDeps {
  readonly offscreen: Offscreen;
  readonly runtime: Runtime;
  /** The offscreen page's full URL (`chrome-extension://<id>/offscreen.html`). */
  readonly offscreenUrl: string;
  /** Told of each snapshot a module was set aside for, by service and reason (diagnostics). */
  readonly onFailure?: (serviceId: string, reason: InterpretFailure) => void;
}

class Overdue extends Error {
  override readonly name = 'Overdue';
}

/** The sandbox's answer: what the module returned, or why there is nothing. */
type Asked =
  | { readonly ok: true; readonly reading: unknown }
  | { readonly ok: false; readonly reason: InterpretFailure };

const refused = (reason: InterpretFailure): Asked => ({ ok: false, reason });

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const overdue = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Overdue());
    }, ms);
  });
  return Promise.race([promise, overdue]).finally(() => {
    clearTimeout(timer);
  });
}

export class OffscreenInterpreter implements Interpreter {
  readonly #deps: OffscreenInterpreterDeps;
  #seq = 0;
  #inFlight = 0;
  #idle: ReturnType<typeof setTimeout> | null = null;
  #opening: Promise<void> | null = null;

  constructor(deps: OffscreenInterpreterDeps) {
    this.#deps = deps;
    // A document left open by an earlier life of the worker closes too, if nothing uses it.
    this.#armIdle();
  }

  async interpret(serviceId: string, snapshot: Snapshot): Promise<ServiceReading | null> {
    this.#inFlight += 1;
    this.#disarmIdle();
    try {
      const answer = await this.#ask(serviceId, snapshot);
      if (!answer.ok) return this.#failed(serviceId, answer.reason);
      const reading = v.safeParse(ReadingOrNull, answer.reading);
      if (!reading.success) return this.#failed(serviceId, 'invalid');
      return reading.output === null ? null : fromModule(reading.output);
    } finally {
      this.#inFlight -= 1;
      this.#armIdle();
    }
  }

  #failed(serviceId: string, reason: InterpretFailure): null {
    try {
      this.#deps.onFailure?.(serviceId, reason);
    } catch {
      // The diagnostics are best effort.
    }
    return null;
  }

  /** The module's reading as the sandbox returned it, or why there is none. */
  async #ask(serviceId: string, snapshot: Snapshot): Promise<Asked> {
    // Twice: the document may have closed itself between the check and the message.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.#open();
      } catch {
        return refused('unavailable');
      }
      this.#seq += 1;
      const id = this.#seq;
      const request: InterpretRequest = {
        v: INTERPRET_VERSION,
        target: INTERPRETER_TARGET,
        type: 'interpret/request',
        id,
        serviceId,
        snapshot,
      };
      let raw: unknown;
      try {
        raw = await within(this.#deps.runtime.sendMessage(request), ANSWER_DEADLINE_MS);
      } catch (error: unknown) {
        if (error instanceof Overdue) {
          await this.#close();
          return refused('timeout');
        }
        continue;
      }
      const answer = v.safeParse(AnswerSchema, raw);
      if (!answer.success || answer.output.id !== id) {
        // Nothing answered (`undefined`: no listener yet), or not an answer to this request.
        if (raw === undefined) continue;
        return refused('invalid');
      }
      const output = answer.output;
      return output.ok ? { ok: true, reading: output.reading } : refused(output.reason);
    }
    return refused('unavailable');
  }

  /** Makes sure the offscreen document exists; one opening at a time. */
  #open(): Promise<void> {
    this.#opening ??= this.#openOnce().finally(() => {
      this.#opening = null;
    });
    return this.#opening;
  }

  async #openOnce(): Promise<void> {
    if (await this.#exists()) return;
    try {
      await within(
        this.#deps.offscreen.createDocument({
          url: OFFSCREEN_PAGE,
          reasons: ['IFRAME_SCRIPTING'],
          justification: JUSTIFICATION,
        }),
        CREATE_DEADLINE_MS,
      );
    } catch (error: unknown) {
      // Another opening (an earlier life of this worker) got there first: as good.
      if (!(await this.#exists())) throw error;
    }
  }

  /** Whether this interpreter's document is open (another offscreen document is not it). */
  async #exists(): Promise<boolean> {
    const contexts = await this.#deps.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [this.#deps.offscreenUrl],
    });
    return contexts.length > 0;
  }

  async #close(): Promise<void> {
    this.#disarmIdle();
    try {
      if (await this.#exists()) await this.#deps.offscreen.closeDocument();
    } catch {
      // Already closed.
    }
  }

  #armIdle(): void {
    this.#disarmIdle();
    if (this.#inFlight > 0) return;
    this.#idle = setTimeout(() => {
      this.#idle = null;
      if (this.#inFlight === 0 && this.#opening === null) void this.#close();
    }, OFFSCREEN_IDLE_MS);
  }

  #disarmIdle(): void {
    if (this.#idle !== null) clearTimeout(this.#idle);
    this.#idle = null;
  }
}
