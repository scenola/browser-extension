/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The routes, each as the server answers it: the approval page and `TestAuth`'s approval, the
// token endpoint, the plays route (under its `Idempotency-Key`), the receipt read and the
// connection read. server.ts dispatches to them.

import {
  PAGE_HEADERS,
  approvalPage,
  readApprovalBody,
  readApprovalQuery,
  redirectTo,
  refusedPage,
} from './approval.ts';
import type { ApprovalRead } from './approval.ts';
import {
  DEFAULT_BODY_LIMIT,
  PLAYS_BODY_LIMIT,
  WATCHED_AT_MAX_AGE_MS,
  WATCHED_AT_MAX_AHEAD_MS,
  alreadyApplied,
  bodyMismatch,
  codeInvalid,
  inFlight,
  json,
  keyMalformed,
  keyRequired,
  limitReached,
  proofInvalid,
  rateLimited,
  refusal,
  tokenNonceRequired,
  tooLarge,
  validationFailed,
  watchedAtOutOfRange,
} from './answers.ts';
import type { Answer, Ctx, Exchange, Outcome } from './answers.ts';
import { authenticate, countFailure, keyOf, scopeOf } from './credential.ts';
import { isoformatUtc, parseDateTime } from './datetime.ts';
import { noErrors, playEvidenceErrors, tokenFormErrors } from './evidence.ts';
import type { Errors } from './evidence.ts';
import {
  declaredOver,
  deliver,
  firstHeader,
  holdUntilClosed,
  jsonBody,
  mediaType,
  perform,
  readBody,
  send,
} from './http.ts';
import { PROOF_MAX_BYTES, verifyProof } from './proof.ts';
import {
  CONNECTION_READS_PER_MINUTE,
  MAX_CONNECTIONS,
  PLAY_READS_PER_MINUTE,
  PLAY_WRITES_PER_MINUTE,
  START_FLOOR_SECONDS,
  accountKeyOf,
  canonicalId,
  countingVerdict,
  credentialEnd,
  requestHash,
  stepAt,
} from './state.ts';
import type {
  Claim,
  Connection,
  Lock,
  ReceiptStep,
  Recorded,
  StoredAnswer,
  StoredPlay,
  WirePlay,
} from './state.ts';

// ── the approval ─────────────────────────────────────────────────────────────────────────────

const pageAnswer = (status: number, html: string): Answer => ({
  status,
  headers: PAGE_HEADERS,
  body: html,
});

export function approvalPageAnswer(x: Exchange): Answer {
  const read = readApprovalQuery(new URLSearchParams(x.query));
  return read.ok ? pageAnswer(200, approvalPage()) : pageAnswer(400, refusedPage());
}

/** The page's Approve: a code for the query's approval, and a 303 to the redirect it names. */
export async function approveOnPage(x: Exchange, ctx: Ctx): Promise<Outcome> {
  const body = await readBody(x.req, DEFAULT_BODY_LIMIT);
  if (body === 'aborted') return null;
  if (body === 'too_large') return pageAnswer(413, refusedPage());
  const read = readApprovalQuery(new URLSearchParams(x.query));
  if (!read.ok) return pageAnswer(400, refusedPage());
  const code = ctx.state.mintCode(read.approval);
  return {
    status: 303,
    headers: [
      ['Location', redirectTo(read.approval, code)],
      ['Cache-Control', 'no-store'],
      ['Referrer-Policy', 'no-referrer'],
    ],
    body: '',
  };
}

/**
 * `POST /v1/me/scrobblers/authorize`, which `TestAuth` calls against the real backend: its body,
 * its `422`s, its `Idempotency-Key`, and shown once — a 2xx records the tombstone, so the same key
 * again is `409 idempotency.already_applied` (`SECRET_MINTING_ROUTES`). The mock has no accounts:
 * an `Authorization` header is not required, and scopes the key when present.
 */
export async function testApprove(x: Exchange, ctx: Ctx): Promise<Outcome> {
  const gated = await underKey(x, ctx, DEFAULT_BODY_LIMIT);
  if (!('lock' in gated)) return gated.outcome;
  const { lock, bytes } = gated;
  let record: Recorded | null = null;
  let answer: Answer;
  try {
    const body = jsonBody(x.req.headers['content-type'], bytes);
    if (body.kind === 'refused') answer = body.build(x, ctx);
    else {
      const read: ApprovalRead =
        body.kind === 'missing' ? missingBody() : readApprovalBody(body.value);
      if (!read.ok) {
        answer =
          read.kind === 'model'
            ? validationFailed(read.errors)(x, ctx)
            : refusal(x, 422, 'validation.failed', read.message, { details: read.details });
      } else {
        const claim = ctx.state.idempotency.claim(lock, ctx.state.now());
        if (claim.kind === 'claimed') {
          const code = ctx.state.mintCode(read.approval);
          answer = json(200, { redirect_to: redirectTo(read.approval, code) });
          record = 'tombstone';
        } else ({ answer, record } = conflictAnswer(x, ctx, claim));
      }
    }
  } finally {
    ctx.state.idempotency.finish(lock, record, ctx.state.now());
  }
  return answer;
}

function missingBody(): ApprovalRead {
  const errors = noErrors();
  errors.errors.push({ loc: ['body'], type: 'missing', msg: 'Field required' });
  errors.count = 1;
  return { ok: false, kind: 'model', errors };
}

// ── the token endpoint ───────────────────────────────────────────────────────────────────────

export async function token(x: Exchange, ctx: Ctx): Promise<Outcome> {
  const early = ctx.queues.token.take('arrival');
  if (early !== null) return early;
  const form = await tokenForm(x, ctx);
  if ('outcome' in form) return form.outcome;
  const jkt = await tokenProof(x, ctx);
  if (typeof jkt !== 'string') return jkt;
  const forced = ctx.queues.token.take('verified');
  if (forced !== null) return forced;
  return mintToken(x, ctx, form.fields, jkt);
}

/** The token request's form, read and validated as the route's model is — or what refused it. */
async function tokenForm(
  x: Exchange,
  ctx: Ctx,
): Promise<{ readonly fields: Record<string, string> } | { readonly outcome: Outcome }> {
  if (declaredOver(x.req, DEFAULT_BODY_LIMIT)) {
    return { outcome: tooLarge(DEFAULT_BODY_LIMIT)(x, ctx) };
  }
  const bytes = await readBody(x.req, DEFAULT_BODY_LIMIT);
  if (bytes === 'aborted') return { outcome: null };
  if (bytes === 'too_large') return { outcome: tooLarge(DEFAULT_BODY_LIMIT)(x, ctx) };
  const fields = formOf(x.req.headers['content-type'], bytes);
  const errors = tokenFormErrors(fields);
  const first = firstHeader(x.req, 'dpop');
  if (first !== undefined && first.length > PROOF_MAX_BYTES) {
    errors.count += 1;
    errors.errors.push({
      loc: ['header', 'DPoP'],
      type: 'string_too_long',
      msg: `String should have at most ${String(PROOF_MAX_BYTES)} characters`,
      ctx: { max_length: PROOF_MAX_BYTES },
    });
  }
  if (errors.count > 0) return { outcome: validationFailed(errors)(x, ctx) };
  return { fields };
}

/**
 * The thumbprint of the key the request's one proof was signed with, once it verified — the
 * nonce it earned is then offered — or the refusal.
 */
async function tokenProof(x: Exchange, ctx: Ctx): Promise<string | Answer> {
  // RFC 9449 §4.3: one proof, never a choice between several.
  const proofs = x.req.headersDistinct.dpop ?? [];
  const proof = proofs[0];
  if (proofs.length !== 1 || proof === undefined) {
    return countFailure(x, ctx, 'integration_token_writes') ?? proofInvalid(x, ctx);
  }
  const now = ctx.state.now();
  const verdict = await verifyProof(proof, {
    method: x.req.method ?? '',
    url: `${ctx.publicUrl}${x.path}`,
    credential: null,
    expectedJkt: null,
    nonceIsCurrent: (nonce) => ctx.state.nonces.isCurrent(nonce, now),
  });
  // Not counted: only the key's holder reaches it.
  if (verdict.kind === 'nonce') return tokenNonceRequired(x, ctx);
  if (verdict.kind === 'invalid') {
    return countFailure(x, ctx, 'integration_token_writes') ?? proofInvalid(x, ctx);
  }
  x.offeredNonce = ctx.state.nonces.issue(now);
  return verdict.jkt;
}

/** The code traded for a credential bound to `jkt`, or why it is not. */
function mintToken(
  x: Exchange,
  ctx: Ctx,
  form: Readonly<Record<string, string>>,
  jkt: string,
): Answer {
  const code = form.code ?? '';
  const verifier = form.code_verifier ?? '';
  const refused = ctx.state.judgeCode(code, verifier, form.redirect_uri ?? '', jkt);
  if (refused !== null) {
    return countFailure(x, ctx, 'integration_token_writes') ?? codeInvalid(x, ctx);
  }
  // `create_extension_scrobbler` refuses before it writes: the code stays unspent.
  if (ctx.state.liveConnections() >= MAX_CONNECTIONS) return limitReached(x, ctx);
  const minted = ctx.state.connect(code, jkt);
  return json(
    200,
    { access_token: minted.credential, token_type: 'DPoP', expires_in: minted.expiresInSeconds },
    [['Cache-Control', 'no-store']],
  );
}

/**
 * Starlette's form: `application/x-www-form-urlencoded` parsed, anything else no fields at all. A
 * repeated field's last value wins (its `ImmutableMultiDict`); an empty one is FastAPI's missing.
 */
function formOf(contentType: string | undefined, bytes: Buffer): Record<string, string> {
  const last = new Map<string, string>();
  if (mediaType(contentType) === 'application/x-www-form-urlencoded') {
    for (const [name, value] of new URLSearchParams(bytes.toString('utf8'))) last.set(name, value);
  }
  // No prototype: a field named `__proto__` is a field, not an assignment to one.
  const form = Object.create(null) as Record<string, string>;
  for (const [name, value] of last) if (value !== '') form[name] = value;
  return form;
}

// ── the plays route ──────────────────────────────────────────────────────────────────────────

interface Judged {
  /** What to send, or `null` when nothing is sent (held until the client left). */
  readonly answer: Answer | null;
  /** What the idempotency layer records (`_what_to_record`, `_answer_conflict`). */
  readonly record: Recorded | null;
  /** The connection drops instead of the answer going out. */
  readonly lost: boolean;
}

const NOTHING_SENT: Judged = { answer: null, record: null, lost: false };

/** An answer judged under `lock`, with what the idempotency layer records of it. */
const answered = (answer: Answer, lock: Lock, lost = false): Judged => ({
  answer,
  record: whatToRecord(answer, lock),
  lost,
});

export async function playsRoute(x: Exchange, ctx: Ctx): Promise<void> {
  const early = ctx.queues.plays.take('arrival');
  if (early !== null) return perform(x, ctx, early);
  const gated = await underKey(x, ctx, PLAYS_BODY_LIMIT);
  if (!('lock' in gated)) return deliver(x, ctx, gated.outcome);
  const { lock, bytes, canonicalKey } = gated;
  let judged: Judged = NOTHING_SENT;
  try {
    judged = await judgePlay(x, ctx, { bytes, lock, canonicalKey });
  } finally {
    // FINISH before the send, so a test's next request is deterministic. The real server
    // records *after* the send: there a retry the moment the answer
    // arrives can still meet the lock and get `409 idempotency.in_flight`, which a client must
    // take as "retry shortly". The mock does not play that race by itself — force it with the
    // `in_flight` fault.
    ctx.state.idempotency.finish(lock, judged.record, ctx.state.now());
  }
  if (judged.answer === null) return;
  if (judged.lost) x.req.socket.destroy();
  else send(x, judged.answer);
}

async function judgePlay(x: Exchange, ctx: Ctx, held: UnderKey): Promise<Judged> {
  const { lock } = held;
  const body = jsonBody(x.req.headers['content-type'], held.bytes);
  if (body.kind === 'refused') return answered(body.build(x, ctx), lock);
  const auth = await authenticate(x, ctx, 'integration_failure_writes');
  if (auth.kind === 'refused') return answered(auth.answer, lock);
  const forced = await forcedPlay(x, ctx);
  if (forced === 'gone') return NOTHING_SENT;
  if (forced !== null && forced !== 'lost') return answered(forced.answer, lock);
  const lost = forced === 'lost';
  const now = ctx.state.now();
  const admitted = admitPlay(x, ctx, { connection: auth.connection, body, now });
  if ('status' in admitted) return answered(admitted, lock, lost);
  const play = storePlay(x, ctx, { ...held, connection: auth.connection, evidence: admitted, now });
  return 'answer' in play ? { ...play, lost } : answered(play, lock, lost);
}

/**
 * The verified stage's forced act: an answer; `gone` when nothing is sent (held until the
 * client left, or dropped); `lost` when the play is judged and its answer lost; or none.
 */
async function forcedPlay(
  x: Exchange,
  ctx: Ctx,
): Promise<{ readonly answer: Answer } | 'gone' | 'lost' | null> {
  const forced = ctx.queues.plays.take('verified');
  if (forced === null) return null;
  switch (forced.act.kind) {
    case 'answer':
      return { answer: forced.act.build(x, ctx) };
    case 'hang':
      await holdUntilClosed(x, ctx);
      return 'gone';
    case 'lost':
      return 'lost';
    case 'drop':
      x.req.socket.destroy();
      return 'gone';
  }
}

/**
 * The play's evidence, once the connection's budget, the body's schema, `watched_at`'s bounds
 * and the mock's room let it through — or the refusal.
 */
function admitPlay(
  x: Exchange,
  ctx: Ctx,
  play: {
    readonly connection: Connection;
    readonly body: Exclude<ReturnType<typeof jsonBody>, { kind: 'refused' }>;
    readonly now: number;
  },
): WirePlay | Answer {
  const { body, now } = play;
  const budget = play.connection.writes.admit(now);
  if (!budget.allowed) {
    return rateLimited(PLAY_WRITES_PER_MINUTE, budget.retryAfterSeconds, budget.count)(x, ctx);
  }
  const errors = body.kind === 'value' ? playEvidenceErrors(body.value) : missingErrors();
  if (errors.count > 0) return validationFailed(errors)(x, ctx);
  const evidence = (body.kind === 'value' ? body.value : null) as WirePlay;
  // `checked_watched_at`: before anything is written, both bounds inclusive.
  const receivedMicros = BigInt(now) * 1000n;
  const stated = evidence.watched_at == null ? null : parseDateTime(evidence.watched_at);
  const watchedMicros = stated?.epochMicros ?? receivedMicros;
  if (
    watchedMicros < receivedMicros - BigInt(WATCHED_AT_MAX_AGE_MS) * 1000n ||
    watchedMicros > receivedMicros + BigInt(WATCHED_AT_MAX_AHEAD_MS) * 1000n
  ) {
    return watchedAtOutOfRange(x, ctx);
  }
  if (!ctx.state.hasRoom()) {
    return refusal(x, 503, 'service.unavailable', 'the mock keeps 10000 plays; restart it', {
      details: { resource: 'mock_storage' },
    });
  }
  return evidence;
}

/**
 * The admitted play, kept as the server keeps it: a suspended connection's or one the account's
 * lines do not count answered and not kept; a play stored under the key answering what became of
 * it; otherwise stored with the key's claim. The answer, or the claim's conflict.
 */
function storePlay(
  x: Exchange,
  ctx: Ctx,
  play: UnderKey & {
    readonly connection: Connection;
    readonly evidence: WirePlay;
    readonly now: number;
  },
): Answer | { readonly answer: Answer; readonly record: Recorded | null } {
  const { connection, evidence, now, lock, canonicalKey } = play;
  // A suspended connection (an account being deleted) is answered and not kept: nothing is
  // stored, nothing is claimed, and nothing slides.
  if (connection.status === 'suspended') {
    return json(202, { scrobble_id: null, state: 'dismissed', reason: 'account_deletion' });
  }
  // `_already_stored`: a play this connection stored under the key answers what became of it.
  const existing = ctx.state.storedUnder(connection, canonicalKey);
  // `accept_play` 4a: a play the account's lines do not count — a viewing short of the finish
  // line, a start short of the start line or with starts off — is answered and not kept:
  // nothing stored, nothing claimed, nothing slides.
  if (existing === undefined && countingVerdict(evidence, ctx.state.rule()) === 'not_counted') {
    return json(202, { scrobble_id: null, state: 'ignored', reason: 'not_completed' });
  }
  // Made before anything is written: a script's progression that refuses is a 500 with no trace.
  const stored = existing ?? ctx.state.newPlay(connection, canonicalKey, evidence, ctx.progression);
  // The request's first write takes the claim; the play commits with it.
  const claim = ctx.state.idempotency.claim(lock, now);
  if (claim.kind !== 'claimed') return conflictAnswer(x, ctx, claim);
  if (existing === undefined) ctx.state.keep(stored);
  ctx.state.slideExpiry(connection);
  return accepted(stored, stepAt(stored, now));
}

function accepted(play: StoredPlay, step: ReceiptStep): Answer {
  return json(202, {
    scrobble_id: play.record.scrobbleId,
    state: step.state,
    reason: step.reason ?? null,
  });
}

function missingErrors(): Errors {
  return { errors: [{ loc: ['body'], type: 'missing', msg: 'Field required' }], count: 1 };
}

/** `_what_to_record`: a 2xx always; a 4xx once the claim committed; a later 5xx as the tombstone. */
function whatToRecord(answer: Answer, lock: Lock): Recorded | null {
  const stored: StoredAnswer = {
    status: answer.status,
    headers: answer.headers,
    body: answer.body,
  };
  if (answer.status >= 200 && answer.status < 300) return stored;
  if (!lock.claimed) return null;
  return answer.status < 500 ? stored : 'tombstone';
}

/** `_answer_conflict`: the key was claimed by a committed execution. */
function conflictAnswer(
  x: Exchange,
  ctx: Ctx,
  claim: Exclude<Claim, { kind: 'claimed' }>,
): { answer: Answer; record: Recorded | null } {
  switch (claim.kind) {
    case 'mismatch':
      return { answer: bodyMismatch(x, ctx), record: null };
    case 'replay':
      return { answer: replayed(x, ctx, claim.answer), record: null };
    case 'already_applied':
      return { answer: alreadyApplied(x, ctx), record: 'tombstone' };
  }
}

function replayed(x: Exchange, ctx: Ctx, recorded: Recorded): Answer {
  return recorded === 'tombstone' ? alreadyApplied(x, ctx) : recorded;
}

/** Past the idempotency layer's BEGIN: the lock this request holds, its body, its key. */
interface UnderKey {
  readonly lock: Lock;
  readonly bytes: Buffer;
  readonly canonicalKey: string;
}

/**
 * The outer layers of a write the idempotency layer governs: the body cap (`BodyLimitMiddleware`)
 * and BEGIN (`IdempotencyMiddleware`) — what they answered (a refusal, a replay; nothing when the
 * client left), or the lock.
 */
async function underKey(
  x: Exchange,
  ctx: Ctx,
  limit: number,
): Promise<UnderKey | { readonly outcome: Outcome }> {
  if (declaredOver(x.req, limit)) return { outcome: tooLarge(limit)(x, ctx) };
  const key = keyOf(x);
  if (key === 'missing') return { outcome: keyRequired(x, ctx) };
  if (key === 'malformed') return { outcome: keyMalformed(x, ctx) };
  const bytes = await readBody(x.req, limit);
  if (bytes === 'aborted') return { outcome: null };
  if (bytes === 'too_large') return { outcome: tooLarge(limit)(x, ctx) };
  const hash = requestHash(x.req.method ?? '', x.path, x.query, bytes);
  const scope = scopeOf(x);
  const began = ctx.state.idempotency.begin(scope, key.raw, key.canonical, hash, ctx.state.now());
  switch (began.kind) {
    case 'replay':
      return { outcome: replayed(x, ctx, began.answer) };
    case 'mismatch':
      return { outcome: bodyMismatch(x, ctx) };
    case 'in_flight':
      return { outcome: inFlight(x, ctx) };
    case 'locked':
      return { lock: began.lock, bytes, canonicalKey: key.canonical };
  }
}

// ── the receipt read ─────────────────────────────────────────────────────────────────────────

export async function receiptOf(x: Exchange, ctx: Ctx, segment: string): Promise<Outcome> {
  const early = ctx.queues.receipts.take('arrival');
  if (early !== null) return early;
  const auth = await authenticate(x, ctx, 'integration_failure_reads');
  if (auth.kind === 'refused') return auth.answer;
  const forced = ctx.queues.receipts.take('verified');
  if (forced !== null) return forced;
  const now = ctx.state.now();
  const budget = auth.connection.reads.admit(now);
  if (!budget.allowed) {
    return rateLimited(PLAY_READS_PER_MINUTE, budget.retryAfterSeconds, budget.count)(x, ctx);
  }
  // `MtId`: `decode_id`, or a 422 for the path parameter.
  const id = canonicalId(segment);
  if (id === null) {
    const loc = ['path', 'scrobble_id'];
    return validationFailed({
      errors: [{ loc, type: 'value_error', msg: 'Value error, not an id' }],
      count: 1,
    })(x, ctx);
  }
  // Another connection's play is the same 404 as none at all.
  const play = ctx.state.playOf(auth.connection, id);
  if (play === undefined) {
    return refusal(x, 404, 'resource.not_found', 'no such play', { details: { scrobble_id: id } });
  }
  const step = stepAt(play, now);
  const settled = step.state === 'recorded' || step.state === 'duplicate';
  // A start that found its film names it too, whether it saved it or found its status standing.
  const startFound =
    step.state === 'started' || (step.state === 'ignored' && step.reason === 'status_stands');
  return json(200, {
    scrobble_id: id,
    state: step.state,
    reason: step.reason ?? null,
    title_id: settled || startFound ? play.titleId : null,
    episode_id: settled ? play.episodeId : null,
    // Set only while the play waits on the person, as the server does.
    question_key:
      step.state === 'held' || step.state === 'needs_confirmation'
        ? (step.questionKey ?? null)
        : null,
  });
}

// ── the connection read ──────────────────────────────────────────────────────────────────────

/**
 * Is this connection alive, and until when. Authenticated as the receipt read is (its failures
 * share that address bucket); its own budget (`integration_connection_reads`, 30 a minute). A
 * revoked or ended credential never gets here: it is the `401` every route gives. Writes nothing
 * and **slides nothing** — `expires_at` moves only when a stored play moves it.
 */
export async function connectionRead(x: Exchange, ctx: Ctx): Promise<Outcome> {
  const early = ctx.queues.connection.take('arrival');
  if (early !== null) return early;
  const auth = await authenticate(x, ctx, 'integration_failure_reads');
  if (auth.kind === 'refused') return auth.answer;
  const forced = ctx.queues.connection.take('verified');
  if (forced !== null) return forced;
  const budget = auth.connection.connectionReads.admit(ctx.state.now());
  if (!budget.allowed) {
    return rateLimited(CONNECTION_READS_PER_MINUTE, budget.retryAfterSeconds, budget.count)(x, ctx);
  }
  const { connection } = auth;
  return json(200, {
    status: connection.status,
    created_at: isoformatUtc(connection.createdAt),
    expires_at: isoformatUtc(credentialEnd(connection)),
    start_threshold_percent: ctx.state.startThresholdPercent,
    start_floor_seconds: START_FLOOR_SECONDS,
    finish_threshold_percent: ctx.state.finishThresholdPercent,
    account_key: accountKeyOf(connection.account),
  });
}
