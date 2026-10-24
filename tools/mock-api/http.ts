/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// HTTP plumbing: an answer sent with the layers outside the route, a forced act performed, a body
// read within its limit and read as FastAPI reads it, and the path as uvicorn decodes it.

import type { IncomingMessage } from 'node:http';

import { httpError, validationFailed } from './answers.ts';
import type { Answer, Build, Ctx, Exchange, Forced, Outcome } from './answers.ts';

/** An outcome delivered: an answer sent, a forced act performed, or nothing (the client left). */
export async function deliver(x: Exchange, ctx: Ctx, outcome: Outcome): Promise<void> {
  if (outcome === null) return;
  if ('act' in outcome) await perform(x, ctx, outcome);
  else send(x, outcome);
}

/** A forced answer for a route that holds no key. */
export async function perform(x: Exchange, ctx: Ctx, forced: Forced): Promise<void> {
  switch (forced.act.kind) {
    case 'answer':
      send(x, forced.act.build(x, ctx));
      return;
    case 'hang':
      await holdUntilClosed(x, ctx);
      return;
    case 'drop':
    case 'lost':
      x.req.socket.destroy();
      return;
  }
}

/** No answer: the request is held until its client gives up or the mock closes. */
export async function holdUntilClosed(x: Exchange, ctx: Ctx): Promise<void> {
  ctx.held += 1;
  try {
    await new Promise<void>((resolve) => {
      if (x.res.closed || x.req.socket.destroyed) {
        resolve();
        return;
      }
      x.res.once('close', () => {
        resolve();
      });
    });
  } finally {
    ctx.held -= 1;
  }
}

/**
 * Sends `answer` with the layers outside the route: `X-Request-Id`; `Cache-Control: no-store`
 * unless the answer names one; and the `DPoP-Nonce` a verified proof earned, unless the answer
 * carries its own (`DpopNonceMiddleware`, outside the idempotency layer — so a replay, which
 * verified nothing, carries none).
 */
export function send(x: Exchange, answer: Answer): void {
  const { res } = x;
  if (res.headersSent || res.destroyed) return;
  for (const [name, value] of answer.headers) res.setHeader(name, value);
  res.setHeader('X-Request-Id', x.requestId);
  if (!res.hasHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
  if (x.offeredNonce !== null && !res.hasHeader('DPoP-Nonce')) {
    res.setHeader('DPoP-Nonce', x.offeredNonce);
  }
  res.setHeader('Content-Length', Buffer.byteLength(answer.body));
  res.writeHead(answer.status);
  res.end(answer.body);
}

/** Node joins repeated headers it does not know; `headersDistinct` keeps them apart. */
export function firstHeader(req: IncomingMessage, name: string): string | undefined {
  return req.headersDistinct[name]?.[0];
}

/** A declared `Content-Length` over `limit` is refused before anything is read. */
export function declaredOver(req: IncomingMessage, limit: number): boolean {
  const declared = req.headers['content-length'];
  if (declared === undefined) return false;
  const n = Number(declared);
  return !Number.isSafeInteger(n) || n < 0 || n > limit;
}

type Body = Buffer | 'too_large' | 'aborted';

/** The body, counted as it streams: `too_large` the moment it passes `limit`. */
export function readBody(req: IncomingMessage, limit: number): Promise<Body> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (value: Body): void => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        req.pause();
        settle('too_large');
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.once('end', () => {
      settle(Buffer.concat(chunks, size));
    });
    req.once('error', () => {
      settle('aborted');
    });
    req.once('close', () => {
      settle(req.complete ? Buffer.concat(chunks, size) : 'aborted');
    });
  });
}

/** A body FastAPI kept as bytes (not a JSON media type): no model takes it (`model_type`). */
const NOT_JSON = Symbol('a body that is not JSON');

type JsonBody =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'missing' }
  /** Refused before any dependency runs: the body could not be read as JSON. */
  | { readonly kind: 'refused'; readonly build: Build };

/**
 * FastAPI's body read: nothing → missing; a JSON media type (`application/json`, `…+json`) →
 * parsed (a BOM is accepted, as Python's `json.loads` of bytes accepts it); anything else → the
 * bytes themselves, which the model then refuses. A body that is not UTF-8 is `400`, invalid JSON
 * `422 json_invalid` — neither echoes what was sent.
 */
export function jsonBody(contentType: string | undefined, bytes: Buffer): JsonBody {
  if (bytes.length === 0) return { kind: 'missing' };
  const media = mediaType(contentType);
  const slash = media.indexOf('/');
  const subtype = media.slice(slash + 1);
  const isJson =
    media.slice(0, slash) === 'application' && (subtype === 'json' || subtype.endsWith('+json'));
  if (!isJson) return { kind: 'value', value: NOT_JSON };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { kind: 'refused', build: httpError(400, 'There was an error parsing the body') };
  }
  try {
    return { kind: 'value', value: JSON.parse(text) as unknown };
  } catch (error: unknown) {
    const at = /position (\d{1,9})/.exec(error instanceof Error ? error.message : '');
    const position = at === null ? 0 : Number(at[1]);
    const decodeError = {
      loc: ['body', position],
      type: 'json_invalid',
      msg: 'JSON decode error',
      ctx: { error: 'Expecting value' },
    };
    return { kind: 'refused', build: validationFailed({ errors: [decodeError], count: 1 }) };
  }
}

/** `email.message`'s content type: `type/subtype` lowercased, `text/plain` when it is not one. */
export function mediaType(contentType: string | undefined): string {
  const media = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return media.split('/').length === 2 ? media : 'text/plain';
}

/** `urllib.parse.unquote` (what uvicorn makes `scope["path"]` with): `%XX` runs as UTF-8. */
export function unquote(text: string): string {
  if (!text.includes('%')) return text;
  const out: string[] = [];
  const bytes: number[] = [];
  const flush = (): void => {
    if (bytes.length > 0) out.push(Buffer.from(bytes).toString('utf8'));
    bytes.length = 0;
  };
  let i = 0;
  while (i < text.length) {
    const hex = text.slice(i + 1, i + 3);
    if (text.charAt(i) === '%' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 3;
    } else {
      flush();
      out.push(text.charAt(i));
      i += 1;
    }
  }
  flush();
  return out.join('');
}
