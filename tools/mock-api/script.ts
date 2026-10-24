/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The script (`MockScript`): the answers a test forces, each at the point where the server would
// give it, checked before anything runs and queued per route.

import { validateHeaderName, validateHeaderValue } from 'node:http';

import {
  FAILURES_PER_MINUTE,
  DEFAULT_RETRY_AFTER_SECONDS,
  MAX_FORCED,
  PLAYS_BODY_LIMIT,
  alreadyApplied,
  bodyMismatch,
  codeInvalid,
  credentialInvalid,
  deadline,
  doorNonceRequired,
  featureClosed,
  forcedValidation,
  inFlight,
  internalError,
  json,
  limitReached,
  overloaded,
  plusRequired,
  proofInvalid,
  rateLimited,
  refusal,
  replayCheckUnavailable,
  sessionNotFresh,
  tokenNonceRequired,
  tooLarge,
  unavailable,
  watchedAtOutOfRange,
} from './answers.ts';
import type { Build, Forced, Header, Stage } from './answers.ts';
import {
  CONNECTION_READS_PER_MINUTE,
  PLAY_READS_PER_MINUTE,
  PLAY_WRITES_PER_MINUTE,
  isReceiptReason,
  isReceiptState,
} from './state.ts';
import type { Decided, ReceiptReason, ReceiptState, ReceiptStep, RecordedPlay } from './state.ts';

/** Answers the token endpoint can be forced to give, each where the server gives it. */
export type TokenFault =
  | 'nonce_required'
  | 'code_invalid'
  | 'proof_invalid'
  | 'plus_required'
  | 'session_not_fresh'
  | 'limit_reached'
  | 'feature_closed'
  | 'rate_limited'
  | 'unavailable'
  | 'internal_error'
  | 'drop'
  | 'hang';

/** Answers the plays route can be forced to give. */
export type PlayFault =
  | 'feature_closed'
  | 'too_large'
  | 'in_flight'
  | 'already_applied'
  | 'body_mismatch'
  | 'credential_invalid'
  | 'nonce_required'
  | 'rate_limited'
  | 'validation_failed'
  | 'watched_at_out_of_range'
  | 'unavailable'
  | 'overloaded'
  | 'internal_error'
  | 'deadline'
  | 'drop'
  | 'hang'
  | 'lost_answer';

/** Answers the receipt read can be forced to give. */
export type ReceiptFault =
  | 'feature_closed'
  | 'credential_invalid'
  | 'nonce_required'
  | 'rate_limited'
  | 'not_found'
  | 'unavailable'
  | 'internal_error'
  | 'drop'
  | 'hang';

/** Answers the connection read can be forced to give: the receipt's, less `not_found`. */
export type ConnectionFault =
  | 'feature_closed'
  | 'credential_invalid'
  | 'nonce_required'
  | 'rate_limited'
  | 'unavailable'
  | 'internal_error'
  | 'drop'
  | 'hang';

/** `429` with a wait of the script's choosing. */
export interface RetryLater {
  readonly fault: 'rate_limited';
  readonly retryAfterSeconds: number;
}

/** `202` with `scrobble_id: null`: a play answered and not kept (the plays API's "A play that is not kept"). */
export interface NotKept {
  readonly fault: 'not_kept';
  readonly state: ReceiptState;
  readonly reason: ReceiptReason | null;
}

/** Any answer at all — for what the server has never said — sent verbatim on arrival. */
export interface RawAnswer {
  readonly fault: 'raw';
  /** 200–599. */
  readonly status: number;
  /** Sent as JSON (with `Content-Type: application/json`), or `text` verbatim; not both. */
  readonly body?: unknown;
  readonly text?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type TokenAnswer = TokenFault | RetryLater | RawAnswer;
export type PlayAnswer = PlayFault | RetryLater | NotKept | RawAnswer;
export type ReceiptAnswer = ReceiptFault | RetryLater | RawAnswer;
export type ConnectionAnswer = ConnectionFault | RetryLater | RawAnswer;

/**
 * Answers to force, per route, each consumed by one request in order — by the first request that
 * reaches the point where the server would give that answer: a refusal of the request itself
 * (`feature_closed`, `credential_invalid`, `in_flight`, `drop`…) on arrival, before anything is
 * read; anything the server says only to a verified proof (`rate_limited`, `nonce_required`,
 * `code_invalid`, `hang` on the plays route…) once the proof verified, so it carries a fresh
 * `DPoP-Nonce` as the server's would. When a route's list is empty the mock judges.
 */
export interface MockScript {
  readonly token?: readonly TokenAnswer[];
  readonly plays?: readonly PlayAnswer[];
  readonly receipts?: readonly ReceiptAnswer[];
  /** `GET /v1/integrations/connection`: the same points as the receipt read's. */
  readonly connection?: readonly ConnectionAnswer[];
  /**
   * What a stored play's receipt reads over time: steps from its arrival, the first at 0 ms, which
   * is also its `202`'s state. Default: `received`, then — 5 s later — `recorded` when the play
   * counts by the server's rule (`ended`, or the account's finish line with numbers, or no
   * numbers) and
   * `ignored`/`not_completed` when it does not; a start kept at the door reads `started`, or
   * `ignored`/`status_stands` when `decided` says its film is already in the library.
   */
  readonly progression?: (play: RecordedPlay, decided: Decided) => readonly ReceiptStep[];
}

const answerAt = (stage: Stage, build: Build): Forced => ({
  stage,
  act: { kind: 'answer', build },
});
const DROP: Forced = { stage: 'arrival', act: { kind: 'drop' } };
const HANG_ON_ARRIVAL: Forced = { stage: 'arrival', act: { kind: 'hang' } };

const TOKEN_FAULTS: Readonly<Record<TokenFault, Forced>> = {
  nonce_required: answerAt('verified', tokenNonceRequired),
  code_invalid: answerAt('verified', codeInvalid),
  proof_invalid: answerAt('arrival', proofInvalid),
  plus_required: answerAt('verified', plusRequired),
  session_not_fresh: answerAt('verified', sessionNotFresh),
  limit_reached: answerAt('verified', limitReached),
  feature_closed: answerAt('arrival', featureClosed),
  rate_limited: answerAt('arrival', rateLimited(FAILURES_PER_MINUTE, DEFAULT_RETRY_AFTER_SECONDS)),
  unavailable: answerAt('verified', replayCheckUnavailable),
  internal_error: answerAt('verified', internalError),
  drop: DROP,
  hang: HANG_ON_ARRIVAL,
};

const PLAY_FAULTS: Readonly<Record<PlayFault, Forced>> = {
  feature_closed: answerAt('arrival', featureClosed),
  too_large: answerAt('arrival', tooLarge(PLAYS_BODY_LIMIT)),
  in_flight: answerAt('arrival', inFlight),
  already_applied: answerAt('arrival', alreadyApplied),
  body_mismatch: answerAt('arrival', bodyMismatch),
  credential_invalid: answerAt('arrival', credentialInvalid),
  nonce_required: answerAt('verified', doorNonceRequired),
  rate_limited: answerAt(
    'verified',
    rateLimited(PLAY_WRITES_PER_MINUTE, DEFAULT_RETRY_AFTER_SECONDS),
  ),
  validation_failed: answerAt('verified', forcedValidation),
  watched_at_out_of_range: answerAt('verified', watchedAtOutOfRange),
  unavailable: answerAt('verified', unavailable),
  overloaded: answerAt('verified', overloaded),
  internal_error: answerAt('verified', internalError),
  deadline: answerAt('verified', deadline),
  drop: DROP,
  hang: { stage: 'verified', act: { kind: 'hang' } },
  lost_answer: { stage: 'verified', act: { kind: 'lost' } },
};

const RECEIPT_FAULTS: Readonly<Record<ReceiptFault, Forced>> = {
  feature_closed: answerAt('arrival', featureClosed),
  credential_invalid: answerAt('arrival', credentialInvalid),
  nonce_required: answerAt('verified', doorNonceRequired),
  rate_limited: answerAt(
    'verified',
    rateLimited(PLAY_READS_PER_MINUTE, DEFAULT_RETRY_AFTER_SECONDS),
  ),
  not_found: answerAt('verified', (x) => refusal(x, 404, 'resource.not_found', 'no such play')),
  unavailable: answerAt('verified', unavailable),
  internal_error: answerAt('verified', internalError),
  drop: DROP,
  hang: HANG_ON_ARRIVAL,
};

const CONNECTION_FAULTS: Readonly<Record<ConnectionFault, Forced>> = {
  feature_closed: answerAt('arrival', featureClosed),
  credential_invalid: answerAt('arrival', credentialInvalid),
  nonce_required: answerAt('verified', doorNonceRequired),
  rate_limited: answerAt(
    'verified',
    rateLimited(CONNECTION_READS_PER_MINUTE, DEFAULT_RETRY_AFTER_SECONDS),
  ),
  unavailable: answerAt('verified', unavailable),
  internal_error: answerAt('verified', internalError),
  drop: DROP,
  hang: HANG_ON_ARRIVAL,
};

export interface CheckedScript {
  readonly token: readonly Forced[];
  readonly plays: readonly Forced[];
  readonly receipts: readonly Forced[];
  readonly connection: readonly Forced[];
  readonly progression: MockScript['progression'];
}

/** The script, or a `TypeError`/`RangeError` naming what cannot be honoured — before anything runs. */
export function checkedScript(script: unknown): CheckedScript {
  if (typeof script !== 'object' || script === null) {
    throw new TypeError('a MockScript is an object');
  }
  const { token, plays, receipts, connection, progression, ...rest } = script as Record<
    string,
    unknown
  >;
  const unknown = Object.keys(rest)[0];
  if (unknown !== undefined) throw new TypeError(`a MockScript has no "${unknown.slice(0, 40)}"`);
  if (!(progression === undefined || typeof progression === 'function')) {
    throw new TypeError('MockScript.progression is a function');
  }
  return {
    token: entries(token, 'token', TOKEN_FAULTS, false),
    plays: entries(plays, 'plays', PLAY_FAULTS, true),
    receipts: entries(receipts, 'receipts', RECEIPT_FAULTS, false),
    connection: entries(connection, 'connection', CONNECTION_FAULTS, false),
    progression: progression as MockScript['progression'],
  };
}

function entries<F extends string>(
  list: unknown,
  route: string,
  faults: Readonly<Record<F, Forced>>,
  notKept: boolean,
): Forced[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new TypeError(`MockScript.${route} is a list`);
  if (list.length > MAX_FORCED) {
    throw new RangeError(`MockScript.${route} holds at most ${String(MAX_FORCED)}`);
  }
  return (list as unknown[]).map((entry) => {
    if (typeof entry === 'string') {
      if (Object.hasOwn(faults, entry)) return faults[entry as F];
      throw new TypeError(
        `MockScript.${route}: no answer named ${JSON.stringify(entry.slice(0, 40))}`,
      );
    }
    if (typeof entry !== 'object' || entry === null) {
      throw new TypeError(`MockScript.${route}: an entry is a name or an object`);
    }
    return shapedEntry(entry as Record<string, unknown>, route, notKept);
  });
}

/** An entry given as an object: a raw answer, a `rate_limited` wait, or a `not_kept` answer. */
function shapedEntry(
  fields: Readonly<Record<string, unknown>>,
  route: string,
  notKept: boolean,
): Forced {
  switch (fields.fault) {
    case 'raw':
      return rawAnswer(fields, route);
    case 'rate_limited': {
      const seconds = fields.retryAfterSeconds;
      if (
        typeof seconds !== 'number' ||
        !Number.isInteger(seconds) ||
        seconds < 0 ||
        seconds > 1_000_000
      ) {
        throw new RangeError(`MockScript.${route}: retryAfterSeconds is an integer 0–1000000`);
      }
      return answerAt(
        route === 'token' ? 'arrival' : 'verified',
        rateLimited(capacityOf(route), seconds),
      );
    }
    case 'not_kept': {
      if (!notKept) break;
      const { state, reason } = fields;
      if (!isReceiptState(state) || !(reason === null || isReceiptReason(reason))) {
        throw new TypeError(
          `MockScript.${route}: not_kept takes a wire state and a reason or null`,
        );
      }
      return answerAt('verified', () => json(202, { scrobble_id: null, state, reason }));
    }
    default:
      break;
  }
  throw new TypeError(`MockScript.${route}: no answer of that shape`);
}

/** The budget a route's `429` names. */
function capacityOf(route: string): number {
  switch (route) {
    case 'token':
      return FAILURES_PER_MINUTE;
    case 'plays':
      return PLAY_WRITES_PER_MINUTE;
    case 'connection':
      return CONNECTION_READS_PER_MINUTE;
    default:
      return PLAY_READS_PER_MINUTE;
  }
}

function rawAnswer(fields: Readonly<Record<string, unknown>>, route: string): Forced {
  const { status, body, text, headers } = fields;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) {
    throw new RangeError(`MockScript.${route}: a raw status is an integer 200–599`);
  }
  if (body !== undefined && text !== undefined) {
    throw new TypeError(`MockScript.${route}: raw takes body or text`);
  }
  if (!(text === undefined || typeof text === 'string')) {
    throw new TypeError(`MockScript.${route}: raw text is a string`);
  }
  const payload = text ?? (body === undefined ? '' : JSON.stringify(body));
  const pairs: Header[] = body === undefined ? [] : [['Content-Type', 'application/json']];
  if (headers !== undefined) {
    if (typeof headers !== 'object' || headers === null) {
      throw new TypeError(`MockScript.${route}: raw headers are an object`);
    }
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new TypeError(`MockScript.${route}: a raw header value is a string`);
      }
      validateHeaderName(name);
      validateHeaderValue(name, value);
      pairs.push([name, value]);
    }
  }
  return answerAt('arrival', () => ({ status, headers: pairs, body: payload }));
}
