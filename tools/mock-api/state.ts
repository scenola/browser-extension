/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the mock remembers, and the server rules that are about memory rather than HTTP: its
// clock, the ids and credentials it mints, the DPoP nonce, authorization codes, connections and
// their spent `jti`s, plays and their receipts, the idempotency layer and the sliding-window
// budgets. Each rule names the server constant or function it mirrors.
//
// Everything is bounded: every store has a cap and drops its oldest entry past it, and every
// entry expires on the mock's clock. A dropped entry behaves as the server's would once its own
// record is gone (a code unknown, a record lost, a `jti` forgotten).

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';

import { Idempotency } from './idempotency.ts';
import {
  DEFAULT_FINISH_THRESHOLD_PERCENT,
  IN_LIBRARY,
  checkedProgression,
  sameFilm,
} from './plays.ts';
import type {
  CountingRule,
  Decided,
  FinishThresholdPercent,
  ReceiptStep,
  RecordedPlay,
  StartThresholdPercent,
  StoredPlay,
  WirePlay,
} from './plays.ts';
import { ExpiringMap, SlidingWindow, WindowsByKey } from './stores.ts';

// What the mock remembers is reached through this file: the parts kept beside it are re-exported.
export { requestHash } from './idempotency.ts';
export type { Claim, Lock, Recorded, StoredAnswer } from './idempotency.ts';
export {
  START_FLOOR_SECONDS,
  countingVerdict,
  defaultProgression,
  isFinishThreshold,
  isReceiptReason,
  isReceiptState,
  isStartThreshold,
  stepAt,
} from './plays.ts';
export type {
  CountingRule,
  Decided,
  FinishThresholdPercent,
  ReceiptReason,
  ReceiptState,
  ReceiptStep,
  RecordedPlay,
  StartThresholdPercent,
  StoredPlay,
  WirePlay,
} from './plays.ts';
export { ExpiringMap, SlidingWindow } from './stores.ts';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

// ── the clock ────────────────────────────────────────────────────────────────────────────────

export interface Clock {
  /** Epoch milliseconds on the mock's clock. */
  now(): number;
  /** Moves the clock forward by `ms` (finite, non-negative). */
  advance(ms: number): void;
}

/**
 * The wall clock plus whatever `advance` added — or, given `frozenAt`, that instant plus whatever
 * `advance` added, and nothing else: a test's time then moves only when the test moves it.
 */
export function createClock(frozenAt: number | null): Clock {
  let offset = 0;
  return {
    now: () => (frozenAt ?? Date.now()) + offset,
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError('advance takes a finite ms >= 0');
      offset += ms;
    },
  };
}

// ── ids ──────────────────────────────────────────────────────────────────────────────────────

/** `_ALPHABET`: Crockford base32, lowercase, no `i l o u`. */
const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const ID_LENGTH = 26;

/** `_DECODE_MAP`: the alphabet in either case, and Crockford's aliases `o O → 0`, `i I l L → 1`. */
const ID_DECODE: ReadonlyMap<string, number> = (() => {
  const map = new Map<string, number>();
  for (let i = 0; i < ID_ALPHABET.length; i++) {
    const c = ID_ALPHABET.charAt(i);
    map.set(c, i);
    map.set(c.toUpperCase(), i);
  }
  for (const c of ['o', 'O']) map.set(c, 0);
  for (const c of ['i', 'I', 'l', 'L']) map.set(c, 1);
  return map;
})();

/** `encode_id`: 16 bytes as 26 lowercase Crockford characters. */
export function encodeId(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new RangeError('an id is 16 bytes');
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  const chars: string[] = new Array<string>(ID_LENGTH);
  for (let i = ID_LENGTH - 1; i >= 0; i--) {
    chars[i] = ID_ALPHABET.charAt(Number(n & 31n));
    n >>= 5n;
  }
  return chars.join('');
}

/** `decode_id`: the 16 bytes, or `null` for anything it refuses (length, character, > 128 bits). */
export function decodeId(text: string): Uint8Array | null {
  if (text.length !== ID_LENGTH) return null;
  let n = 0n;
  for (const c of text) {
    const value = ID_DECODE.get(c);
    if (value === undefined) return null;
    n = n * 32n + BigInt(value);
  }
  if (n >> 128n !== 0n) return null;
  return Uint8Array.from(Buffer.from(n.toString(16).padStart(32, '0'), 'hex'));
}

/** The canonical (lowercase, unaliased) spelling of an id, or `null` when it is not one. */
export function canonicalId(text: string): string | null {
  const bytes = decodeId(text);
  return bytes === null ? null : encodeId(bytes);
}

/** A UUIDv7 (RFC 9562 §5.7) for `nowMs`, as an id: what the server mints for every row. */
export function newId(nowMs: number): string {
  const bytes = randomBytes(16);
  let ts = Math.max(0, Math.floor(nowMs));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  return encodeId(bytes);
}

// ── credentials ──────────────────────────────────────────────────────────────────────────────

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const EXTENSION_PREFIX = 'mts_ext_';
const KEY_LENGTH = 43;
const CHECKSUM_LENGTH = 6;

/** `_SHAPE`: a prefix of one of the three kinds, 43 base62 characters, 6 of checksum. */
const CREDENTIAL_SHAPE = /^(mts_pat_|mts_hook_|mts_ext_)([0-9A-Za-z]{43})([0-9A-Za-z]{6})$/;

/** `_encode`: `value` in base62, zero-padded to exactly `length` characters. */
export function base62(value: bigint, length: number): string {
  const digits: string[] = [];
  let n = value;
  while (n > 0n) {
    digits.push(BASE62.charAt(Number(n % 62n)));
    n /= 62n;
  }
  if (digits.length > length) {
    throw new RangeError(`${String(length)} base62 digits cannot hold it`);
  }
  return digits.reverse().join('').padStart(length, '0');
}

/** `_checksum`: CRC32 of the prefix and key, in six base62 characters. */
export function credentialChecksum(prefixAndKey: string): string {
  return base62(BigInt(crc32(Buffer.from(prefixAndKey, 'ascii'))), CHECKSUM_LENGTH);
}

/** `mint_credential("extension")`: `mts_ext_`, 256 random bits in base62, the checksum. */
export function mintExtensionCredential(): string {
  const key = base62(BigInt(`0x${randomBytes(32).toString('hex')}`), KEY_LENGTH);
  return `${EXTENSION_PREFIX}${key}${credentialChecksum(EXTENSION_PREFIX + key)}`;
}

/** `credential_kind_of`: the kind of a well-formed credential (checksum included), else `null`. */
export function credentialKind(text: string): 'personal' | 'webhook' | 'extension' | null {
  const match = CREDENTIAL_SHAPE.exec(text);
  if (match === null) return null;
  const [, prefix = '', key = '', checksum = ''] = match;
  if (credentialChecksum(prefix + key) !== checksum) return null;
  return prefix === 'mts_pat_' ? 'personal' : prefix === 'mts_hook_' ? 'webhook' : 'extension';
}

export const sha256Hex = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

/** `s256`: BASE64URL(SHA-256(ASCII(value))) — a PKCE challenge, an `ath`. */
export const s256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('base64url');

// ── the DPoP nonce (`issue_nonce`, `nonce_is_current`) ───────────────────────────────────────

/** `NONCE_BUCKET_SECONDS`: a nonce names a 5-minute bucket; it and the previous are current. */
const NONCE_BUCKET_SECONDS = 300;
const NONCE_DOMAIN = 'mt-dpop-nonce:v1:';

export class NonceIssuer {
  readonly #key = randomBytes(32);

  #forBucket(bucket: number): string {
    return createHmac('sha256', this.#key)
      .update(`${NONCE_DOMAIN}${String(bucket)}`)
      .digest('base64url');
  }

  #bucket(nowMs: number): number {
    return Math.floor(Math.floor(nowMs / 1000) / NONCE_BUCKET_SECONDS);
  }

  /** The nonce of the bucket `nowMs` is in: the same for every client. */
  issue(nowMs: number): string {
    return this.#forBucket(this.#bucket(nowMs));
  }

  /** Whether `nonce` is this bucket's or the previous one's. */
  isCurrent(nonce: string, nowMs: number): boolean {
    const bucket = this.#bucket(nowMs);
    return nonce === this.#forBucket(bucket) || nonce === this.#forBucket(bucket - 1);
  }
}

// ── authorization codes and connections ──────────────────────────────────────────────────────

/** `AUTHORIZATION_CODE_LIFETIME`. */
const CODE_LIFETIME_MS = 60 * SECOND_MS;
/** `EXTENSION_SLIDING_LIFETIME`, `EXTENSION_ABSOLUTE_LIFETIME`, `EXTENSION_SLIDE_INTERVAL`. */
const SLIDING_LIFETIME_MS = 90 * DAY_MS;
const ABSOLUTE_LIFETIME_MS = 365 * DAY_MS;
const SLIDE_INTERVAL_MS = 10 * MINUTE_MS;
/** `MAX_SCROBBLERS_PER_USER`. */
export const MAX_CONNECTIONS = 10;
/** `JTI_TTL_SECONDS`. */
const JTI_TTL_MS = 600 * SECOND_MS;
/** `_CODE_VERIFIER`: RFC 7636 §4.1. */
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export interface Approval {
  readonly client: 'chrome_extension' | 'safari_extension';
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly dpopJkt: string;
  readonly state: string;
  readonly displayName: string;
}

interface StoredCode {
  readonly approval: Approval;
  readonly expiresAt: number;
  usedAt: number | null;
}

/**
 * A connection's status as the door applies it (the wire's
 * `IntegrationConnectionResponse.status` without `awaiting_binding`, a media server's, and
 * without `revoked`, which is a `401` and never an answer).
 */
export type ConnectionStatus = 'active' | 'braked' | 'suspended';

export interface Connection {
  readonly id: string;
  /** The account it acts for: the one signed in when it was made. */
  readonly account: string;
  readonly jkt: string;
  readonly createdAt: number;
  readonly absoluteExpiresAt: number;
  expiresAt: number;
  /** `active` until a test says otherwise; `braked` and `suspended` are the account's. */
  status: ConnectionStatus;
  /** Set by the web app's disconnect: the credential authenticates no more. */
  revoked: boolean;
  readonly jtis: ExpiringMap<true>;
  readonly writes: SlidingWindow;
  readonly reads: SlidingWindow;
  /** `_CONNECTION_READS`, the connection read's own budget. */
  readonly connectionReads: SlidingWindow;
}

/** The plays route's budgets (`_PLAY_WRITES`, `_PLAY_READS`). */
export const PLAY_WRITES_PER_MINUTE = 120;
export const PLAY_READS_PER_MINUTE = 240;
/** The connection read's bucket, `integration_connection_reads`. */
export const CONNECTION_READS_PER_MINUTE = 30;

/**
 * When the credential `connection` holds stops working unless a stored play slides it: the
 * earlier of its sliding and absolute ends. Reading this slides nothing.
 */
export const credentialEnd = (connection: Connection): number =>
  Math.min(connection.expiresAt, connection.absoluteExpiresAt);

// ── plays and accounts ───────────────────────────────────────────────────────────────────────

/** The most plays the mock keeps; past it a play is refused `503`, never silently dropped. */
const MAX_PLAYS = 10_000;

/** The account every sign-in acts for until a test signs in as another. */
const DEFAULT_ACCOUNT = 'account-a';

/**
 * `account_key` as the server derives it: `a1:` and 32 lowercase hexadecimal digits, the same
 * for every connection of one account from an extension, different for every other account.
 * The mock hashes where the server keys an HMAC with its secret; a client cannot tell.
 */
export function accountKeyOf(account: string): string {
  return `a1:${sha256Hex(`extension\n${account}`).slice(0, 32)}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// ── the state ────────────────────────────────────────────────────────────────────────────────

/** The most live authorization codes kept (each lives 60 s). */
const MAX_CODES = 1000;
/** The most failure windows kept (one per address and door; the mock sees one address). */
const MAX_FAILURE_WINDOWS = 1000;

export type CodeRefusal = 'unknown' | 'used' | 'expired' | 'redirect_uri' | 'verifier' | 'dpop_key';

export class MockState {
  readonly clock: Clock;
  readonly nonces = new NonceIssuer();
  readonly idempotency = new Idempotency();
  readonly failures = new WindowsByKey(MAX_FAILURE_WINDOWS);
  /** Every stored play, oldest first: the live array behind `MockApi.plays`. */
  readonly plays: RecordedPlay[] = [];
  /**
   * The account's start rule, for every connection: the mock has
   * one account. `null`, starts off, until a test sets it, as the server's default.
   */
  startThresholdPercent: StartThresholdPercent | null = null;
  /** The account's finish line, for every connection: 70 % until a test sets it. */
  finishThresholdPercent: FinishThresholdPercent = DEFAULT_FINISH_THRESHOLD_PERCENT;
  /**
   * The account the next sign-in acts for, as the person in the web app's tab is signed in:
   * `account-a` until a test signs in as another. Only the connection's `account_key` tells
   * them apart; the lines above are every account's.
   */
  account = DEFAULT_ACCOUNT;

  /** The account's two lines as the door and the decision read them now. */
  rule(): CountingRule {
    return {
      startThresholdPercent: this.startThresholdPercent,
      finishThresholdPercent: this.finishThresholdPercent,
    };
  }

  // Kept past their lifetime, so an expired code is judged `expired` (one answer either way).
  readonly #codes = new ExpiringMap<StoredCode>(MAX_CODES, 10 * CODE_LIFETIME_MS);
  readonly #connections = new Map<string, Connection>();
  readonly #playsById = new Map<string, StoredPlay>();
  readonly #playsByKey = new Map<string, StoredPlay>();

  constructor(clock: Clock) {
    this.clock = clock;
  }

  now(): number {
    return this.clock.now();
  }

  /** Mints an authorization code, after the server's checks: a 43-character code, its hash stored 60 s. */
  mintCode(approval: Approval): string {
    const code = randomBytes(32).toString('base64url');
    const now = this.now();
    const row: StoredCode = { approval, expiresAt: now + CODE_LIFETIME_MS, usedAt: null };
    this.#codes.set(sha256Hex(code), row, now);
    return code;
  }

  /** `exchange_code`'s judgement, in its order; spends nothing. */
  judgeCode(code: string, verifier: string, redirectUri: string, jkt: string): CodeRefusal | null {
    const now = this.now();
    const row = this.#codes.get(sha256Hex(code), now);
    if (row === undefined) return 'unknown';
    if (row.usedAt !== null) return 'used';
    if (row.expiresAt <= now) return 'expired';
    if (row.approval.redirectUri !== redirectUri) return 'redirect_uri';
    if (!CODE_VERIFIER.test(verifier) || s256(verifier) !== row.approval.codeChallenge) {
      return 'verifier';
    }
    if (row.approval.dpopJkt !== jkt) return 'dpop_key';
    return null;
  }

  /** The live connections: the ones the ten-connection limit counts. */
  liveConnections(): number {
    this.#pruneConnections();
    return this.#connections.size;
  }

  /** Spends the code (judged a moment ago) and mints the connection bound to `jkt`. */
  connect(
    code: string,
    jkt: string,
  ): { readonly credential: string; readonly expiresInSeconds: number } {
    const now = this.now();
    const row = this.#codes.get(sha256Hex(code), now);
    if (row?.usedAt !== null) throw new Error('connect without a judged code');
    row.usedAt = now;
    this.#pruneConnections();
    const credential = mintExtensionCredential();
    this.#connections.set(sha256Hex(credential), {
      id: newId(now),
      account: this.account,
      jkt,
      createdAt: now,
      absoluteExpiresAt: now + ABSOLUTE_LIFETIME_MS,
      expiresAt: now + SLIDING_LIFETIME_MS,
      status: 'active',
      revoked: false,
      jtis: new ExpiringMap<true>(10_000, JTI_TTL_MS),
      writes: new SlidingWindow(PLAY_WRITES_PER_MINUTE),
      reads: new SlidingWindow(PLAY_READS_PER_MINUTE),
      connectionReads: new SlidingWindow(CONNECTION_READS_PER_MINUTE),
    });
    return { credential, expiresInSeconds: Math.floor(SLIDING_LIFETIME_MS / 1000) };
  }

  /** `resolve_principal` for an extension credential: its live connection, or `null`. */
  connectionOf(credential: string): Connection | null {
    const connection = this.#connections.get(sha256Hex(credential));
    if (connection === undefined) return null;
    const now = this.now();
    if (connection.revoked) return null;
    if (connection.expiresAt <= now || connection.absoluteExpiresAt <= now) return null;
    return connection;
  }

  /** The ids of the connections that authenticate now, oldest first. */
  connectionIds(): readonly string[] {
    this.#pruneConnections();
    return [...this.#connections.values()].map((connection) => connection.id);
  }

  /**
   * What the web app's disconnect does: the connection (by id; every live one when `id` is
   * omitted) is revoked, and its credential gets the `401` at every route from then on. Returns
   * how many it revoked; an id that names none is a `RangeError`.
   */
  revoke(id?: string): number {
    const named = this.#named(id);
    for (const connection of named) connection.revoked = true;
    this.#pruneConnections();
    return named.length;
  }

  /** Sets the status the door applies to the connection `id` names (every live one if omitted). */
  setStatus(status: ConnectionStatus, id?: string): void {
    for (const connection of this.#named(id)) connection.status = status;
  }

  #named(id: string | undefined): Connection[] {
    this.#pruneConnections();
    const live = [...this.#connections.values()];
    if (id === undefined) return live;
    const found = live.filter((connection) => connection.id === id);
    if (found.length === 0) throw new RangeError('no live connection has that id');
    return found;
  }

  /** `record_jti`: `false` when this connection already used `jti` within 10 minutes. */
  recordJti(connection: Connection, jti: string): boolean {
    const now = this.now();
    if (connection.jtis.get(jti, now) !== undefined) return false;
    connection.jtis.set(jti, true, now);
    return true;
  }

  /** `slide_extension_expiry`: at most every 10 minutes, never past the absolute expiry. */
  slideExpiry(connection: Connection): void {
    const now = this.now();
    const target = Math.min(now + SLIDING_LIFETIME_MS, connection.absoluteExpiresAt);
    if (
      connection.expiresAt > now &&
      connection.expiresAt <= now + SLIDING_LIFETIME_MS - SLIDE_INTERVAL_MS &&
      connection.expiresAt < target
    ) {
      connection.expiresAt = target;
    }
  }

  /** `_already_stored`: the play this connection already stored under this key. */
  storedUnder(connection: Connection, canonicalKey: string): StoredPlay | undefined {
    return this.#playsByKey.get(`${connection.id}\n${canonicalKey}`);
  }

  /** Whether another play can be stored (`MAX_PLAYS`). */
  hasRoom(): boolean {
    return this.plays.length < MAX_PLAYS;
  }

  /**
   * A validated play as it would be stored — its ids, and the steps `progression` gives it — with
   * nothing stored yet: a progression that refuses (a `TypeError`) leaves no trace, as a failed
   * transaction leaves none. `keep` stores it.
   */
  newPlay(
    connection: Connection,
    canonicalKey: string,
    evidence: WirePlay,
    progression: (play: RecordedPlay, decided: Decided) => unknown,
  ): StoredPlay {
    const now = this.now();
    const record: RecordedPlay = Object.freeze({
      scrobbleId: newId(now),
      connectionId: connection.id,
      account: connection.account,
      idempotencyKey: canonicalKey,
      evidence: deepFreeze(structuredClone(evidence)),
      receivedAt: now,
    });
    // Standing precedes counting: a braked connection holds every play it is sent
    // (`held` / `braked`), whatever the script's progression says of the counting rule.
    const steps: readonly ReceiptStep[] | null =
      connection.status === 'braked'
        ? [{ afterMs: 0, state: 'held', reason: 'braked' }]
        : checkedProgression(progression(record, { filmInLibrary: this.#inLibrary(evidence) }));
    if (steps === null) {
      throw new TypeError('MockScript.progression returned steps the mock cannot honour');
    }
    return {
      record,
      steps,
      titleId: newId(now),
      episodeId: evidence.kind === 'episode' ? newId(now) : null,
    };
  }

  /** Stores a play `newPlay` made. */
  keep(play: StoredPlay): void {
    const { record } = play;
    this.plays.push(record);
    this.#playsById.set(record.scrobbleId, play);
    this.#playsByKey.set(`${record.connectionId}\n${record.idempotencyKey}`, play);
  }

  /** A stored play of the film `evidence` names, from any connection, ends in the library. */
  #inLibrary(evidence: WirePlay): boolean {
    for (const play of this.#playsById.values()) {
      const last = play.steps.at(-1)?.state;
      if (last !== undefined && IN_LIBRARY.has(last) && sameFilm(play.record.evidence, evidence)) {
        return true;
      }
    }
    return false;
  }

  /** The play `canonical` names, when `connection` sent it. */
  playOf(connection: Connection, canonical: string): StoredPlay | undefined {
    const play = this.#playsById.get(canonical);
    return play?.record.connectionId === connection.id ? play : undefined;
  }

  #pruneConnections(): void {
    const now = this.now();
    for (const [hash, connection] of this.#connections) {
      if (
        connection.revoked ||
        connection.expiresAt <= now ||
        connection.absoluteExpiresAt <= now
      ) {
        this.#connections.delete(hash);
      }
    }
  }
}
