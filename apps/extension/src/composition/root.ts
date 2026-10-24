/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The composition root: the only place that constructs the use cases, and the worker's one
// handler of what arrives — content messages, UI requests, alarms, tab and browser events. It
// knows no concrete class: background.ts hands it the ports. It wires the parts and handles the
// lifecycle; each part is a module of its own:
//
//   - content-router.ts: content scripts' messages → the frame table (frame-table.ts), whose
//     observations go to core's `IngestObservation` here;
//   - ui-requests.ts: every `ui/*` request, and the state the pages render;
//   - status-presenter.ts: the toolbar;
//   - sync-loop.ts: the outbox, the receipts and the connection check (connection-check.ts).
//
// What it holds in memory may be lost at any moment (the worker stops): the per-tab frame table
// (each frame's latest report, for 30 s) and the coalescing timers. Losing them costs at most
// the sample in flight — never a viewing or a play: every viewing, tab state and play is in
// IndexedDB, written inside core's use cases before any network call, and every retry reuses
// the play's own `Idempotency-Key`.

import {
  ClearHistory,
  ConfirmAccount,
  Connect,
  Disconnect,
  DrainOutbox,
  EXPIRE_INTERVAL_MS,
  ExpireStale,
  IngestObservation,
  PauseTracking,
  RefreshReceipts,
  ReportViewing,
  SkipViewing,
  ViewingLock,
  isBlockedHost,
  keyOf,
} from '@mt/core';
import type { FrameReport, PlaysGateway } from '@mt/core';

import type {
  BootstrapAnswer,
  CollectorAnswer,
  PopupState,
  UiResponseMessage,
} from '../messaging/protocol';
import { coversHost, siteForHostname } from '../sites';
import { ConnectionCheck } from './connection-check';
import { ContentRouter } from './content-router';
import type { ContentSender } from './content-router';
import type { PlatformDeps } from './deps';
import { FrameTable } from './frame-table';
import type { TabFrames } from './frame-table';
import { InterpretationCache } from './interpretation-cache';
import { httpUrl } from './site-decision';
import { StatusPresenter } from './status-presenter';
import { Listeners, Steps, errorName } from './support';
import { SyncLoop } from './sync-loop';
import { UiRequests } from './ui-requests';

export type { PlatformDeps } from './deps';

export interface Root {
  /** A content script's message; the answer goes back to it (`undefined`: none). */
  onContentMessage(
    raw: unknown,
    sender: ContentSender,
  ): Promise<BootstrapAnswer | CollectorAnswer | undefined>;
  /** A page's request over the `ui` port; `null` when it was not one to answer. */
  onUiRequest(raw: unknown): Promise<UiResponseMessage | null>;
  /**
   * A page opened its `ui` port: waiting plays are re-read, at most once a minute each, and the
   * connection is checked, at most once a minute.
   */
  onUiOpened(): Promise<void>;
  onAlarm(name: string): Promise<void>;
  onTabRemoved(tabId: number): Promise<void>;
  /** The tab loads another page: it shows the dimmed default until a bootstrap reports. */
  onTabLoading(tabId: number): void;
  /** The tab finished loading, or changed address, at `url` (given only for a site we may see). */
  onTabAt(tabId: number, url: string | undefined, incognito: boolean): Promise<void>;
  /** The browser started: tab ids from before mean nothing. */
  onStartup(): Promise<void>;
  /** The worker started, for whatever reason. */
  onWake(): Promise<void>;
  /** `runtime.onInstalled`, with its `reason` (`install`, `update`, `chrome_update`, …). */
  onInstalled(reason: string): Promise<void>;
  /** A host permission was granted (`added`: its patterns) or given back (`added` empty). */
  onPermissionsChanged(added?: readonly string[]): Promise<void>;
  onOnline(): Promise<void>;
  uiState(tabId: number | null): Promise<PopupState>;
  /** The tab a popup opened over. */
  activeTab(): Promise<number | null>;
  /** Called whenever what `uiState` answers may have changed; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export function createRoot(deps: PlatformDeps): Root {
  return new CompositionRoot(deps);
}

class CompositionRoot implements Root {
  readonly #deps: PlatformDeps;
  readonly #lock = new ViewingLock();
  readonly #steps: Steps;
  readonly #changes = new Listeners();
  readonly #ingest: IngestObservation;
  readonly #expire: ExpireStale;
  readonly #frames: FrameTable;
  readonly #status: StatusPresenter;
  readonly #sync: SyncLoop;
  readonly #disconnect: Disconnect;
  readonly #check: ConnectionCheck;
  readonly #content: ContentRouter;
  readonly #ui: UiRequests;

  constructor(deps: PlatformDeps) {
    this.#deps = deps;
    const { viewings, outbox, history, ids, clock, scheduler, settings, connection } = deps;
    const lock = this.#lock;
    const steps = new Steps(deps.diagnostics);
    this.#steps = steps;
    const check = new ConnectionCheck({
      connection,
      outbox,
      gateway: deps.connectionGateway,
      store: deps.connectionChecks,
      rules: deps.accountRules,
      clock,
      log: (event, detail) => steps.log(event, detail),
      confirm: new ConfirmAccount({ connection, account: deps.account, lock }),
      // The connection's account is known now: what waited for it goes.
      onAccountKept: () => {
        this.#sync.runDrain();
        this.#sync.runReceipts('scheduled');
      },
    });
    this.#check = check;
    // Every play, start and viewing is recorded for the account the connection acts for now.
    const accountKey = async () => keyOf(await connection.account());
    const report = new ReportViewing({
      viewings,
      outbox,
      history,
      ids,
      clock,
      scheduler,
      lock,
      accountKey,
    });
    // What is sent is judged by the lines the last check kept, never by asking before it.
    const rules = { get: () => check.rule() };
    this.#ingest = new IngestObservation({
      viewings,
      settings,
      rules,
      clock,
      ids,
      report,
      lock,
      accountKey,
    });
    // Each waits for the other: a sign-in first removes what an unfinished disconnect left, and
    // a disconnect waits for a sign-in in progress to end.
    const connect: Connect = new Connect({
      connection,
      outbox,
      clock,
      scheduler,
      leftovers: { finish: () => disconnect.finish() },
    });
    const disconnect: Disconnect = new Disconnect({
      connection,
      account: deps.account,
      outbox,
      scheduler,
      lock,
      drainAll: () => this.#sync.drain({ early: true }),
      settled: () => this.#sync.settled(),
      connecting: () => connect.idle(),
      delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    this.#disconnect = disconnect;
    this.#expire = new ExpireStale({
      viewings,
      history,
      outbox,
      diagnostics: deps.diagnostics,
      settings,
      rules,
      clock,
      scheduler,
      report,
      lock,
    });

    const interpretations = new InterpretationCache();
    this.#frames = new FrameTable(clock, (table, frames) => this.#observed(table, frames));
    this.#status = new StatusPresenter({ platform: deps, check, frames: this.#frames, steps });
    this.#sync = this.#syncLoop(check, steps);
    this.#content = new ContentRouter({
      platform: deps,
      frames: this.#frames,
      interpretations,
      status: this.#status,
      steps,
      // A playing sample the router dropped: the tab's reason, logged when new. What plays goes
      // nowhere, so the tab's icon no longer says its viewing records.
      ignore: (tab, reason) => {
        void steps.guard('ignore', async () => {
          if (await this.#ingest.ignore(tab, reason)) void steps.log('viewing.ignored', { reason });
          await this.#status.refreshTab(tab);
          this.#changes.changed();
        });
      },
    });
    this.#ui = new UiRequests({
      platform: deps,
      lock,
      skip: new SkipViewing({ viewings, lock }),
      pause: new PauseTracking({ settings, clock }),
      clearHistory: new ClearHistory({ history, report, lock }),
      expire: this.#expire,
      connect,
      disconnect,
      frames: this.#frames,
      interpretations,
      check,
      status: this.#status,
      sync: this.#sync,
      changes: this.#changes,
      steps,
      bootstrapOpenTabs: (patterns) => this.#bootstrapOpenTabs(patterns),
    });
  }

  /** The loop that sends the outbox, reads receipts and checks the connection. */
  #syncLoop(check: ConnectionCheck, steps: Steps): SyncLoop {
    const { outbox, history, connection, gateway, clock, scheduler } = this.#deps;
    return new SyncLoop({
      drain: new DrainOutbox({
        outbox,
        history,
        connection,
        gateway,
        clock,
        scheduler,
        random: this.#deps.random,
        // The account's lines did not count what was sent: they changed since the last check, so
        // the next viewing is judged by the current ones.
        onNotCounted: () => {
          void steps.log('play.not_counted', {});
          this.#sync.runCheck(true);
        },
        // Nothing goes before a check names the connection's account: one is asked for, at
        // most once a minute, and the outbox's watchdog comes back.
        onAccountUnread: () => {
          this.#sync.runCheck();
        },
      }),
      receipts: new RefreshReceipts({
        history,
        gateway: loggingReceipts(gateway, steps),
        connection,
        outbox,
        clock,
        scheduler,
      }),
      check,
      status: this.#status,
      changes: this.#changes,
      steps,
    });
  }

  // ── what arrives ────────────────────────────────────────────────────────────────────────

  onContentMessage(
    raw: unknown,
    sender: ContentSender,
  ): Promise<BootstrapAnswer | CollectorAnswer | undefined> {
    return this.#content.onContentMessage(raw, sender);
  }

  onUiRequest(raw: unknown): Promise<UiResponseMessage | null> {
    return this.#ui.onUiRequest(raw);
  }

  uiState(tabId: number | null): Promise<PopupState> {
    return this.#ui.uiState(tabId);
  }

  activeTab(): Promise<number | null> {
    return this.#deps.tabs.active().catch(() => null);
  }

  subscribe(listener: () => void): () => void {
    return this.#changes.subscribe(listener);
  }

  /** A tab's observation, handed to core; what it reported is sent, what it changed shown. */
  async #observed(table: TabFrames, frames: FrameReport[]): Promise<void> {
    // A play or a start went into the outbox: it is sent now.
    let queued = false;
    try {
      const result = await this.#ingest.execute({
        tabId: table.tabId,
        incognito: table.incognito,
        serviceId: table.serviceId,
        frames,
      });
      queued = result.reported || result.started === true;
      if (result.reported && result.viewing !== null) {
        void this.#steps.log('viewing.reported', { viewingId: result.viewing.id });
      }
      if (result.started === true && result.viewing !== null) {
        void this.#steps.log('viewing.started', { viewingId: result.viewing.id });
      }
      // A new reason the tab's playing media went nowhere, once, with no title and no address.
      if (result.newlyIgnored !== undefined) {
        void this.#steps.log('viewing.ignored', { reason: result.newlyIgnored });
      }
    } catch (error: unknown) {
      void this.#steps.log('observation.failed', { error: errorName(error) });
      return;
    }
    if (queued) this.#sync.runDrain();
    await this.#status.refreshTab(table.tabId);
    this.#changes.changed();
  }

  onTabLoading(tabId: number): void {
    this.#status.tabReset(tabId);
  }

  onTabAt(tabId: number, url: string | undefined, incognito: boolean): Promise<void> {
    return this.#status.tabAt(tabId, url, incognito);
  }

  async onTabRemoved(tabId: number): Promise<void> {
    this.#frames.remove(tabId);
    this.#status.tabClosed(tabId);
    // Inside the lock, after any observation of the tab already queued.
    await this.#lock.run(() => this.#deps.viewings.dropTab(tabId));
    this.#changes.changed();
  }

  // ── lifecycle and alarms ────────────────────────────────────────────────────────────────

  async onStartup(): Promise<void> {
    const { viewings, clock } = this.#deps;
    // Tab ids do not survive a restart: every tab state goes, before any observation runs.
    await this.#lock.run(() => viewings.dropTabsIdleBefore(clock.now()));
    this.#sync.runDrain();
  }

  async onWake(): Promise<void> {
    const { scheduler, clock } = this.#deps;
    // A disconnect the worker stopped in the middle of: what the account left goes now, and with
    // it what the connection check kept of that connection.
    await this.#steps.guard('wake.disconnect', async () => {
      if (await this.#disconnect.finish()) await this.#check.forget();
    });
    await this.#steps.guard('wake.reconcile', () => this.#deps.permissions.reconcile());
    // Retention runs every 6 h and schedules itself; this only makes sure one is pending.
    const expireAt = clock.now() + EXPIRE_INTERVAL_MS;
    await this.#steps.guard('wake.expire', () => scheduler.at('expire', expireAt));
    this.#sync.runDrain();
    this.#sync.runReceipts('scheduled');
    // Whether the connection still works, and until when, at most once a minute.
    this.#sync.runCheck();
    await this.#status.refreshAll();
  }

  async onInstalled(reason: string): Promise<void> {
    await this.#steps.guard('installed.reconcile', () => this.#deps.permissions.reconcile());
    // The previous version's bootstrap stays in open tabs, cut off from this worker; on a fresh
    // install there was none.
    if (reason === 'install' || reason === 'update') {
      await this.#steps.guard('installed.bootstrap', () => this.#bootstrapOpenTabs());
    }
    await this.#status.refreshAll();
  }

  async onPermissionsChanged(added: readonly string[] = []): Promise<void> {
    await this.#steps.guard('permissions.reconcile', () => this.#deps.permissions.reconcile());
    // A newly registered bootstrap runs only in pages loaded after it.
    if (added.length > 0) {
      await this.#steps.guard('permissions.bootstrap', () => this.#bootstrapOpenTabs(added));
    }
    await this.#status.refreshAll();
    this.#changes.changed();
  }

  /**
   * The bootstrap into every frame of the open tabs (those matching `patterns`, if given) that
   * the manifest entry or the run-time registration would have given one: a built-in host, or a
   * granted one that is neither blocked nor excluded. The settings mirror the grants, so this
   * runs after `reconcile`. A frame whose bootstrap still reaches this worker keeps it (the
   * bootstrap checks).
   */
  async #bootstrapOpenTabs(patterns?: readonly string[]): Promise<void> {
    const { bootstrap, settings } = this.#deps;
    const config = await settings.get();
    const wanted = (origin: string | null): boolean => {
      const host = origin === null ? null : (httpUrl(`${origin}/`)?.hostname ?? null);
      if (host === null || isBlockedHost(host)) return false;
      if (siteForHostname(host) !== null) return true;
      if (config.excludedHosts.some((excluded) => coversHost(excluded, host))) return false;
      return config.allSites || config.allowedHosts.some((allowed) => coversHost(allowed, host));
    };
    const tabs = await bootstrap.openTabs(patterns);
    await Promise.all(
      tabs.map(async ({ tabId }) => {
        for (const frame of await bootstrap.framesOf(tabId)) {
          if (!wanted(frame.origin)) continue;
          await bootstrap.inject({ tabId, frameId: frame.frameId, documentId: frame.documentId });
        }
      }),
    );
  }

  onOnline(): Promise<void> {
    this.#sync.runDrain();
    return Promise.resolve();
  }

  async onAlarm(name: string): Promise<void> {
    switch (name) {
      case 'outbox':
        await this.#sync.drain();
        return;
      case 'receipts':
        await this.#sync.receipts('scheduled');
        return;
      case 'expire':
        await this.#steps.guard('expire', () => this.#expire.execute());
        this.#changes.changed();
        return;
      case 'status':
        await this.#status.refreshAll();
        this.#changes.changed();
        return;
      default:
        return;
    }
  }

  async onUiOpened(): Promise<void> {
    await Promise.all([this.#sync.receipts('popup'), this.#sync.check()]);
  }
}

/**
 * The gateway as the receipt reader sees it: a read that could not be made is logged by why,
 * never by which play — the detail is for diagnostics, and the reader decides nothing from it.
 */
function loggingReceipts(gateway: PlaysGateway, steps: Steps): PlaysGateway {
  return {
    send: (playId, body) => gateway.send(playId, body),
    receipt: async (scrobbleId) => {
      const result = await gateway.receipt(scrobbleId);
      if (result.kind === 'unavailable' && result.detail !== undefined) {
        void steps.log('receipt.unavailable', { detail: result.detail });
      }
      return result;
    },
  };
}
