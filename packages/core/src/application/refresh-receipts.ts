/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  RECEIPT_POPUP_READ_LIMIT,
  RECEIPT_READS_AT_ONCE,
  nextReceiptRead,
} from '../domain/receipt-schedule';
import type { ReceiptReadReason } from '../domain/receipt-schedule';
import type { EpochMs } from '../domain/time';
import { credentialRefused } from './credential-refused';
import type {
  Clock,
  ConnectionRepo,
  HistoryEntry,
  Outbox,
  PlayHistory,
  PlaysGateway,
  ReceiptResult,
  Scheduler,
} from './ports';
import { SingleFlight } from './single-flight';

interface Deps {
  readonly history: PlayHistory;
  readonly gateway: PlaysGateway;
  readonly connection: ConnectionRepo;
  readonly outbox: Outbox;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
}

/** A sent play whose receipt can be read: the `202` kept it. */
type Readable = HistoryEntry & { readonly scrobbleId: string };

/** One receipt read, and when it came back. */
interface Read {
  readonly playId: string;
  readonly result: ReceiptResult;
  readonly at: EpochMs;
}

/**
 * Reads the receipts that are due by their schedule (`nextReceiptRead`): +10 s, +1 min, +5 min
 * and +15 min after sending, then hourly through the first day and every 6 hours after, and when
 * the popup opens at most once a minute per play, until it settles or 30 days pass. A few reads
 * go out at once (`RECEIPT_READS_AT_ONCE`), so a popup over many waiting plays is current in a
 * few round trips rather than one per play.
 */
export class RefreshReceipts {
  readonly #deps: Deps;
  readonly #flight = new SingleFlight();

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  execute(opts: { readonly reason: ReceiptReadReason }): Promise<void> {
    return this.#flight.run(() => this.#refresh(opts.reason));
  }

  async #refresh(reason: ReceiptReadReason): Promise<void> {
    const { history, connection, outbox, clock, scheduler } = this.#deps;
    const started = await connection.get();
    if (started.kind !== 'connected') return;
    // Only the plays of the account the connection acts for are asked about, once a check has
    // named it: another account's would be asked about with this one's credential.
    const known = await connection.account();
    if (known.kind !== 'read') return;

    // Opening the popup reads the plays still waiting, newest first and not many: what the
    // person looks at is current — a play the server has decided since, or a question they
    // answered in the app.
    const unsettled = (await history.unsettled()).filter((e) => e.accountKey === known.key);
    const ordered =
      reason === 'popup' ? [...unsettled].sort((a, b) => b.sentAt - a.sentAt) : unsettled;
    const asOf = clock.now();
    const due = ordered.filter((entry) => isDue(entry, reason, asOf));
    const pass = reason === 'popup' ? due.slice(0, RECEIPT_POPUP_READ_LIMIT) : due;

    for (let i = 0; i < pass.length; i += RECEIPT_READS_AT_ONCE) {
      const batch = pass.slice(i, i + RECEIPT_READS_AT_ONCE);
      const reads = await Promise.all(batch.map((entry) => this.#read(entry)));
      let refused = false;
      for (const { playId, result, at } of reads) {
        if (result.kind === 'credential_invalid') refused = true;
        // An entry cleared from the history while its answer was read stays cleared.
        else await history.update(playId, (entry) => answered(entry, result, at));
      }
      if (refused) {
        await credentialRefused(connection, outbox, started);
        await scheduler.clear('receipts');
        return;
      }
    }

    // The pass knows every play's next read: it replaces the alarm with the earliest. Clear
    // first, then read, then set: a play recorded meanwhile is either read here or asked for
    // its own +10 s read after the clear, which earliest-wins then keeps.
    await scheduler.clear('receipts');
    const now = clock.now();
    const times = (await history.unsettled())
      .map((e) => nextReceiptRead(e, 'scheduled', now))
      .filter((t) => t !== null);
    if (times.length > 0) await scheduler.at('receipts', Math.max(Math.min(...times), now));
  }

  /** A throw is no answer: the read counts as made, and the schedule moves on. */
  async #read(entry: Readable): Promise<Read> {
    const { gateway, clock } = this.#deps;
    let result: ReceiptResult;
    try {
      result = await gateway.receipt(entry.scrobbleId);
    } catch {
      result = { kind: 'unavailable' };
    }
    return { playId: entry.playId, result, at: clock.now() };
  }
}

/** The play has a receipt to read, and its read is due by now. */
function isDue(entry: HistoryEntry, reason: ReceiptReadReason, now: EpochMs): entry is Readable {
  const due = nextReceiptRead(entry, reason, now);
  return entry.scrobbleId !== null && due !== null && due <= now;
}

/** The entry after one read. A failed read still counts, so an outage never loops. */
function answered(
  entry: HistoryEntry,
  result: Exclude<ReceiptResult, { kind: 'credential_invalid' }>,
  readAt: EpochMs,
): HistoryEntry {
  switch (result.kind) {
    case 'ok':
      return {
        ...entry,
        receipt: {
          state: result.state,
          reason: result.reason,
          titleId: result.titleId,
          questionKey: result.questionKey,
        },
        receiptReadAt: readAt,
      };
    // The server has no such receipt for this credential (sent under an earlier connection,
    // removed, or the feature closed): tracking this play ends — "no longer tracked", never
    // waiting. Its last answer and scrobble id stay as the record of what was said.
    case 'not_found':
      return { ...entry, receiptReadAt: readAt, receiptGoneAt: readAt };
    case 'unavailable':
      return { ...entry, receiptReadAt: readAt };
  }
}
