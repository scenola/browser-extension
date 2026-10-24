/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The plays gateway: `POST /v1/integrations/plays` under the play's
// own `Idempotency-Key`, and `GET /v1/integrations/plays/{scrobble_id}` for its receipt, each
// answer mapped onto what the outbox and the receipt reader decide from.
//
// Two mistakes cost the most and the mapping is built against both: losing a play (a dead
// letter for an answer that judged nothing about it, or "done" for one that was never stored)
// and retrying one that cannot succeed. So a play is dead-lettered only for the server's own
// refusal of it — a `413`, a `422`, or a `4xx` in the server's envelope; a `4xx` without one (a
// WAF's or a CDN's `403`, a `405` from a misrouted base) judged nothing about the play — "done"
// only on the route's own `202` (or the server's word that it is stored), and everything else
// is retried under the same key — which the server deduplicates — within the outbox's 29 days.
// A reconnect, which spends one of the person's ten connections, follows
// `401 scrobbling.credential_invalid` or a key that cannot sign, and nothing else.

import type {
  ConnectionCheckResult,
  ConnectionGateway,
  ConnectionStatus,
  PlayBody,
  PlaysGateway,
  ReceiptResult,
  ReceiptState,
  SendResult,
} from '@mt/core';
import { MAX_BODY_BYTES, MAX_DATE_MS, readAccountRule } from '@mt/core';

import {
  REQUEST_TIMEOUT_MS,
  apiUrl,
  asksForNonce,
  errorCode,
  handedNonce,
  member,
  noAnswer,
  request,
  retryAfter,
} from './http';
import type { HttpAnswer } from './http';
import { ProtocolInputError } from './input-error';
import type { ProtocolFault } from './input-error';
import type { RequestSigner } from './signer';

const PLAYS_PATH = '/v1/integrations/plays';
const CONNECTION_PATH = '/v1/integrations/connection';

/** The statuses the connection route answers a credential that can ask. */
const CONNECTION_STATUSES: Readonly<Record<ConnectionStatus, true>> = {
  active: true,
  braked: true,
  suspended: true,
};

/**
 * An instant as the server writes one (RFC 3339: a date, a time, an optional fraction, then `Z`
 * or an offset). A time without an offset names no instant, so it is not one. Bounded: no more
 * digits of a fraction than a clock has.
 */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * The local refusals that mean the credential or its key cannot be presented: the connection
 * must be made again (a connection is re-made only when it is needed). Every other
 * `ProtocolInputError` is a bug in a caller, thrown before anything is sent.
 */
const RECONNECT: ReadonlySet<ProtocolFault> = new Set(['bad_key', 'bad_jwk', 'bad_access_token']);

/** A play id: a UUID, as `Idempotency-Key` takes one (the server parses it with `uuid.UUID`). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The server's id pattern: 26 Crockford base32 characters in
 * either case, with the aliases `I L O`, the first worth at most 7. Nothing else is a scrobble
 * or title id, and nothing else ever becomes a path segment.
 */
const MT_ID = /^[0-7IiLlOo][0-9A-TV-Za-tv-z]{25}$/;

/** A reason as the server spells one (`plus_lapsed`, `numbering_unconfirmed`). */
const REASON = /^[a-z][a-z_]{0,63}$/;

/** Every state the domain maps: exhaustive and exact, checked by the compiler. */
const RECEIPT_STATES: Readonly<Record<ReceiptState, true>> = {
  received: true,
  awaiting_catalog: true,
  needs_confirmation: true,
  held: true,
  recorded: true,
  duplicate: true,
  started: true,
  ignored: true,
  dismissed: true,
  expired: true,
};

export interface PlaysGatewayDeps {
  readonly fetch: typeof fetch;
  /** The configured public API base URL; `htu` is built from it, never from an answer. */
  readonly apiBase: string;
  /**
   * The current connection's signer, read once per send or receipt (its retry reuses it);
   * `null` when no credential or key is stored — which is a connection to make again.
   */
  readonly signer: () => Promise<RequestSigner | null>;
}

/** The plays, their receipts and the connection check: one credential, one signer, one nonce. */
export function createPlaysGateway(deps: PlaysGatewayDeps): PlaysGateway & ConnectionGateway {
  return {
    send: (playId, body) => send(deps, playId, body),
    receipt: (scrobbleId) => receipt(deps, scrobbleId),
    check: () => check(deps),
  };
}

/**
 * One play. Rejects only for a bug, before anything is sent: a play id that is not a UUID
 * (`RangeError`), or a proof input the server would refuse (`ProtocolInputError`).
 */
async function send(deps: PlaysGatewayDeps, playId: string, body: PlayBody): Promise<SendResult> {
  if (!isUuid(playId)) throw new RangeError('a play id is a UUID');
  const json = JSON.stringify(body);
  // The server answers a body over 16 KiB with a 413 before reading it; it is answered so here,
  // without sending what can never be accepted.
  if (new TextEncoder().encode(json).byteLength > MAX_BODY_BYTES) {
    return { kind: 'rejected', status: 413, code: null };
  }
  const signer = await deps.signer();
  if (signer === null) return { kind: 'credential_invalid' };
  const answer = await signed(deps, signer, 'POST', apiUrl(deps.apiBase, PLAYS_PATH), {
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': playId },
    body: json,
  });
  return answer === null ? { kind: 'credential_invalid' } : sendResult(answer);
}

async function receipt(deps: PlaysGatewayDeps, scrobbleId: string): Promise<ReceiptResult> {
  // Not an id the server minted (storage held something else): it has no receipt by that name,
  // and the value never reaches a URL.
  if (!isMtId(scrobbleId)) return { kind: 'not_found' };
  const signer = await deps.signer();
  if (signer === null) return { kind: 'credential_invalid' };
  const url = apiUrl(deps.apiBase, `${PLAYS_PATH}/${scrobbleId}`);
  const answer = await signed(deps, signer, 'GET', url, { headers: {} });
  return answer === null ? { kind: 'credential_invalid' } : receiptResult(answer, scrobbleId);
}

/** `GET /v1/integrations/connection`, signed as a receipt read is. */
async function check(deps: PlaysGatewayDeps): Promise<ConnectionCheckResult> {
  const signer = await deps.signer();
  if (signer === null) return { kind: 'credential_invalid' };
  const url = apiUrl(deps.apiBase, CONNECTION_PATH);
  const answer = await signed(deps, signer, 'GET', url, { headers: {} });
  return answer === null ? { kind: 'credential_invalid' } : checkResult(answer);
}

/**
 * The request, signed, and retried once — with a fresh proof carrying the nonce that answer
 * handed over — when the answer is `401 scrobbling.dpop_nonce_required` with a nonce to use.
 * The retry signs with the answer's own `DPoP-Nonce`, never one read back from
 * the store: a store that cannot keep it would otherwise send the retry without it, and the
 * play would wait for the backoff. `null` when the signer cannot present the credential (a
 * reconnect). Every answer's headers reach the signer, which keeps their nonce for later.
 */
async function signed(
  deps: PlaysGatewayDeps,
  signer: RequestSigner,
  method: 'GET' | 'POST',
  url: string,
  extra: { readonly headers: Readonly<Record<string, string>>; readonly body?: string },
): Promise<HttpAnswer | null> {
  const attempt = async (nonce?: string): Promise<HttpAnswer | null> => {
    const auth = await authenticate(signer, method, url, nonce);
    if (auth === null) return null;
    const answer = await request({
      fetch: deps.fetch,
      url,
      method,
      headers: { ...extra.headers, ...auth },
      ...(extra.body === undefined ? {} : { body: extra.body }),
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (answer.kind === 'response') {
      try {
        await signer.onAnswer(answer.headers);
      } catch {
        // A nonce that could not be kept costs one retry later; it never turns an answer —
        // a play stored, perhaps — into a fault that would send it again.
      }
    }
    return answer;
  };
  const first = await attempt();
  // `401 dpop_nonce_required` handing a nonce over is the one answer retried here.
  const nonce = first === null ? null : handedNonce(first, 401);
  if (nonce === null) return first;
  return attempt(nonce);
}

async function authenticate(
  signer: RequestSigner,
  method: string,
  url: string,
  nonce: string | undefined,
): Promise<Record<string, string> | null> {
  try {
    return await signer.headers(method, url, nonce);
  } catch (error: unknown) {
    if (error instanceof ProtocolInputError && RECONNECT.has(error.reason)) return null;
    throw error;
  }
}

/** What a play's POST answer means; total over statuses and bodies. */
function sendResult(answer: HttpAnswer): SendResult {
  if (answer.kind !== 'response') return unavailable(noAnswer(answer));
  const { status, json } = answer;
  const code = errorCode(json);
  switch (status) {
    case 202:
      return accepted(json);
    case 401:
      if (code === 'scrobbling.credential_invalid') return { kind: 'credential_invalid' };
      // A nonce asked for again (the retry was spent) or without one to use, or a 401 that is
      // neither of the route's: retried later under the same key, never a reconnect.
      return unavailable(asksForNonce(json) ? 'nonce_refused' : 'http_401');
    case 404:
      // The server's 404 (the feature closed) is in its envelope; one without it is a proxy's
      // or a path routed elsewhere, which says nothing about the feature.
      return code === null ? unavailable('http_404') : { kind: 'feature_closed' };
    case 408:
      // RFC 9110 §15.5.9: the request was not received in time and may be repeated.
      return unavailable('http_408');
    case 409:
      if (code === 'idempotency.already_applied') return { kind: 'already_applied' };
      if (code === 'idempotency.in_flight') return { kind: 'in_flight' };
      break;
    case 429: {
      const seconds = retryAfter(json);
      return seconds === null
        ? unavailable('http_429')
        : { kind: 'rate_limited', retryAfterSeconds: seconds };
    }
  }
  if (refusesThePlay(status, code)) return { kind: 'rejected', status, code };
  return unavailable(`http_${String(status)}`);
}

/**
 * A `4xx` that judged the play, so the same play would be refused again: a `413` (over the
 * cap — a proxy's `413` says the same of the body), a `422` (a field failed its rule), or any
 * other `4xx` in the server's envelope (`code` is one). A `4xx` without the envelope came from
 * something in between — a WAF's or a CDN's `403`, a `405` from a base that routes elsewhere —
 * and said nothing about the play: it is retried, and the outbox's 29 days bound it.
 */
function refusesThePlay(status: number, code: string | null): boolean {
  if (status < 400 || status >= 500) return false;
  return status === 413 || status === 422 || code !== null;
}

/**
 * The route's `202`. Accepted only from a body that is the route's answer: a `scrobble_id`
 * that is an id or `null` (a play not kept — the plays API's "A play that is not kept": done, never
 * retried) and a `state`. A state this version does not know is the server's word that the play
 * is stored with an answer this version cannot read — done, as `already_applied`; a body that
 * is not the answer at all is no answer, and the play is sent again under its key. A reason
 * that is not one is dropped: it is shown, never decided from.
 */
function accepted(json: unknown): SendResult {
  const id = member(json, 'scrobble_id');
  const state = member(json, 'state');
  if (!(id === null || isMtId(id)) || typeof state !== 'string') {
    return unavailable('http_202_unreadable');
  }
  if (!isReceiptState(state)) return { kind: 'already_applied' };
  return { kind: 'accepted', scrobbleId: id, state, reason: readReason(member(json, 'reason')) };
}

/**
 * What a receipt read means; total: anything but a readable receipt for this play is a read to
 * make again, and says why for the diagnostics log (`detail`).
 */
function receiptResult(answer: HttpAnswer, scrobbleId: string): ReceiptResult {
  if (answer.kind !== 'response') return unavailable(noAnswer(answer));
  const { status, json } = answer;
  // `not_found` ends a play's tracking for good, so only the server's own 404 — in
  // its envelope — may say it. One without it (a proxy, a misrouted path) is a read to retry.
  if (status === 404) {
    return errorCode(json) === null ? unavailable('http_404') : { kind: 'not_found' };
  }
  if (status === 401 && errorCode(json) === 'scrobbling.credential_invalid') {
    return { kind: 'credential_invalid' };
  }
  if (status !== 200) return unavailable(refusedAt(status, json));
  const id = member(json, 'scrobble_id');
  const state = member(json, 'state');
  // Another play's receipt must never become this one's.
  if (isMtId(id) && canonicalId(id) !== canonicalId(scrobbleId)) {
    return unavailable('http_200_other_play');
  }
  if (!isMtId(id) || typeof state !== 'string' || !isReceiptState(state)) {
    return unavailable('http_200_unreadable');
  }
  const titleId = member(json, 'title_id');
  const questionKey = member(json, 'question_key');
  return {
    kind: 'ok',
    state,
    reason: readReason(member(json, 'reason')),
    titleId: isMtId(titleId) ? titleId : null,
    // Opaque: kept whole and never read, only compared. Anything but a short text is no key.
    questionKey:
      typeof questionKey === 'string' && questionKey !== '' && questionKey.length <= 200
        ? questionKey
        : null,
  };
}

/**
 * What a connection check means; total. Only the route's own `401 scrobbling.credential_invalid` says the
 * connection is over (revoked, expired, rotated out); a `200` is an answer only when it is the
 * route's — a status the domain knows and an expiry that is an instant or `null`. Anything else
 * is no answer, and says why for the diagnostics log.
 */
function checkResult(answer: HttpAnswer): ConnectionCheckResult {
  if (answer.kind !== 'response') return unavailable(noAnswer(answer));
  const { status, json } = answer;
  if (status === 401 && errorCode(json) === 'scrobbling.credential_invalid') {
    return { kind: 'credential_invalid' };
  }
  if (status !== 200) return unavailable(refusedAt(status, json));
  const stated = member(json, 'status');
  const expiresAt = readInstant(member(json, 'expires_at'));
  if (typeof stated !== 'string' || !Object.hasOwn(CONNECTION_STATUSES, stated)) {
    return unavailable('http_200_unreadable');
  }
  if (expiresAt === undefined) return unavailable('http_200_unreadable');
  // Which account the connection acts for: without it nothing may be sent, so an answer that
  // does not say it is no answer. Opaque — kept whole, never read into.
  const accountKey = member(json, 'account_key');
  if (!isAccountKey(accountKey)) return unavailable('http_200_unreadable');
  // The account's rule rides on the same answer. What it cannot read turns starts off and is
  // named for the log; it never makes the status and the expiry no answer.
  const { rule, invalid } = readAccountRule(
    member(json, 'start_threshold_percent'),
    member(json, 'start_floor_seconds'),
    member(json, 'finish_threshold_percent'),
  );
  return {
    kind: 'ok',
    status: stated as ConnectionStatus,
    expiresAt,
    rule,
    accountKey,
    ...(invalid.length === 0 ? {} : { ruleInvalid: invalid }),
  };
}

/** The most an `account_key` may be: the server's are 35 characters; anything far longer is not one. */
const ACCOUNT_KEY_MAX = 128;

/** An `account_key` as stated: a non-empty string of visible ASCII, bounded. Its form is the server's. */
function isAccountKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= ACCOUNT_KEY_MAX &&
    /^[\x21-\x7e]+$/u.test(value)
  );
}

/**
 * An RFC 3339 instant as epoch milliseconds; `null` for JSON `null` (no end); `undefined` for
 * anything else — absent, not a string, a local time, a date `Date` cannot hold. A fraction
 * finer than a millisecond is cut to one before parsing, so no engine's leniency decides.
 */
function readInstant(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || !INSTANT.test(value)) return undefined;
  const millis = value.replace(/\.(\d{1,3})\d*/u, (_all, digits: string) => `.${digits}`);
  const at = Date.parse(millis);
  return Number.isFinite(at) && Math.abs(at) <= MAX_DATE_MS ? at : undefined;
}

/** A status that is not the route's answer: a nonce asked for again, or the status itself. */
function refusedAt(status: number, json: unknown): string {
  return status === 401 && asksForNonce(json) ? 'nonce_refused' : `http_${String(status)}`;
}

function unavailable(detail: string): { readonly kind: 'unavailable'; readonly detail: string } {
  return { kind: 'unavailable', detail };
}

function isMtId(value: unknown): value is string {
  return typeof value === 'string' && MT_ID.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isReceiptState(value: string): value is ReceiptState {
  return Object.hasOwn(RECEIPT_STATES, value);
}

function readReason(value: unknown): string | null {
  return typeof value === 'string' && REASON.test(value) ? value : null;
}

/** An id as the server decodes it: case and Crockford's aliases folded. */
function canonicalId(id: string): string {
  return id.toLowerCase().replaceAll('o', '0').replaceAll('i', '1').replaceAll('l', '1');
}
