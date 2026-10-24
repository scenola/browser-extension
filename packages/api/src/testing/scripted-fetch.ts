/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A `fetch` that answers from a script, for the transport's tests: it records every request
// as it was handed over and answers the next scripted step. It is called the way a browser's
// `fetch` must be — unbound: a `fetch` taken from `window` or `self` and called as a method of
// another object throws "Illegal invocation", so this one does too.

import { EmbeddedJWK, base64url, jwtVerify } from 'jose';

/** One request, as the code under test handed it to `fetch`. */
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  /** The headers as passed (the object itself), to count spellings of one name. */
  readonly rawHeaders: unknown;
  readonly headers: Headers;
  readonly body: string | null;
  readonly init: RequestInit;
}

/** A step: an answer, a rejection (a network error), or a function of the request. */
export type Step =
  | Response
  | Error
  | ((request: RecordedRequest, signal: AbortSignal | null) => Response | Promise<Response>);

export interface ScriptedFetch {
  readonly fetch: typeof fetch;
  readonly calls: readonly RecordedRequest[];
}

export function scriptedFetch(steps: readonly Step[]): ScriptedFetch {
  const calls: RecordedRequest[] = [];
  let next = 0;
  function stub(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (this !== undefined) return Promise.reject(new TypeError('Illegal invocation'));
    const given = init ?? {};
    const body = given.body;
    calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: given.method ?? 'GET',
      rawHeaders: given.headers,
      headers: new Headers(given.headers),
      body:
        typeof body === 'string' ? body : body instanceof URLSearchParams ? body.toString() : null,
      init: given,
    });
    const step = steps[next];
    next += 1;
    if (step === undefined) return Promise.reject(new Error('the script has no answer left'));
    if (step instanceof Error) return Promise.reject(step);
    if (step instanceof Response) return Promise.resolve(step);
    const recorded = calls[calls.length - 1];
    if (recorded === undefined) return Promise.reject(new Error('unreachable'));
    return Promise.resolve(step(recorded, given.signal ?? null));
  }
  return { fetch: stub, calls };
}

/** A JSON answer. */
export function answer(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** The server's error envelope (`{error: {code, message, …}}`). */
export function refusal(
  status: number,
  code: string,
  extra: { details?: Record<string, unknown>; retry_after_seconds?: number } = {},
  headers: Readonly<Record<string, string>> = {},
): Response {
  return answer(status, { error: { code, message: code, request_id: 'r-1', ...extra } }, headers);
}

/** A `fetch` that never answers until its signal aborts, then rejects as `fetch` does. */
export function hangsUntilAborted(_request: RecordedRequest, signal: AbortSignal | null) {
  return new Promise<Response>((_resolve, reject) => {
    if (signal === null) {
      reject(new Error('no signal was passed'));
      return;
    }
    signal.addEventListener('abort', () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    });
  });
}

/** What a proof says, verified as a DPoP server begins to: its own key, ES256, `dpop+jwt`. */
export async function proofClaims(proof: string | null) {
  if (proof === null) throw new Error('no DPoP header');
  const { payload, protectedHeader } = await jwtVerify(proof, EmbeddedJWK, {
    typ: 'dpop+jwt',
    algorithms: ['ES256'],
  });
  return { payload, protectedHeader };
}

/** RFC 9449's `ath`: BASE64URL(SHA-256(ASCII(token))), computed here independently. */
export async function athOf(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return base64url.encode(new Uint8Array(digest));
}

/** How many of the passed header names spell `name`, in any case. */
export function spellings(rawHeaders: unknown, name: string): number {
  if (typeof rawHeaders !== 'object' || rawHeaders === null) return 0;
  return Object.keys(rawHeaders).filter((key) => key.toLowerCase() === name.toLowerCase()).length;
}
