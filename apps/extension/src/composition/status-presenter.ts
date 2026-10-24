/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The toolbar: every tab's default and each tab shown on its own, computed by core's
// `computeStatus` from the connection, the pause, the tab's viewing and what waits for the
// person. What waits is read once and kept until something that changes it ran (`invalidate`).

import { computeStatus, ignoredOf, sentPlayView } from '@mt/core';
import type { EpochMs, NotTracked, SettingsValue, Status, StatusInputs, TabState } from '@mt/core';

import { siteById, siteForHostname } from '../sites';
import type { ConnectionCheck } from './connection-check';
import type { PlatformDeps } from './deps';
import type { FrameTable } from './frame-table';
import { decide, httpUrl } from './site-decision';
import { PLAYING_WINDOW_MS, readingLabel } from './support';
import type { Steps } from './support';

/** Closed tabs remembered, so a late refresh does not resurrect one. */
const MAX_CLOSED_TABS = 1024;
/** How long the check mark shows (`computeStatus`'s ~10 s). */
const ADDED_MS = 10_000;
/** A refresh the icon times for itself lands this long after the moment it changes. */
const BEAT_MS = 500;

interface Needs {
  readonly waitingCount: number;
  readonly problem: StatusInputs['problem'];
}

/** Where a tab is: its host, and whether its window is incognito. */
interface Where {
  readonly host: string;
  readonly incognito: boolean;
}

/** Where Chrome's own `tab.url` said a tab is, and the page there: its host and path. */
interface Seen extends Where {
  readonly page: string;
}

interface Deps {
  readonly platform: PlatformDeps;
  readonly check: ConnectionCheck;
  /** The tabs the frame table follows now: each is shown on its own too. */
  readonly frames: FrameTable;
  readonly steps: Steps;
}

export class StatusPresenter {
  readonly #platform: PlatformDeps;
  readonly #check: ConnectionCheck;
  readonly #frames: FrameTable;
  readonly #steps: Steps;
  readonly #statusTabs = new Set<number>();
  /** Tabs that loaded another page: dimmed (Chrome's default) until a bootstrap reports. */
  readonly #reset = new Set<number>();
  /** Where each tab is, as Chrome's own `tab.url` said at its last load or change of address. */
  readonly #seen = new Map<number, Seen>();
  /** When each tab last went to another page: what played before it is not what plays now. */
  readonly #navigatedAt = new Map<number, EpochMs>();
  readonly #closedTabs = new Set<number>();
  /** Each tab's refresh at the next moment its icon changes by itself. */
  readonly #timers = new Map<number, ReturnType<typeof setTimeout>>();
  #needs: Needs | null = null;

  constructor(deps: Deps) {
    this.#platform = deps.platform;
    this.#check = deps.check;
    this.#frames = deps.frames;
    this.#steps = deps.steps;
  }

  /**
   * The tab loads another page, and Chrome resets its icon to the default, the dimmed mark: no
   * refresh brings it back until the new page's bootstrap reports.
   */
  tabReset(tabId: number): void {
    this.#statusTabs.delete(tabId);
    this.#seen.delete(tabId);
    this.#reset.add(tabId);
    this.#navigatedAt.set(tabId, this.#platform.clock.now());
    this.#cancelTimer(tabId);
  }

  /**
   * The tab finished loading (or changed address) at `url`, which Chrome gives only for a site
   * this extension has access to (`Tab.url`): the page is known, so its own icon shows at once,
   * without waiting for a video to play. No readable address: it stays dimmed.
   */
  async tabAt(tabId: number, url: string | undefined, incognito: boolean): Promise<void> {
    const before = this.#seen.get(tabId)?.page;
    const seen = this.#see(tabId, url, incognito);
    if (seen === null) return;
    // Another page of the same document (`history.pushState`). A query or a hash alone is none: a
    // player may rewrite them as it plays.
    if (before !== undefined && before !== seen.page) {
      this.#navigatedAt.set(tabId, this.#platform.clock.now());
    }
    await this.refreshTab(tabId);
  }

  /** Remembers where Chrome says the tab is, when it gives an address this extension may read. */
  #see(tabId: number, url: string | null | undefined, incognito: boolean): Seen | null {
    const page = httpUrl(url ?? undefined);
    if (page === null) return null;
    const seen = { host: page.hostname, incognito, page: page.hostname + page.pathname };
    this.#seen.set(tabId, seen);
    return seen;
  }

  /**
   * Where the tab is: Chrome's address at its last load, else its top frame's reports, else
   * Chrome's word now — a tab whose icon a worker before this one set. `null` when the extension
   * may not read its address; `undefined` when Chrome has no such tab.
   */
  async #where(tabId: number): Promise<Where | null | undefined> {
    const seen = this.#seen.get(tabId);
    if (seen !== undefined) return seen;
    const table = this.#frames.get(tabId);
    if (table?.topHostname != null) return { host: table.topHostname, incognito: table.incognito };
    const tab = await this.#platform.tabs.get(tabId);
    return tab === null ? undefined : this.#see(tabId, tab.url, tab.incognito);
  }

  /** Why the tab's page is not tracked, from where it is and the settings. */
  #notTracked(where: Where, settings: SettingsValue): NotTracked | null {
    const decision = decide(where.host, settings);
    if (decision.kind === 'refused') {
      return decision.reason === 'disabled'
        ? { why: 'service_off', service: siteForHostname(where.host)?.name ?? where.host }
        : { why: 'site' };
    }
    return where.incognito && !settings.trackIncognito ? { why: 'incognito' } : null;
  }

  /**
   * Until when the tab records its viewing; `0` when it records nothing now. It records while
   * the media's samples reach the viewing: the last one that did was playing (nothing is recorded
   * from a pause or an end), it came after the tab last went to another page, and nothing that
   * played since went nowhere (a kept reason is always newer than it). It then records for
   * `PLAYING_WINDOW_MS` after that sample, whose time the router holds within seconds of ours.
   */
  #recordingUntil(tabId: number, tab: TabState): EpochMs {
    const last = tab.lastSample;
    if (last === null || last.paused || last.ended || ignoredOf(tab.ignored) !== null) return 0;
    return last.at > (this.#navigatedAt.get(tabId) ?? 0) ? last.at + PLAYING_WINDOW_MS : 0;
  }

  /** What waits for the person may have changed: it is read again on the next refresh. */
  invalidate(): void {
    this.#needs = null;
  }

  /** A closed tab is no longer shown, and a late refresh does not bring it back. */
  tabClosed(tabId: number): void {
    this.#statusTabs.delete(tabId);
    this.#reset.delete(tabId);
    this.#seen.delete(tabId);
    this.#navigatedAt.delete(tabId);
    // Tab ids are not reused within a browser session; the newest are remembered, bounded.
    this.#closedTabs.add(tabId);
    if (this.#closedTabs.size > MAX_CLOSED_TABS) {
      const oldest = this.#closedTabs.values().next().value;
      if (oldest !== undefined) this.#closedTabs.delete(oldest);
    }
    this.#cancelTimer(tabId);
  }

  /** *Clear all local data*: no refresh is waiting to run. */
  clearTimers(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  #cancelTimer(tabId: number): void {
    clearTimeout(this.#timers.get(tabId));
    this.#timers.delete(tabId);
  }

  async refreshTab(tabId: number): Promise<void> {
    // A closed tab has nothing to show on, and must not come back into the set below.
    if (this.#closedTabs.has(tabId)) return;
    this.#reset.delete(tabId);
    await this.#steps.guard('status.tab', async () => {
      const { viewings, status, clock, settings } = this.#platform;
      const where = await this.#where(tabId);
      if (where === undefined) {
        this.tabClosed(tabId);
        return;
      }
      const tab = await viewings.tabState(tabId);
      const viewing = tab?.viewingId == null ? null : await viewings.byId(tab.viewingId);
      const label =
        viewing === null
          ? ''
          : readingLabel(viewing.reading) || (siteById(viewing.serviceId ?? '')?.name ?? '');
      const config = await settings.get();
      const now = clock.now();
      const until =
        tab !== null && viewing?.state === 'open' ? this.#recordingUntil(tabId, tab) : 0;
      const addedAt = tab?.addedAt ?? null;
      // A tab whose address may not be read now shows what every tab without its own does.
      const shown =
        where === null
          ? null
          : {
              tracking: now <= until ? { label } : null,
              addedAt,
              addedLabel: tab?.addedLabel ?? null,
              notTracked: this.#notTracked(where, config),
            };
      await status.show(tabId, await this.#statusOf(shown, config));
      if (this.#closedTabs.has(tabId)) return;
      this.#statusTabs.add(tabId);
      // The icon changes by itself when the check mark comes down or the recording stops.
      const changes = [addedAt === null ? 0 : addedAt + ADDED_MS, until].filter((at) => at >= now);
      this.#refreshAt(tabId, Math.min(...changes), now);
    });
  }

  /** The tab's next refresh, just past `at` (none for `Infinity`); it replaces any earlier one. */
  #refreshAt(tabId: number, at: number, now: EpochMs): void {
    this.#cancelTimer(tabId);
    if (at === Infinity) return;
    const timer = setTimeout(
      () => {
        this.#timers.delete(tabId);
        void this.refreshTab(tabId);
      },
      at + BEAT_MS - now,
    );
    this.#timers.set(tabId, timer);
  }

  /**
   * Every tab's default, then each tab shown on its own (their badge is the default's too): those
   * this worker showed or follows, and every open tab whose address it may read — Chrome keeps a
   * tab's own icon across a restart of the worker, which knows nothing of the one before.
   */
  async refreshAll(): Promise<void> {
    await this.#steps.guard('status.global', async () => {
      const config = await this.#platform.settings.get();
      await this.#platform.status.show(null, await this.#statusOf(null, config));
    });
    const open = await this.#platform.bootstrap.openTabs();
    const tabIds = [...this.#statusTabs, ...this.#frames.tabIds(), ...open.map((t) => t.tabId)];
    for (const tabId of new Set(tabIds)) {
      if (!this.#reset.has(tabId)) await this.refreshTab(tabId);
    }
  }

  /** Plays waiting for the person, and a problem the server holds them for. */
  async #needsNow(): Promise<Needs> {
    if (this.#needs !== null) return this.#needs;
    let waitingCount = 0;
    let braked = false;
    let lapsed = false;
    for (const entry of await this.#platform.history.unsettled()) {
      const key = sentPlayView(entry).messageKey;
      if (key === 'receipt.needs_confirmation') waitingCount += 1;
      else if (key === 'receipt.held.braked') braked = true;
      else if (key === 'receipt.held.plus_lapsed') lapsed = true;
    }
    // The connection check's word counts as much as a held play's.
    if (!braked) {
      const check = await this.#check.view(await this.#platform.connection.get());
      braked = check?.status === 'braked';
    }
    const needs: Needs = {
      waitingCount,
      problem: braked ? 'braked' : lapsed ? 'plus_lapsed' : null,
    };
    this.#needs = needs;
    return needs;
  }

  /** What `tab` shows (`null`: every tab's default), under the settings the caller read. */
  async #statusOf(tab: StatusInputs['tab'], config: SettingsValue): Promise<Status> {
    const { connection, clock } = this.#platform;
    const [state, needs] = await Promise.all([connection.get(), this.#needsNow()]);
    return computeStatus({
      connection: state,
      pausedUntil: config.pausedUntil,
      now: clock.now(),
      tab,
      waitingCount: needs.waitingCount,
      problem: needs.problem,
    });
  }
}
