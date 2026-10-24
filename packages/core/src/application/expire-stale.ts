/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isTooOld } from '../domain/outbox';
import { reportAllowed } from '../domain/settings';
import { DAY_MS, HOUR_MS } from '../domain/time';
import { VIEWING_IDLE_MS, reportVerdict } from '../domain/viewing';
import type {
  AccountRules,
  Clock,
  Diagnostics,
  Outbox,
  PlayHistory,
  Scheduler,
  Settings,
  ViewingStore,
} from './ports';
import type { ReportViewing } from './report-viewing';
import type { ViewingLock } from './viewing-lock';

/** The diagnostics log keeps a week and at most 500 entries. */
export const DIAGNOSTICS_RETENTION_MS = 7 * DAY_MS;
export const DIAGNOSTICS_MAX_ENTRIES = 500;
/** How often retention runs; it schedules itself again each time. */
export const EXPIRE_INTERVAL_MS = 6 * HOUR_MS;

interface Deps {
  readonly viewings: ViewingStore;
  readonly history: PlayHistory;
  readonly outbox: Outbox;
  readonly diagnostics: Diagnostics;
  readonly settings: Settings;
  /** The account's lines, for a viewing a stopped report left behind. */
  readonly rules: AccountRules;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly report: ReportViewing;
  readonly lock: ViewingLock;
}

/**
 * Retention: how long each thing kept in the browser lives. A viewing idle for 7 days is
 * dropped, readings and all — unless it is still reportable, which only a report stopped
 * part-way leaves behind: that one is sent first — and so is a tab state not observed for 7
 * days, whose pending reading names a title. History past the person's `historyDays` goes,
 * once the viewings that knew their play went only from it have recorded it; an outbox entry
 * that can no longer be accepted becomes a dead letter, and a dead letter goes with the history
 * of its age. Diagnostics keep a week and 500 entries.
 */
export class ExpireStale {
  readonly #deps: Deps;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  async execute(): Promise<void> {
    const { viewings, history, outbox, diagnostics, settings, clock, scheduler, report, lock } =
      this.#deps;
    const now = clock.now();
    const config = await settings.get();
    const keptSince = now - config.historyDays * DAY_MS;

    await lock.run(async (held) => {
      const idle = await viewings.idleBefore(now - VIEWING_IDLE_MS);
      // A viewing short of the account's finish line is dropped here, never sent.
      const rule = idle.length === 0 ? null : await this.#deps.rules.get();
      for (const v of idle) {
        if (
          rule !== null &&
          v.state === 'open' &&
          reportVerdict(v, rule.finishThresholdPercent).kind === 'report' &&
          reportAllowed(v, config)
        ) {
          await report.executeHeld(v, held, { rule });
        }
      }
      if (idle.length > 0) await viewings.remove(idle.map((v) => v.id));
      await viewings.dropTabsIdleBefore(now - VIEWING_IDLE_MS);

      // A history kept fewer days than a viewing stays open can forget a play its viewing
      // still holds unrecorded: the viewing records it first.
      await report.recordDeliveredHeld(held);
      const old = await history.olderThan(keptSince);
      if (old.length > 0) await history.remove(old);
    });

    for (const e of await outbox.list()) {
      if (e.state === 'dead') {
        if (e.createdAt < keptSince) await outbox.remove(e.playId);
      } else if (isTooOld(e, now)) {
        await outbox.put({ ...e, state: 'dead', lastError: 'too_old' });
      }
    }

    await diagnostics.prune(now - DIAGNOSTICS_RETENTION_MS, DIAGNOSTICS_MAX_ENTRIES);
    await scheduler.at('expire', now + EXPIRE_INTERVAL_MS);
  }
}
