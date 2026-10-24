/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MessageKey } from './messages';
import { isStart } from './play';
import type { PlayBody } from './play';

export type ReceiptState =
  | 'received'
  | 'awaiting_catalog'
  | 'needs_confirmation'
  | 'held'
  | 'recorded'
  | 'duplicate'
  | 'started'
  | 'ignored'
  | 'dismissed'
  | 'expired';

/** What the person sees for an answer. Display only: nothing decides from it. */
export interface ReceiptView {
  readonly tone: 'done' | 'waiting' | 'attention' | 'neutral';
  readonly messageKey: MessageKey;
  readonly link: 'waiting' | 'title' | 'upgrade' | 'connections' | null;
  /** The server will not change this answer. */
  readonly settled: boolean;
}

const view = (
  tone: ReceiptView['tone'],
  messageKey: MessageKey,
  link: ReceiptView['link'],
  settled: boolean,
): ReceiptView => ({ tone, messageKey, link, settled });

const UNKNOWN = view('neutral', 'receipt.unknown', null, false);

const NOT_TRACKED = view('neutral', 'receipt.ignored.not_tracked', null, true);

// Own-property lookups only: a state from the wire is never a prototype key.
const BY_STATE: ReadonlyMap<string, ReceiptView> = new Map([
  ['recorded', view('done', 'receipt.recorded', 'title', true)],
  ['duplicate', view('done', 'receipt.duplicate', 'title', true)],
  // Only a start is answered so: the film is in the library now, nothing in the diary.
  ['started', view('done', 'receipt.started', 'title', true)],
  ['received', view('waiting', 'receipt.received', null, false)],
  ['awaiting_catalog', view('waiting', 'receipt.awaiting_catalog', null, false)],
  ['needs_confirmation', view('attention', 'receipt.needs_confirmation', 'waiting', false)],
  ['expired', view('neutral', 'receipt.expired', null, true)],
]);

const BY_STATE_AND_REASON: ReadonlyMap<string, ReceiptView> = new Map([
  ['held/plus_lapsed', view('attention', 'receipt.held.plus_lapsed', 'upgrade', false)],
  ['held/braked', view('attention', 'receipt.held.braked', 'connections', false)],
  ['held/dormant_return', view('attention', 'receipt.held.dormant_return', 'connections', false)],
  ['ignored/not_completed', view('neutral', 'receipt.ignored.not_completed', null, true)],
  ['ignored/unknown_id', NOT_TRACKED],
  ['ignored/not_served', NOT_TRACKED],
  ['ignored/medium_not_served', NOT_TRACKED],
  // A start's: the film was already in progress, finished or dropped, and a start moves none.
  ['ignored/status_stands', view('done', 'receipt.ignored.status_stands', 'title', true)],
  // A start's: it never asks which film, so one it cannot place at once is set aside.
  ['ignored/not_placed', view('neutral', 'receipt.ignored.not_placed', null, true)],
  ['dismissed/user', view('neutral', 'receipt.dismissed.user', null, true)],
  ['dismissed/revoked', view('attention', 'receipt.dismissed.revoked', 'connections', true)],
  ['dismissed/account_deletion', view('neutral', 'receipt.dismissed.account_deletion', null, true)],
]);

/**
 * A start the account's rule did not take: starts are off, or the line moved since the last
 * check. Nothing was kept and nothing went wrong, so it is said plainly, never as an error.
 */
const START_NOT_TAKEN = view('neutral', 'receipt.start.not_taken', null, true);

/**
 * Total: an unknown state or reason is neutral and unsettled. `start`: the answer is a start's,
 * whose `not_completed` means the account's rule did not take it.
 */
export function receiptView(
  state: ReceiptState,
  reason: string | null,
  start = false,
): ReceiptView {
  if (start && state === 'ignored' && reason === 'not_completed') return START_NOT_TAKEN;
  const byState = BY_STATE.get(state);
  if (byState !== undefined) return byState;
  return BY_STATE_AND_REASON.get(`${state}/${reason ?? ''}`) ?? UNKNOWN;
}

/**
 * The server no longer has the receipt (a `404`: sent under an earlier connection, removed,
 * or the feature closed). Whatever it last said, this play is no longer followed here — it
 * is never shown as waiting; the app is where its state is.
 */
const NO_LONGER_TRACKED = view('neutral', 'receipt.no_longer_tracked', null, true);

/**
 * How a sent play is shown: its last answer, unless the server no longer has it. Given the
 * body, a start's answer is read as a start's.
 */
export function sentPlayView(t: {
  readonly receipt: { readonly state: ReceiptState; readonly reason: string | null } | null;
  readonly receiptGoneAt: number | null;
  readonly body?: PlayBody;
}): ReceiptView {
  if (t.receiptGoneAt !== null) return NO_LONGER_TRACKED;
  if (t.receipt === null) return UNKNOWN;
  const start = t.body !== undefined && isStart(t.body);
  return receiptView(t.receipt.state, t.receipt.reason, start);
}
