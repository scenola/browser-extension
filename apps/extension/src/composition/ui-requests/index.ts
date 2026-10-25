/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The pages' door: every `ui/*` request answered, and the state the popup and the settings
// pages render (`PopupState`). Sites are permissions, granted from a page's click and only
// checked here; settings change all or none; *Clear all local data* waits for every background
// pass before it wipes. The *Now playing* line is now-playing.ts; what an export and a capture
// make of stored records is records.ts.

import {
  ignoredOf,
  isIndefinitePause,
  isPaused,
  isStart,
  playLabel,
  sanitizeCapture,
  sentPlayView,
} from '@mt/core';
import type {
  AuthStrategy,
  ClearHistory,
  Connect,
  ConnectResult,
  Disconnect,
  Disconnected,
  EpochMs,
  ExpireStale,
  HistoryDays,
  HistoryEntry,
  OutboxEntry,
  PauseTracking,
  ReceiptView,
  SettingsValue,
  SkipViewing,
  ViewingLock,
} from '@mt/core';

import { PROTOCOL_VERSION, parseUiRequest } from '../../messaging/protocol';
import type {
  ActiveSite,
  EntryView,
  HistoryEntryView,
  NowPlaying,
  PopupState,
  SettingsPatch,
  UiRequest,
  UiResponse,
  UiResponseMessage,
} from '../../messaging/protocol';
import { canonicalHost } from '../../platform/settings';
import { originPattern } from '../../platform/site-permissions';
import { coversHost, siteById, siteForHostname } from '../../sites';
import { isRecord } from '../../values';
import { WEB_ROUTES } from '../../web-routes';
import type { ConnectionCheck } from '../connection-check';
import type { PlatformDeps } from '../deps';
import type { FrameTable } from '../frame-table';
import type { InterpretationCache } from '../interpretation-cache';
import type { TabFacts } from '../ports';
import { decide, httpUrl, siteOf, trackingOf } from '../site-decision';
import type { StatusPresenter } from '../status-presenter';
import { PLAYING_WINDOW_MS, errorName, fail, ok, refusedWhy } from '../support';
import type { Listeners, Steps } from '../support';
import type { SyncLoop } from '../sync-loop';
import { waitingRows } from '../waiting-rows';
import { blankLine, notTrackingReason, viewingLine } from './now-playing';
import type { TabNow } from './now-playing';
import { connectionSummary, partsUsed, withoutKey } from './records';

/** The popup's *Recently*: the last ten plays. */
const RECENT_LIMIT = 10;

const OUTBOX_VIEWS: Readonly<Record<OutboxEntry['state'], EntryView>> = {
  pending: { tone: 'waiting', messageKey: 'outbox.pending', link: null, settled: false },
  paused: { tone: 'attention', messageKey: 'outbox.paused', link: null, settled: false },
  dead: { tone: 'attention', messageKey: 'outbox.dead', link: null, settled: true },
};

interface Deps {
  readonly platform: PlatformDeps;
  readonly lock: ViewingLock;
  readonly skip: SkipViewing;
  readonly pause: PauseTracking;
  readonly clearHistory: ClearHistory;
  /** Retention, run again when the person shortens how long the history is kept. */
  readonly expire: ExpireStale;
  readonly connect: Connect;
  readonly disconnect: Disconnect;
  readonly frames: FrameTable;
  readonly interpretations: InterpretationCache;
  readonly check: ConnectionCheck;
  readonly status: StatusPresenter;
  readonly sync: SyncLoop;
  readonly changes: Listeners;
  readonly steps: Steps;
  /** The bootstrap into the open tabs matching `patterns` that should have one (root.ts). */
  readonly bootstrapOpenTabs: (patterns: readonly string[]) => Promise<void>;
}

export class UiRequests {
  readonly #deps: Deps;
  readonly #platform: PlatformDeps;

  constructor(deps: Deps) {
    this.#deps = deps;
    this.#platform = deps.platform;
  }

  async uiState(tabId: number | null): Promise<PopupState> {
    const { connection, settings, history, outbox, tabs } = this.#platform;
    const [state, config, shown] = await Promise.all([
      connection.get(),
      settings.get(),
      this.#recordsShown(),
    ]);
    const [recent, unsettled, queued] = shown
      ? await Promise.all([history.recent(RECENT_LIMIT), history.unsettled(), outbox.list()])
      : [[], [], []];
    const waiting = waitingRows(
      unsettled.filter((entry) => sentPlayView(entry).messageKey === 'receipt.needs_confirmation'),
      this.#platform.webAppBaseUrl,
    );
    const sent = new Set(recent.map((entry) => entry.playId));
    const lines = [
      ...recent.map((entry) => this.#historyView(entry)),
      ...queued.filter((entry) => !sent.has(entry.playId)).map((entry) => this.#outboxView(entry)),
    ]
      .sort((a, b) => b.sentAt - a.sentAt)
      .slice(0, RECENT_LIMIT);
    // The tab's address, as Chrome shows it: while the popup opened over it is up, `activeTab`
    // shows it on any site.
    const tab = tabId === null ? null : await tabs.get(tabId).catch(() => null);
    const tabUrl = httpUrl(tab?.url ?? undefined);
    const site = tabUrl === null ? null : siteOf(tabUrl, config);
    return {
      connection: state,
      nowPlaying: tabId === null ? null : await this.#nowPlaying(tabId, tab, tabUrl, site, config),
      waiting,
      recent: lines,
      unsent: queued.filter((entry) => entry.state !== 'dead').length,
      pausedUntil: config.pausedUntil,
      site,
      connectionCheck: await this.#deps.check.view(state),
      accountRule: await this.#deps.check.rule(state),
    };
  }

  /**
   * Whether the plays and the history kept here may be shown, or exported. Not what a disconnect
   * is removing: it belongs to nobody here any more. Not under a connection whose account no
   * check has named yet: they may be another person's, and its check may delete them.
   */
  async #recordsShown(): Promise<boolean> {
    const { account, connection } = this.#platform;
    const [leaving, known] = await Promise.all([account.leaving(), connection.account()]);
    return !leaving && known.kind !== 'unread';
  }

  async onUiRequest(raw: unknown): Promise<UiResponseMessage | null> {
    const request = parseUiRequest(raw);
    if (request === null) {
      void this.#deps.steps.log('message.refused', { channel: 'ui', reason: refusedWhy(raw) });
      const id = requestIdOf(raw);
      return id === null ? null : answer(id, fail('bad_request'));
    }
    let response: UiResponse;
    try {
      response = await this.#handle(request);
    } catch (error: unknown) {
      void this.#deps.steps.log('ui.failed', { type: request.type, error: errorName(error) });
      response = fail('internal');
    }
    return answer(request.id, response);
  }

  /**
   * *Now playing*. The tab's viewing, unless what plays now went nowhere: then, on a tracked site
   * or a turned-off built-in, `not_tracking` and the first gate it failed — tracking paused, an
   * incognito tab without the setting, the service turned off (the worker's gates, told from the
   * tab and the settings: they stop what plays before the core keeps anything), the tab's kept
   * reason, or an audible tab whose frames sent no sample.
   * A reason shows only while it is `PLAYING_WINDOW_MS` recent, so while something still plays.
   * A blocked site, and one that offers *Track this site*, keep their own lines.
   */
  async #nowPlaying(
    tabId: number,
    facts: TabFacts | null,
    tabUrl: URL | null,
    activeSite: ActiveSite | null,
    settings: SettingsValue,
  ): Promise<NowPlaying | null> {
    const now = this.#platform.clock.now();
    const tab = await this.#tabNow(tabId, facts, tabUrl, now);
    const shown = blankLine(tabId, tab.hostname);
    const { viewing, ignored, unreachable } = tab;
    if (viewing !== null && viewing.state !== 'expired' && ignored === null && !unreachable) {
      return viewingLine(shown, viewing, viewing.state, tab.sample);
    }
    // The same decision as the popup's site line: *Track this site* only where it can work —
    // never for a turned-off built-in, a blocked site, or an origin it cannot name.
    const tracking =
      activeSite?.tracking ??
      (tab.hostname === null ? null : trackingOf(decide(tab.hostname, settings)));
    if (tracking === null) return null;
    if (tracking === 'blocked') return { ...shown, state: 'blocked' };
    if (tracking === 'trackable') return { ...shown, origin: activeSite?.origin ?? null };
    const reason = notTrackingReason({
      playing: facts?.audible === true || ignored !== null,
      paused: isPaused(settings.pausedUntil, now),
      incognitoRefused: facts?.incognito === true && !settings.trackIncognito,
      turnedOff: tracking === 'turned_off',
      ignored,
      unreachable,
    });
    if (reason !== null) return { ...shown, state: 'not_tracking', reason };
    return tracking === 'turned_off' ? shown : null;
  }

  /**
   * What the worker knows of a tab now: its site's host, its viewing and last sample, the reason
   * it kept while that is `PLAYING_WINDOW_MS` recent, and whether it sounds with no frame
   * sampling — a player the extension cannot reach.
   */
  async #tabNow(
    tabId: number,
    facts: TabFacts | null,
    tabUrl: URL | null,
    now: EpochMs,
  ): Promise<TabNow> {
    const { viewings } = this.#platform;
    const recent = (at: EpochMs): boolean => now - at <= PLAYING_WINDOW_MS;
    const table = this.#deps.frames.get(tabId);
    const tab = await viewings.tabState(tabId);
    const viewing = tab?.viewingId == null ? null : await viewings.byId(tab.viewingId);
    const kept = ignoredOf(tab?.ignored);
    return {
      hostname: table?.topHostname ?? tabUrl?.hostname ?? null,
      viewing,
      sample: tab?.lastSample ?? null,
      ignored: kept !== null && recent(kept.at) ? kept.reason : null,
      unreachable: facts?.audible === true && !(table !== undefined && recent(table.lastSampleAt)),
    };
  }

  async #handle(request: UiRequest): Promise<UiResponse> {
    switch (request.type) {
      case 'ui/skip':
        await this.#deps.skip.execute(request.viewingId);
        await this.#showChanges();
        return ok();
      case 'ui/pause':
        return this.#pauseUntil(request.until);
      case 'ui/track-site':
        return this.#trackSite(request.origin);
      case 'ui/what-was-sent':
        return this.#whatWasSent(request.playId);
      case 'ui/connect':
        return this.#connectWith(request.strategy, 'token' in request ? request.token : undefined);
      case 'ui/disconnect':
        return ok(await this.#disconnect(request.sendFirst));
      case 'ui/settings':
        return this.#changeSettings(request.patch);
      case 'ui/export':
        return ok(await this.#export());
      case 'ui/clear':
        await this.#clear();
        return ok();
      case 'ui/clear-history':
        await this.#clearHistory();
        return ok();
      case 'ui/capture':
        return this.#capture(request.tabId);
    }
  }

  /** The toolbar and the open pages show what a request changed. */
  async #showChanges(): Promise<void> {
    await this.#deps.status.refreshAll();
    this.#deps.changes.changed();
  }

  async #pauseUntil(until: EpochMs | null): Promise<UiResponse> {
    const { scheduler, clock } = this.#platform;
    await this.#deps.pause.execute(until);
    // A timed pause ends on its own: the icon is woken to say so. An indefinite one never is.
    const timed = until !== null && !isIndefinitePause(until) && until > clock.now();
    await scheduler.clear('status');
    if (timed) await scheduler.at('status', until);
    await this.#showChanges();
    return ok();
  }

  /**
   * *Track this site*: the page's click was granted the origin; the bootstrap follows it, into
   * the pages loaded from now on and into the site's tabs already open. A grant brings it to
   * those tabs too, but not every *Track this site* is a grant: an origin granted before (its
   * exclusion just lifted here) fires none, and a grant's own pass can run while the exclusion
   * still stands. Brought to a tab whose video already plays, the bootstrap asks at once.
   *
   * The page is answered once the site is tracked, and the open tabs get their bootstrap after:
   * a site open in many tabs does not hold the button busy. A grant's pass into the same frames
   * finds the bootstrap there and adds nothing.
   */
  async #trackSite(origin: string): Promise<UiResponse> {
    const { permissions, settings } = this.#platform;
    const pattern = originPattern(origin);
    if (pattern === null) return fail('invalid_origin');
    if (!(await permissions.has(origin))) return fail('permission_not_granted');
    const hostname = new URL(origin).hostname;
    const current = await settings.get();
    const excludedHosts = current.excludedHosts.filter((host) => !coversHost(host, hostname));
    if (excludedHosts.length !== current.excludedHosts.length) {
      await settings.patch({ excludedHosts });
    }
    await permissions.reconcile();
    void this.#deps.steps.guard('track_site.bootstrap', () =>
      this.#deps.bootstrapOpenTabs([pattern]),
    );
    await this.#showChanges();
    return ok();
  }

  async #whatWasSent(playId: string): Promise<UiResponse> {
    const { history, outbox } = this.#platform;
    const sent = await history.byPlayId(playId);
    if (sent !== null) {
      const line = this.#historyView(sent);
      return ok({
        playId: sent.playId,
        body: sent.body,
        sentAt: sent.sentAt,
        scrobbleId: sent.scrobbleId,
        receipt: sent.receipt,
        view: line.view,
        href: line.href,
      });
    }
    const queued = (await outbox.list()).find((entry) => entry.playId === playId);
    if (queued === undefined) return fail('not_found');
    return ok({
      playId: queued.playId,
      body: queued.body,
      sentAt: queued.createdAt,
      state: queued.state,
      lastError: queued.lastError,
      view: OUTBOX_VIEWS[queued.state],
      href: null,
    });
  }

  async #connectWith(
    strategyId: AuthStrategy['id'],
    token: string | undefined,
  ): Promise<UiResponse> {
    const strategy = this.#platform.strategies.find((s) => s.id === strategyId);
    if (strategy === undefined) return fail('no_strategy');
    const result = await this.#deps.connect.execute(
      strategy,
      token === undefined ? undefined : { token },
    );
    this.#deps.status.invalidate();
    // A new connection sends nothing until its check names the account it acts for: asked now.
    // The check that keeps it sends what waited for it.
    if (result.kind === 'connected') this.#deps.sync.runCheck(true);
    await this.#showChanges();
    return ok({ result: this.#shownResult(strategyId, result) });
  }

  /**
   * A sign-in's result as a page receives it: the connection's state, never the credential; and
   * an `unavailable`'s `detail` logged, never answered (it is for diagnostics only).
   */
  #shownResult(strategyId: AuthStrategy['id'], result: ConnectResult): ConnectResult {
    switch (result.kind) {
      case 'connected':
        return { kind: result.kind, state: result.state };
      case 'unavailable':
        if (result.detail !== undefined) {
          void this.#deps.steps.log('connect.unavailable', {
            strategy: strategyId,
            detail: result.detail,
          });
        }
        return { kind: 'unavailable' };
      default:
        return result;
    }
  }

  /**
   * Changes the settings `patch` names, all or none: every value is checked before anything is
   * written. Sites are permissions: one is added only from a page's click (*Track this site*,
   * the all-sites switch), so a patch may turn all sites on only once Chrome granted them, and
   * may only remove allowed sites — which gives their access back. A patch that names nothing is
   * a read, and a read is no change: the pages read again on every push, so a read that
   * announced one would ask for the next read itself, every push, for as long as a page is open.
   */
  async #changeSettings(patch: SettingsPatch): Promise<UiResponse> {
    const { settings, permissions, diagnostics } = this.#platform;
    const current = await settings.get();
    if (Object.keys(patch).length === 0) return ok(current);
    const next: { -readonly [K in keyof SettingsValue]?: SettingsValue[K] } = {};

    if (patch.trackIncognito !== undefined) next.trackIncognito = patch.trackIncognito;
    if (patch.disabledServices !== undefined) {
      const ids = [...new Set(patch.disabledServices)];
      if (ids.some((id) => siteById(id) === null)) return fail('unknown_service');
      next.disabledServices = ids.sort();
    }
    if (patch.excludedHosts !== undefined) {
      const hosts = canonicalHosts(patch.excludedHosts);
      if (hosts === null) return fail('invalid_host');
      next.excludedHosts = [...new Set(hosts)].sort();
    }
    let removedHosts: readonly string[] = [];
    if (patch.allowedHosts !== undefined) {
      const hosts = canonicalHosts(patch.allowedHosts);
      if (hosts === null) return fail('invalid_host');
      const kept = new Set(hosts);
      if ([...kept].some((host) => !current.allowedHosts.includes(host))) {
        return fail('add_sites_from_a_click');
      }
      removedHosts = current.allowedHosts.filter((host) => !kept.has(host));
    }
    if (patch.allSites === true && !current.allSites && !(await permissions.hasAllSites())) {
      return fail('permission_not_granted');
    }

    if (patch.diagnostics !== undefined) {
      next.diagnostics = patch.diagnostics;
      if (!patch.diagnostics) await diagnostics.clear();
    }
    if (patch.historyDays !== undefined) next.historyDays = patch.historyDays;
    if (Object.keys(next).length > 0) await settings.patch(next);
    await this.#historyKept(current.historyDays, next.historyDays);
    for (const host of removedHosts) {
      await permissions.forget(`https://${host}`);
      await permissions.forget(`http://${host}`);
    }
    if (patch.allSites === false && current.allSites) await permissions.forgetAllSites();
    await permissions.reconcile();
    await this.#showChanges();
    return ok(await settings.get());
  }

  /** A shorter history takes effect now, not at the next retention pass hours later. */
  async #historyKept(before: HistoryDays, after: HistoryDays | undefined): Promise<void> {
    if (after === undefined || after >= before) return;
    await this.#deps.steps.guard('settings.expire', () => this.#deps.expire.execute());
  }

  /** *Export my extension data*: what is stored, never the credential or the key. */
  async #export(): Promise<unknown> {
    const { settings, connection, viewings, history, outbox, clock, buildMode } = this.#platform;
    const [config, state, rule, shown] = await Promise.all([
      settings.get(),
      connection.get(),
      this.#deps.check.rule(),
      this.#recordsShown(),
    ]);
    const [all, sent, queued] = shown
      ? await Promise.all([
          viewings.idleBefore(Number.MAX_SAFE_INTEGER),
          history.recent(Number.MAX_SAFE_INTEGER),
          outbox.list(),
        ])
      : [[], [], []];
    return {
      format: 'scenola-extension-export',
      version: 1,
      exportedAt: new Date(clock.now()).toISOString(),
      build: { mode: buildMode },
      settings: config,
      connection: connectionSummary(state),
      // What the account said, as kept here: when a film begun is saved in progress.
      accountRule: rule,
      viewings: all.filter((v) => v.state === 'open' || v.state === 'skipped').map(withoutKey),
      history: sent.map(withoutKey),
      outbox: queued.map(withoutKey),
    };
  }

  /**
   * *Disconnect from this browser*: the account leaves with everything recorded for it (core's
   * `Disconnect`: what is left sent first when asked, the credential forgotten, every send in
   * flight waited for, then the rest removed), then what the connection check kept of it, once no
   * check runs any more. What the pages and the toolbar remember of its tabs goes too. The
   * settings stay: they belong to the browser, not to the account.
   */
  async #disconnect(sendFirst: boolean): Promise<Disconnected> {
    const { frames, interpretations, status, steps } = this.#deps;
    frames.clear();
    interpretations.clear();
    const result = await this.#deps.disconnect.execute({ sendFirst });
    await this.#deps.check.forget();
    status.invalidate();
    void steps.log('disconnect.done', { sent: result.sent, deleted: result.deleted });
    await this.#showChanges();
    return result;
  }

  /**
   * *Clear all local data*: the account leaves first, as a disconnect without sending (so a send
   * in flight stops after its answer, and every background task is waited for), then every store
   * goes at once inside the viewing lock, the settings return to a fresh install's, and every
   * optional site access is given back.
   */
  async #clear(): Promise<void> {
    const { settings, permissions, scheduler } = this.#platform;
    const { frames, interpretations, status, steps } = this.#deps;
    frames.clear();
    interpretations.clear();
    status.clearTimers();
    await this.#deps.disconnect.execute({ sendFirst: false });
    await this.#deps.check.forget();
    await this.#deps.lock.run(() => this.#platform.wipe());
    await settings.reset();
    await scheduler.clear('status');
    await steps.guard('clear.permissions', () => permissions.forgetAll());
    await steps.guard('clear.reconcile', () => permissions.reconcile());
    status.invalidate();
    await this.#showChanges();
  }

  /**
   * *Clear history* (core's `ClearHistory`), at once: no pass is waited for. A receipt read on
   * its way writes nothing back for a play cleared, and a play delivered meanwhile was not sent
   * yet when the person asked, so it stays, as the confirmation says.
   */
  async #clearHistory(): Promise<void> {
    await this.#deps.clearHistory.execute();
    await this.#showChanges();
  }

  /**
   * *Capture page sample*: the tab's latest top-frame snapshot, sanitised; how much of each kind
   * the sanitiser removed, in the file too (`removed`); and the parts a reader took something
   * from this time (`used`), for the screen.
   */
  #capture(tabId: number | undefined): UiResponse {
    const { frames } = this.#deps;
    const table = tabId === undefined ? frames.latestWithSnapshot() : frames.get(tabId);
    const top = table?.frames.get(0);
    if (table === undefined || top?.snapshot == null) return fail('no_snapshot');
    const service =
      table.serviceId ??
      (table.topHostname === null ? null : siteForHostname(table.topHostname)?.id) ??
      'site';
    const date = new Date(this.#platform.clock.now()).toISOString().slice(0, 10);
    const { snapshot, removed } = sanitizeCapture(top.snapshot);
    const collect = table.serviceId === null ? null : siteById(table.serviceId)?.module?.collect;
    return ok({
      filename: `${service}-${date}.snapshot.json`,
      fixture: { synthetic: false, snapshot, removed },
      used: partsUsed(top, collect ?? null),
    });
  }

  #href(view: EntryView, titleId: string | null): string | null {
    const base = this.#platform.webAppBaseUrl;
    switch (view.link) {
      case 'title':
        return titleId === null ? null : `${base}${WEB_ROUTES.title(titleId)}`;
      case 'waiting':
      case 'upgrade':
      case 'connections':
        return `${base}${WEB_ROUTES.connections}`;
      case null:
        return null;
    }
  }

  #historyView(entry: HistoryEntry): HistoryEntryView {
    const view: ReceiptView = sentPlayView(entry);
    const titleId = entry.receipt?.titleId ?? null;
    return {
      playId: entry.playId,
      label: entry.label,
      start: isStart(entry.body),
      sentAt: entry.sentAt,
      view,
      titleId,
      href: this.#href(view, titleId),
    };
  }

  #outboxView(entry: OutboxEntry): HistoryEntryView {
    const view = OUTBOX_VIEWS[entry.state];
    return {
      playId: entry.playId,
      label: playLabel(entry.body) ?? '',
      start: isStart(entry.body),
      sentAt: entry.createdAt,
      view,
      titleId: null,
      href: null,
    };
  }
}

/** Each of `hosts` as `canonicalHost` writes it; `null` when one is not a host. */
function canonicalHosts(hosts: readonly string[]): string[] | null {
  const canonical = hosts.map(canonicalHost);
  return canonical.every((host) => host !== null) ? canonical : null;
}

function answer(id: number, response: UiResponse): UiResponseMessage {
  return { v: PROTOCOL_VERSION, type: 'ui/response', id, response };
}

function requestIdOf(raw: unknown): number | null {
  const id = isRecord(raw) ? raw.id : undefined;
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? id : null;
}
