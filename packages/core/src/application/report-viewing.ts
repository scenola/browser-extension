/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { dueStart, startPlayIdOf, startSentAtOf } from '../domain/account-rule';
import type { AccountRule } from '../domain/account-rule';
import type { OutboxEntry } from '../domain/outbox';
import { buildPlay, playLabel } from '../domain/play';
import { reportVerdict } from '../domain/viewing';
import type { Viewing } from '../domain/viewing';
import type { AccountKey, Clock, Ids, Outbox, PlayHistory, Scheduler, ViewingStore } from './ports';
import type { LockHeld, ViewingLock } from './viewing-lock';

interface Deps {
  readonly viewings: ViewingStore;
  readonly outbox: Outbox;
  readonly history: PlayHistory;
  readonly ids: Ids;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly lock: ViewingLock;
  /** The account a play is recorded for now (`keyOf` the stored connection); `null`: none known. */
  readonly accountKey: () => Promise<AccountKey | null>;
}

export interface ReportOptions {
  /** The tab that shows "Added" for it. */
  readonly tabId?: number;
  /**
   * The account's rule in force now, read by the caller from what the connection check kept.
   * Required: a report is never judged by a line nobody read.
   */
  readonly rule: AccountRule;
}

/**
 * A viewing at the account's finish line → a play → the outbox, before any network call.
 *
 * Inside the viewing lock, so two reports of one viewing at once are one play. Three writes,
 * ordered so that stopping between any two of them neither loses the play nor makes it two:
 * the play's id is reserved on the viewing first, so a report that runs again reuses it; the
 * entry is added only if that id is neither queued nor already delivered; then the viewing
 * is closed. A viewing already closed is left alone.
 */
export class ReportViewing {
  readonly #deps: Deps;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  /** From outside the viewing lock: takes it. (From inside it this would wait on itself.) */
  execute(viewing: Viewing, options: ReportOptions): Promise<void> {
    return this.#deps.lock.run(() => this.#report(viewing, options));
  }

  /** From inside the viewing lock: the running task's proof is required, and checked. */
  async executeHeld(viewing: Viewing, held: LockHeld, options: ReportOptions): Promise<void> {
    this.#holds(held);
    await this.#report(viewing, options);
  }

  /**
   * From inside the viewing lock, before the history forgets plays (retention, *Clear history*).
   * A report stopped between its writes leaves its viewing open with the play's id reserved, and
   * then only the history says whether that play went (`#enqueue` asks it). A viewing whose
   * reserved play or start the history holds records it as queued now, so a report run again
   * once the history has forgotten it cannot queue it a second time.
   */
  async recordDeliveredHeld(held: LockHeld): Promise<void> {
    this.#holds(held);
    const { viewings, history } = this.#deps;
    // Every viewing: none has a sample from after the end of time.
    for (const viewing of await viewings.idleBefore(Number.MAX_SAFE_INTEGER)) {
      if (viewing.state !== 'open') continue;
      const playId = viewing.reportedPlayId;
      if (playId !== null && (await history.byPlayId(playId)) !== null) {
        await viewings.put({ ...viewing, state: 'reported' });
        continue;
      }
      const startId = startSentAtOf(viewing) === null ? startPlayIdOf(viewing) : null;
      const start = startId === null ? null : await history.byPlayId(startId);
      if (start !== null) await viewings.put({ ...viewing, startSentAt: start.sentAt });
    }
  }

  #holds(held: LockHeld): void {
    if (!this.#deps.lock.holds(held)) {
      throw new Error('ReportViewing: that lock proof is not the running task’s');
    }
  }

  /** The entry, added unless its id was already delivered: a report run again adds nothing. */
  async #enqueue(
    entry: Pick<OutboxEntry, 'playId' | 'viewingId' | 'body' | 'watchedAt'>,
  ): Promise<void> {
    const { outbox, history, clock, accountKey } = this.#deps;
    if ((await history.byPlayId(entry.playId)) !== null) return;
    const now = clock.now();
    await outbox.add({
      ...entry,
      createdAt: now,
      attempts: 0,
      nextAttemptAt: now,
      state: 'pending',
      lastError: null,
      accountKey: await accountKey(),
    });
  }

  async #report(viewing: Viewing, { tabId, rule }: ReportOptions): Promise<void> {
    const { viewings, ids, clock, scheduler } = this.#deps;
    const current = (await viewings.byId(viewing.id)) ?? viewing;
    if (current.state !== 'open') return;
    // Not reportable now (another tab's sample can grow the duration): nothing to do yet.
    const verdict = reportVerdict(current, rule.finishThresholdPercent);
    if (verdict.kind !== 'report') return;
    // A viewing that cannot become a play stays open: a later reading may complete it.
    const body = buildPlay(current, verdict.watchedAt, clock.offsetMinutes(verdict.watchedAt));
    if (body === null) return;

    const now = clock.now();
    const playId = current.reportedPlayId ?? ids.playId();
    if (current.reportedPlayId === null) await viewings.put({ ...current, reportedPlayId: playId });
    await this.#enqueue({ playId, viewingId: current.id, body, watchedAt: verdict.watchedAt });
    await viewings.put({ ...current, reportedPlayId: playId, state: 'reported' });

    if (tabId !== undefined) {
      const tab = await viewings.tabState(tabId);
      if (tab !== null) {
        await viewings.putTabState({ ...tab, addedAt: now, addedLabel: playLabel(body) });
      }
    }
    await scheduler.at('outbox', now);
  }

  /**
   * A film begun → its start → the outbox, from inside the viewing lock, when the account's
   * `rule` makes one due (`dueStart`). `true` when it queued one. The same three writes as a
   * play's, in the same order: the start's id is reserved on the viewing, the entry is added
   * unless that id was already delivered, then the viewing records that its start was queued.
   * The viewing stays open: its own play is reported when it counts, under its own key.
   */
  async startHeld(viewing: Viewing, held: LockHeld, rule: AccountRule): Promise<boolean> {
    this.#holds(held);
    const { viewings, ids, clock, scheduler } = this.#deps;
    const current = (await viewings.byId(viewing.id)) ?? viewing;
    const body = dueStart(current, rule);
    if (body === null) return false;

    const now = clock.now();
    const reserved = startPlayIdOf(current);
    const playId = reserved ?? ids.playId();
    if (reserved === null) await viewings.put({ ...current, startPlayId: playId });
    // A start says no `watched_at`: its 29 days count from the moment it is queued.
    await this.#enqueue({ playId, viewingId: current.id, body, watchedAt: now });
    await viewings.put({ ...current, startPlayId: playId, startSentAt: now });
    await scheduler.at('outbox', now);
    return true;
  }
}
