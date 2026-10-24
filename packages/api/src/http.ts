/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The transport: one request, one answer, and every way it can
// end is a value — a response (any status, any body), a network failure or the 15-second
// deadline. Nothing here decides what an answer means; the token exchange and the plays gateway
// map answers onto outcomes. What comes back is untrusted: a body is read only up to a bound,
// parsed as JSON or not at all, and read through the total readers below.

import { OUTBOX_SLOW_RETRY_MS } from '@mt/core';

import { parseDpopNonce } from './nonce';

/** Every request's deadline, headers and body together. */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The most of a body that is read. The server's answers here are under a kilobyte (the largest,
 * a `422` listing twenty failures, is a few); anything past this is not one of them.
 */
export const MAX_ANSWER_BYTES = 64 * 1024;

/**
 * The most reads a body is given, whatever their size: a stream of empty chunks adds no bytes,
 * and resolves without ever yielding to the deadline's timer. A real body is one or two chunks.
 */
export const MAX_ANSWER_READS = 4096;

/**
 * The longest wait a `retry_after_seconds` is taken at: the outbox's slowest retry. The
 * server's budgets are per minute, so a larger value is not one of its answers — and taken as
 * given, a wait past 29 days would turn a play the server only deferred into a dead letter.
 */
export const MAX_RETRY_AFTER_SECONDS = OUTBOX_SLOW_RETRY_MS / 1000;

export type HttpAnswer =
  | {
      readonly kind: 'response';
      readonly status: number;
      /** The parsed body; `null` when there is none, it is not JSON or it is over the bound. */
      readonly json: unknown;
      readonly headers: Headers;
    }
  /** No answer: `detail` is the error's kind only (`TypeError`), never its message. */
  | { readonly kind: 'network'; readonly detail: string }
  | { readonly kind: 'timeout' };

export interface HttpRequest {
  /** Called unbound, as a browser's `fetch` must be (`window.fetch` as a method is refused). */
  readonly fetch: typeof fetch;
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | URLSearchParams;
  readonly timeoutMs: typeof REQUEST_TIMEOUT_MS;
}

/**
 * Sends one request and answers how it ended — never a throw. The deadline is
 * `AbortSignal.timeout(timeoutMs)` and covers the body as well as the headers: a body still
 * arriving when it fires is a timeout, not a short answer. A body that fails in transit is a
 * network failure. Redirects are refused (the API never redirects, and a followed one would
 * carry the credential elsewhere) and no cookies are sent.
 */
export async function request(input: HttpRequest): Promise<HttpAnswer> {
  const signal = AbortSignal.timeout(input.timeoutMs);
  const init: RequestInit = {
    method: input.method,
    headers: input.headers,
    signal,
    redirect: 'error',
    credentials: 'omit',
  };
  if (input.body !== undefined) init.body = input.body;
  const send = input.fetch;
  try {
    const response = await send(input.url, init);
    const text = await readBounded(response, signal);
    return {
      kind: 'response',
      status: response.status,
      json: parseJson(text),
      headers: response.headers,
    };
  } catch (error: unknown) {
    if (signal.aborted) return { kind: 'timeout' };
    return { kind: 'network', detail: errorKind(error) };
  }
}

/** The deadline ended the body: the stream closed because the deadline cancelled it. */
class DeadlineReached extends Error {
  override readonly name = 'DeadlineReached';
}

/**
 * The body as text, or `null` when it is over `MAX_ANSWER_BYTES` (no more is pulled). Rejects
 * when the body fails in transit or the deadline fires before it ends. The deadline is watched
 * here too: a body that is not wired to the signal (a platform that answers from a cache, a
 * test's `Response`) would otherwise wait forever.
 */
async function readBounded(response: Response, signal: AbortSignal): Promise<string | null> {
  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  // An object, not a `let`: the listener sets it between awaits, where a local's narrowing
  // would not see it.
  const deadline = { reached: false };
  const cancel = (): void => {
    deadline.reached = true;
    reader.cancel().catch(() => undefined);
  };
  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (let reads = 1; ; reads += 1) {
      const { done, value } = await reader.read();
      // A cancelled stream reads as ended: that is the deadline, not the end of the answer.
      if (deadline.reached) throw new DeadlineReached();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ANSWER_BYTES || reads >= MAX_ANSWER_READS) {
        reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

function parseJson(text: string | null): unknown {
  if (text === null || text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** An error's name when it is a plain identifier (`TypeError`), else `unknown`. */
function errorKind(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('name' in error)) return 'unknown';
  const { name } = error;
  return typeof name === 'string' && /^[A-Za-z]{1,40}$/.test(name) ? name : 'unknown';
}

/** A machine code as the server spells one (`scrobbling.credential_invalid`, `plus_required`). */
const ERROR_CODE = /^[a-z][a-z0-9_.]{0,79}$/;

/**
 * `value[key]` when `value` is a (non-array) object that owns `key`; else `undefined`. How every
 * field of an answer is read: an inherited name (`constructor`, `__proto__`) is never a member.
 */
export function member(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.hasOwn(value, key) ? (value as Readonly<Record<string, unknown>>)[key] : undefined;
}

/** The envelope's inner object (`{"error": {...}}`, `WireError`), or `undefined`. */
function envelope(json: unknown): unknown {
  return member(json, 'error');
}

/**
 * The refusal's `error.code`, or `null` when the body is not the envelope or the code is not a
 * machine code — so what reaches a diagnostic is always one.
 */
export function errorCode(json: unknown): string | null {
  const code = member(envelope(json), 'code');
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : null;
}

/**
 * The refusal's `error.retry_after_seconds` — at most `MAX_RETRY_AFTER_SECONDS` — or `null`
 * when it is absent or not a non-negative number.
 */
export function retryAfter(json: unknown): number | null {
  const seconds = member(envelope(json), 'retry_after_seconds');
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

/**
 * The refusal asks for a new proof with the server's nonce (RFC 9449 §8–9): the code both doors
 * answer it with, or the OAuth error the token endpoint carries in `details.error`.
 */
export function asksForNonce(json: unknown): boolean {
  const error = envelope(json);
  return (
    member(error, 'code') === 'scrobbling.dpop_nonce_required' ||
    member(member(error, 'details'), 'error') === 'use_dpop_nonce'
  );
}

/**
 * The nonce to retry with: the answer is the door's refusal that asks for one (`status`: the
 * token endpoint's `400`, a resource's `401`) and hands one over. `null` for every other answer.
 */
export function handedNonce(answer: HttpAnswer, status: 400 | 401): string | null {
  if (answer.kind !== 'response' || answer.status !== status || !asksForNonce(answer.json)) {
    return null;
  }
  return parseDpopNonce(answer.headers.get('DPoP-Nonce'));
}

/** Why there was no answer, for the diagnostics log: the transport's word for it. */
export function noAnswer(answer: Exclude<HttpAnswer, { kind: 'response' }>): string {
  return answer.kind === 'timeout' ? 'timeout' : `network:${answer.detail}`;
}

/**
 * `path` under the configured base URL, whatever trailing slashes the base has. The base is
 * the configured public API (or web app) URL; `htu` is built from what this returns, never
 * from an answer.
 */
export function apiUrl(base: string, path: string): string {
  let end = base.length;
  while (end > 0 && base.charCodeAt(end - 1) === 0x2f) end -= 1;
  return `${base.slice(0, end)}${path}`;
}
