/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the mock answers with: its routes and the server's numbers, one request in flight
// (`Exchange`), the mock's state as every route reads it (`Ctx`), the server's one error
// envelope, and each refusal the server gives, built as the server builds it.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { isoformatUtc } from './datetime.ts';
import type { Errors } from './evidence.ts';
import { DAY_MS, HOUR_MS, MAX_CONNECTIONS } from './state.ts';
import type { Decided, MockState, RecordedPlay } from './state.ts';

// ── routes and the server's numbers ──────────────────────────────────────────────────────────

export const APPROVAL_PATH = '/connect/extension';
export const TEST_APPROVE_PATH = '/__test/approve';
export const TOKEN_PATH = '/v1/integrations/oauth/token';
export const PLAYS_PATH = '/v1/integrations/plays';
/** Starlette's `{scrobble_id}`: one non-empty segment of the decoded path. */
export const RECEIPT_PATH = /^\/v1\/integrations\/plays\/([^/]+)$/;
export const CONNECTION_PATH = '/v1/integrations/connection';

/** `request_body_max_bytes`, and `ROUTE_BODY_LIMITS`' entry for the plays route. */
export const DEFAULT_BODY_LIMIT = 64 * 1024;
export const PLAYS_BODY_LIMIT = 16 * 1024;

/** `EXEMPT_ROUTE_TEMPLATES` that apply here, and the mock's own browser form. */
export const IDEMPOTENCY_EXEMPT = new Set([TOKEN_PATH, APPROVAL_PATH]);
export const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The failure buckets (`ip_failure_limit(30, …)` on each door). */
export const FAILURES_PER_MINUTE = 30;
export type FailureBucket =
  'integration_token_writes' | 'integration_failure_writes' | 'integration_failure_reads';

/** `_WWW_AUTHENTICATE`: the same for every failure, whatever was presented. */
const WWW_AUTHENTICATE = 'Bearer, DPoP algs="ES256"';
/** `CAPACITY_RETRY_AFTER_SECONDS`. */
const CAPACITY_RETRY_AFTER_SECONDS = 2;
export const DEFAULT_RETRY_AFTER_SECONDS = 30;
/** `WATCHED_AT_MAX_AGE`, `WATCHED_AT_MAX_AHEAD`. */
export const WATCHED_AT_MAX_AGE_MS = 30 * DAY_MS;
export const WATCHED_AT_MAX_AHEAD_MS = 24 * HOUR_MS;

// ── answers ──────────────────────────────────────────────────────────────────────────────────

export type Header = readonly [string, string];

export interface Answer {
  readonly status: number;
  readonly headers: readonly Header[];
  readonly body: string;
}

/** One request in flight. */
export interface Exchange {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly requestId: string;
  /** The percent-decoded path, as Starlette routes on it; `''` for a target that is not one. */
  readonly path: string;
  /** The raw query, without its `?`. */
  readonly query: string;
  /** The nonce a verified proof earned: every answer to this request carries it. */
  offeredNonce: string | null;
}

// ── forced answers (script.ts reads a `MockScript` into them) ─────────────────────────────────

/** The most forced answers queued per route. */
export const MAX_FORCED = 1000;

export type Stage = 'arrival' | 'verified';
type Act =
  | { readonly kind: 'answer'; readonly build: Build }
  /** The connection is destroyed without an answer: a network error. */
  | { readonly kind: 'drop' }
  /** No answer until the client gives up or the mock closes (holding the key, on the plays route). */
  | { readonly kind: 'hang' }
  /** The play is judged and stored as usual; its answer is lost on the way (the connection dropped). */
  | { readonly kind: 'lost' };

export interface Forced {
  readonly stage: Stage;
  readonly act: Act;
}

/** One route's forced answers, consumed from the front. */
export class ForcedQueue {
  #items: Forced[] = [];
  #head = 0;

  push(items: readonly Forced[]): void {
    if (this.#items.length - this.#head + items.length > MAX_FORCED) {
      throw new RangeError(`a MockScript queues at most ${String(MAX_FORCED)} answers per route`);
    }
    for (const item of items) this.#items.push(item);
  }

  /** The head, when it is given at `stage`; it is then consumed. */
  take(stage: Stage): Forced | null {
    const head = this.#items[this.#head];
    if (head?.stage !== stage) return null;
    this.#head += 1;
    if (this.#head > 64 && this.#head * 2 > this.#items.length) {
      this.#items = this.#items.slice(this.#head);
      this.#head = 0;
    }
    return head;
  }
}

/** The mock as every route reads it: its state, its public URL, the forced answers queued. */
export interface Ctx {
  readonly state: MockState;
  publicUrl: string;
  readonly queues: {
    readonly token: ForcedQueue;
    readonly plays: ForcedQueue;
    readonly receipts: ForcedQueue;
    readonly connection: ForcedQueue;
  };
  progression: (play: RecordedPlay, decided: Decided) => unknown;
  held: number;
}

/** What a route decided: an answer to send, a forced act to perform, or nothing (the client left). */
export type Outcome = Answer | Forced | null;

export function json(status: number, value: unknown, headers: readonly Header[] = []): Answer {
  return {
    status,
    headers: [['Content-Type', 'application/json'], ...headers],
    body: JSON.stringify(value),
  };
}

interface RefusalExtra {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryAfterSeconds?: number;
  readonly headers?: readonly Header[];
}

/**
 * The one envelope (`_envelope`, `application_error_response`): `code`, `message` (the code when
 * there is none), `request_id`; `details` only when it has a member, `retry_after_seconds` only
 * when given, with `Retry-After` beside it.
 */
export function refusal(
  x: Exchange,
  status: number,
  code: string,
  message: string,
  extra: RefusalExtra = {},
): Answer {
  const error: Record<string, unknown> = { code, message: message === '' ? code : message };
  error.request_id = x.requestId;
  if (extra.details !== undefined && Object.keys(extra.details).length > 0) {
    error.details = extra.details;
  }
  if (extra.retryAfterSeconds !== undefined) error.retry_after_seconds = extra.retryAfterSeconds;
  const headers: Header[] = [...(extra.headers ?? [])];
  if (extra.retryAfterSeconds !== undefined && extra.retryAfterSeconds > 0) {
    headers.push(['Retry-After', String(extra.retryAfterSeconds)]);
  }
  return json(status, { error }, headers);
}

export type Build = (x: Exchange, ctx: Ctx) => Answer;

const NONCE_MESSAGE = "use the DPoP-Nonce header's nonce in a new proof";

export const featureClosed: Build = (x) => refusal(x, 404, 'resource.not_found', '');
export const credentialInvalid: Build = (x) =>
  refusal(x, 401, 'scrobbling.credential_invalid', 'scrobbler credential invalid', {
    headers: [['WWW-Authenticate', WWW_AUTHENTICATE]],
  });
/** `_dpop_nonce_refusal`: a resource door's `401`, with a fresh nonce. */
export const doorNonceRequired: Build = (x, ctx) =>
  refusal(x, 401, 'scrobbling.dpop_nonce_required', NONCE_MESSAGE, {
    headers: [
      ['WWW-Authenticate', 'DPoP error="use_dpop_nonce", algs="ES256"'],
      ['DPoP-Nonce', ctx.state.nonces.issue(ctx.state.now())],
    ],
  });
/** `TokenDpopNonceRequired`: the token endpoint's `400`, `details.error = use_dpop_nonce`. */
export const tokenNonceRequired: Build = (x, ctx) =>
  refusal(x, 400, 'scrobbling.dpop_nonce_required', NONCE_MESSAGE, {
    details: { error: 'use_dpop_nonce' },
    headers: [
      ['DPoP-Nonce', ctx.state.nonces.issue(ctx.state.now())],
      ['Cache-Control', 'no-store'],
    ],
  });
export const proofInvalid: Build = (x) =>
  refusal(x, 400, 'scrobbling.dpop_proof_invalid', 'the DPoP proof is invalid');
export const codeInvalid: Build = (x) =>
  refusal(x, 400, 'scrobbling.authorization_code_invalid', 'authorization code invalid');
export const plusRequired: Build = (x) =>
  refusal(x, 403, 'plus_required', 'connecting a service requires Plus');
export const sessionNotFresh: Build = (x) =>
  refusal(x, 403, 'scrobbling.session_not_fresh', 'this device is no longer signed in');
export const limitReached: Build = (x) =>
  refusal(x, 409, 'scrobbling.scrobbler_limit_reached', 'at most 10 connected services', {
    details: { limit: MAX_CONNECTIONS },
  });
export const rateLimited =
  (capacity: number, seconds: number, count = capacity): Build =>
  (x) =>
    refusal(x, 429, 'rate_limit.exceeded', 'rate limit exceeded', {
      details: { bucket_capacity: capacity, count },
      retryAfterSeconds: seconds,
    });
/** `record_jti(outage="refuse")`'s `ServiceUnavailable` at the token endpoint. */
export const replayCheckUnavailable: Build = (x) =>
  refusal(x, 503, 'service.unavailable', 'the replay check is unavailable', {
    details: { resource: 'cache' },
  });
/** `capacity_response`'s two refusals. */
export const unavailable: Build = (x) =>
  refusal(x, 503, 'service.unavailable', 'a dependency is temporarily unavailable; retry shortly', {
    details: { resource: 'cache' },
    retryAfterSeconds: CAPACITY_RETRY_AFTER_SECONDS,
  });
export const overloaded: Build = (x) =>
  refusal(x, 503, 'service.overloaded', 'service temporarily at capacity; retry shortly', {
    details: { resource: 'database' },
    retryAfterSeconds: CAPACITY_RETRY_AFTER_SECONDS,
  });
export const internalError: Build = (x) =>
  refusal(x, 500, 'internal.error', 'internal server error');
export const deadline: Build = (x) =>
  refusal(x, 504, 'request.deadline_exceeded', 'request exceeded its time budget');
export const tooLarge =
  (limit: number): Build =>
  (x) =>
    refusal(x, 413, 'request.body_too_large', 'request body exceeds the limit for this route', {
      details: { max_bytes: limit },
      headers: [['Connection', 'close']],
    });
export const keyRequired: Build = (x) =>
  refusal(x, 400, 'idempotency.key_required', 'Idempotency-Key header is required');
export const keyMalformed: Build = (x) =>
  refusal(x, 400, 'idempotency.key_malformed', 'Idempotency-Key must be a UUID');
export const inFlight: Build = (x) =>
  refusal(x, 409, 'idempotency.in_flight', 'Concurrent request with same key in flight');
const ALREADY_APPLIED_MESSAGE =
  'this operation was already applied; its response is no longer available — refetch the ' +
  'resource, do not retry';
export const alreadyApplied: Build = (x) =>
  refusal(x, 409, 'idempotency.already_applied', ALREADY_APPLIED_MESSAGE);
const MISMATCH_MESSAGE = 'Idempotency-Key already used with a different request body';
export const bodyMismatch: Build = (x) =>
  refusal(x, 422, 'idempotency.body_mismatch', MISMATCH_MESSAGE);
export const validationFailed =
  (errors: Errors): Build =>
  (x) =>
    refusal(x, 422, 'validation.failed', 'request validation failed', {
      details: { errors: errors.errors, error_count: errors.count },
    });
export const forcedValidation: Build = validationFailed({
  errors: [{ loc: ['body'], type: 'value_error', msg: 'Value error, refused by the mock script' }],
  count: 1,
});
/** `checked_watched_at`'s refusal: both bounds, as the receipt time allowed them. */
export const watchedAtOutOfRange: Build = (x, ctx) => {
  const now = ctx.state.now();
  return refusal(
    x,
    422,
    'scrobbling.watched_at_out_of_range',
    'watched_at must be at most 30 days before the play arrives and at most 24 hours after',
    {
      details: {
        field: 'watched_at',
        earliest: isoformatUtc(now - WATCHED_AT_MAX_AGE_MS),
        latest: isoformatUtc(now + WATCHED_AT_MAX_AHEAD_MS),
        max_age_days: 30,
        max_ahead_hours: 24,
      },
    },
  );
};
export const httpError =
  (status: 400 | 404 | 405, message: string): Build =>
  (x) =>
    refusal(x, status, 'http.error', message);
