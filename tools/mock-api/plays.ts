/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Plays and their receipts, as the server rules them: the wire's states and reasons, the counting
// rule the door applies (`counting.verdict`), what a stored play's receipt reads over time, and
// whether a film is already in the library. Each rule names the server constant or function it
// mirrors. What the mock keeps of them is state.ts.

import type { components } from '../../packages/api/src/generated/schema';

const SECOND_MS = 1000;

type Schemas = components['schemas'];
export type ReceiptState = Schemas['PlayReceiptResponse']['state'];
export type ReceiptReason = NonNullable<Schemas['PlayReceiptResponse']['reason']>;
export type WirePlay = Schemas['PlayEvidence'];

/** Every receipt state, total over the wire's enum (a new one is a compile error here). */
const RECEIPT_STATES: Readonly<Record<ReceiptState, true>> = {
  received: true,
  awaiting_catalog: true,
  held: true,
  needs_confirmation: true,
  recorded: true,
  duplicate: true,
  started: true,
  ignored: true,
  dismissed: true,
  expired: true,
};

/** Every reason, total over the wire's enum. */
const RECEIPT_REASONS: Readonly<Record<ReceiptReason, true>> = {
  braked: true,
  plus_lapsed: true,
  dormant_return: true,
  text_only: true,
  numbering_unconfirmed: true,
  numbering_unknown: true,
  new_player: true,
  shared_player: true,
  catalog_timeout: true,
  not_completed: true,
  medium_not_served: true,
  not_served: true,
  unknown_id: true,
  other_account: true,
  refused_player: true,
  status_stands: true,
  not_placed: true,
  revoked: true,
  account_deletion: true,
  user: true,
};

export const isReceiptState = (value: unknown): value is ReceiptState =>
  typeof value === 'string' && Object.hasOwn(RECEIPT_STATES, value);
export const isReceiptReason = (value: unknown): value is ReceiptReason =>
  typeof value === 'string' && Object.hasOwn(RECEIPT_REASONS, value);

/** One step of a receipt's progression: from `afterMs` after arrival, it reads `state`. */
export interface ReceiptStep {
  readonly afterMs: number;
  readonly state: ReceiptState;
  readonly reason?: ReceiptReason | null;
  /** The question key the receipt read answers; only a `held` or `needs_confirmation` step has one. */
  readonly questionKey?: string | null;
}

/** A play the mock stored, as a test reads it back. */
export interface RecordedPlay {
  /** The id its `202` named: 26 lowercase Crockford characters. */
  readonly scrobbleId: string;
  /** The connection that sent it. */
  readonly connectionId: string;
  /** The account that connection acts for (`MockState.account` when it signed in). */
  readonly account: string;
  /** Its `Idempotency-Key`, canonical (lowercase, hyphenated). */
  readonly idempotencyKey: string;
  /** The body as sent and validated (deeply frozen). */
  readonly evidence: WirePlay;
  /** When it arrived, on the mock's clock. */
  readonly receivedAt: number;
}

export interface StoredPlay {
  readonly record: RecordedPlay;
  readonly steps: readonly ReceiptStep[];
  readonly titleId: string;
  readonly episodeId: string | null;
}

/** `START_FLOOR_SECONDS`. */
export const START_FLOOR_SECONDS = 300;

/** `START_THRESHOLD_PERCENTS`: the account's choices; `null` is starts off, the default. */
export type StartThresholdPercent = 5 | 10 | 20;
export const isStartThreshold = (x: unknown): x is StartThresholdPercent | null =>
  x === null || x === 5 || x === 10 || x === 20;
/** `FINISH_THRESHOLD_PERCENTS`: the account's choices; 70 by default, never none. */
export type FinishThresholdPercent = 50 | 70 | 90;
export const isFinishThreshold = (x: unknown): x is FinishThresholdPercent =>
  x === 50 || x === 70 || x === 90;
/** `DEFAULT_FINISH_THRESHOLD_PERCENT`. */
export const DEFAULT_FINISH_THRESHOLD_PERCENT: FinishThresholdPercent = 70;

/** The account's counting settings as the server's `CountingRule` reads them: its two lines. */
export interface CountingRule {
  readonly startThresholdPercent: StartThresholdPercent | null;
  readonly finishThresholdPercent: FinishThresholdPercent;
}

/** `counting.base_seconds`: the story when sent, else the running time. */
const baseOf = (e: WirePlay): number | null => e.story_seconds ?? e.duration_seconds ?? null;
/** `counting.measured_seconds`: the seconds played when sent, else the furthest position. */
const measureOf = (e: WirePlay): number | null =>
  e.played_seconds ?? e.furthest_position_seconds ?? null;
/** `counting.share_line_seconds`: a ceiling division, as the server draws its lines. */
const shareLine = (percent: number, length: number): number => Math.ceil((percent * length) / 100);

/**
 * `counting.verdict` for the plays route: a start is the start line's; a viewing counts with no
 * numbers at all, at `ended`, or once the measure reaches the finish line over the base — no
 * floor. Anything else is `not_counted`.
 */
export function countingVerdict(
  e: WirePlay,
  rule: CountingRule,
): 'viewing' | 'start' | 'not_counted' {
  const base = baseOf(e);
  const measure = measureOf(e);
  if (e.report === 'start') {
    const percent = rule.startThresholdPercent;
    if (e.kind !== 'movie' || percent === null || base === null || measure === null) {
      return 'not_counted';
    }
    return measure >= Math.max(shareLine(percent, base), START_FLOOR_SECONDS)
      ? 'start'
      : 'not_counted';
  }
  const noNumbers =
    e.ended == null &&
    e.duration_seconds == null &&
    e.furthest_position_seconds == null &&
    e.story_seconds == null &&
    e.played_seconds == null;
  if (noNumbers || e.ended === true) return 'viewing';
  if (base === null || measure === null) return 'not_counted';
  return measure >= shareLine(rule.finishThresholdPercent, base) ? 'viewing' : 'not_counted';
}

/** What the mock knows when it decides a play: whether the play's film is in the library. */
export interface Decided {
  /** A stored play of the same film was, or will be, recorded, a duplicate, or started. */
  readonly filmInLibrary: boolean;
}

/**
 * What a play reads as by default: received, then decided 5 seconds later — a viewing as
 * `recorded`, since the door answered every viewing the account's lines do not count and kept
 * none; a start as `started`, or `ignored` / `status_stands` when its film is already in the
 * library (a start never moves a film in progress, finished or dropped).
 */
export function defaultProgression(
  play: RecordedPlay,
  decided: Decided = { filmInLibrary: false },
): readonly ReceiptStep[] {
  const later = 5 * SECOND_MS;
  if (play.evidence.report === 'start') {
    return [
      { afterMs: 0, state: 'received' },
      decided.filmInLibrary
        ? { afterMs: later, state: 'ignored', reason: 'status_stands' }
        : { afterMs: later, state: 'started' },
    ];
  }
  return [
    { afterMs: 0, state: 'received' },
    { afterMs: later, state: 'recorded' },
  ];
}

/** The final states that leave a film in the library. */
export const IN_LIBRARY: ReadonlySet<ReceiptState> = new Set(['recorded', 'duplicate', 'started']);

/**
 * Two plays name one film, as far as the mock can tell without a catalog: a TMDB or IMDb id or a
 * provider entry in common, else the same title and no year that disagrees.
 */
export function sameFilm(a: WirePlay, b: WirePlay): boolean {
  if (a.kind !== 'movie' || b.kind !== 'movie') return false;
  if (shareAnId(a.ids ?? null, b.ids ?? null)) return true;
  const title = (p: WirePlay): string | null => p.title?.trim().toLowerCase() ?? null;
  const name = title(a);
  return (
    name !== null && name === title(b) && (a.year == null || b.year == null || a.year === b.year)
  );
}

/** Two plays' ids name one title: the same TMDB or IMDb id, or a provider entry in common. */
function shareAnId(a: WirePlay['ids'] | null, b: WirePlay['ids'] | null): boolean {
  if (a?.tmdb != null && a.tmdb === b?.tmdb) return true;
  if (a?.imdb != null && a.imdb === b?.imdb) return true;
  const entry = (e: { namespace: string; key: string; value: string }): string =>
    `${e.namespace}\n${e.key}\n${e.value}`;
  const theirs = new Set((b?.provider ?? []).map(entry));
  return (a?.provider ?? []).some((e) => theirs.has(entry(e)));
}

/** The most steps a progression may have. */
const MAX_STEPS = 32;

/**
 * `steps` when it is a progression the mock can honour — 1 to 32 steps, the first at 0, times
 * finite and not decreasing, every state and reason one of the wire's — else `null`.
 */
export function checkedProgression(steps: unknown): readonly ReceiptStep[] | null {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) return null;
  const out: ReceiptStep[] = [];
  let previous = 0;
  for (const step of steps as unknown[]) {
    const checked = checkedStep(step, previous, out.length === 0);
    if (checked === null) return null;
    out.push(checked);
    previous = checked.afterMs;
  }
  return out;
}

/** One step, when it can follow a step at `previous` (the first must be at 0); else `null`. */
function checkedStep(step: unknown, previous: number, first: boolean): ReceiptStep | null {
  if (typeof step !== 'object' || step === null) return null;
  const { afterMs, state, reason, questionKey } = step as Record<string, unknown>;
  if (typeof afterMs !== 'number' || !Number.isFinite(afterMs) || afterMs < previous) return null;
  if (first && afterMs !== 0) return null;
  if (!isReceiptState(state)) return null;
  if (!(reason === undefined || reason === null || isReceiptReason(reason))) return null;
  if (!(questionKey === undefined || questionKey === null || typeof questionKey === 'string')) {
    return null;
  }
  return { afterMs, state, reason: reason ?? null, questionKey: questionKey ?? null };
}

/** The step a play reads at `nowMs`. */
export function stepAt(play: StoredPlay, nowMs: number): ReceiptStep {
  const elapsed = nowMs - play.record.receivedAt;
  let current = play.steps[0] ?? { afterMs: 0, state: 'received' };
  for (const step of play.steps) {
    if (step.afterMs > elapsed) break;
    current = step;
  }
  return current;
}
