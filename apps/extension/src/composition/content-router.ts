/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The content scripts' door: a message and what Chrome says of its sender become a frame's
// report in the frame table. The site, the frame and the tab come from the sender alone,
// never from the message; a snapshot's URL is overwritten with Chrome's, and its page state is
// what the worker's own reader returned.

import { ADDRESS_QUERY_PARAMS, entryVerdict, isPaused, readGeneric } from '@mt/core';
import type {
  EntryVerdict,
  EpochMs,
  IgnoredReason,
  PlaybackSample,
  ServiceReading,
  SettingsValue,
  Snapshot,
} from '@mt/core';

import { SNAPSHOT_LIMITS } from '../messaging/limits';
import { parseMessage } from '../messaging/protocol';
import type { BootstrapAnswer, CollectorAnswer, CollectorReport } from '../messaging/protocol';
import { withinJsonBudget } from '../messaging/schemas';
import { isPlayerRoute, playerRouteGroups, siteForHostname } from '../sites';
import type { SiteData } from '../sites';
import type { PlatformDeps } from './deps';
import { MAX_FRAMES_PER_TAB, keepIdentity } from './frame-table';
import type { FrameEntry, FrameOrigin, FrameTable, TabFrames } from './frame-table';
import type { InterpretationCache } from './interpretation-cache';
import { decide, httpUrl } from './site-decision';
import type { Decision } from './site-decision';
import type { StatusPresenter } from './status-presenter';
import { errorName, refusedWhy } from './support';
import type { Steps } from './support';

/**
 * A frame without a video (the top frame of a tab whose player is in another frame, there to
 * name the title) is kept this long after the tab's last sample; then its collector is told to
 * stop, and the next sample from the player's frame injects one again.
 */
const SNAPSHOT_ONLY_IDLE_MS = 60_000;
/** After a failed injection into a tab's top frame, the next try waits this long. */
const TOP_RETRY_MS = 30_000;
/** A sample's clock may run this far behind the worker's (a frozen tab's report)… */
const SAMPLE_MAX_AGE_MS = 5 * 60_000;
/** …and this far ahead of it. */
const SAMPLE_MAX_LEAD_MS = 5_000;
/** The address reader's parameter names, compared in lower case: it reads a name in any case. */
const ADDRESS_PARAMS: ReadonlySet<string> = new Set(
  ADDRESS_QUERY_PARAMS.map((name) => name.toLowerCase()),
);
/** The only values the address reader reads: whole numbers. */
const DIGITS = /^\d+$/u;

/** What `runtime.onMessage` says of a sender, as far as the root reads it. */
export interface ContentSender {
  readonly id?: string | undefined;
  readonly url?: string | undefined;
  readonly origin?: string | undefined;
  readonly frameId?: number | undefined;
  readonly documentId?: string | undefined;
  readonly documentLifecycle?: string | undefined;
  readonly tab?:
    | {
        readonly id?: number | undefined;
        readonly url?: string | undefined;
        readonly incognito: boolean;
      }
    | undefined;
}

interface Deps {
  readonly platform: PlatformDeps;
  readonly frames: FrameTable;
  readonly interpretations: InterpretationCache;
  readonly status: StatusPresenter;
  readonly steps: Steps;
  /** A playing sample dropped here, before the core: the tab's reason. */
  readonly ignore: (tabId: number, reason: IgnoredReason) => void;
}

export class ContentRouter {
  readonly #platform: PlatformDeps;
  readonly #frames: FrameTable;
  readonly #interpretations: InterpretationCache;
  readonly #status: StatusPresenter;
  readonly #steps: Steps;
  readonly #ignore: Deps['ignore'];
  #seq = 0;

  constructor(deps: Deps) {
    this.#platform = deps.platform;
    this.#frames = deps.frames;
    this.#interpretations = deps.interpretations;
    this.#status = deps.status;
    this.#steps = deps.steps;
    this.#ignore = deps.ignore;
  }

  async onContentMessage(
    raw: unknown,
    sender: ContentSender,
  ): Promise<BootstrapAnswer | CollectorAnswer | undefined> {
    const message = parseMessage(raw);
    if (message === null) {
      void this.#steps.log('message.refused', { channel: 'content', reason: refusedWhy(raw) });
      return undefined;
    }
    const frame = this.#frameOf(sender);
    if (typeof frame === 'string') {
      void this.#steps.log('sender.refused', { reason: frame, type: message.type });
      return message.type === 'bootstrap/play' ? { inject: false } : { stop: true };
    }
    try {
      switch (message.type) {
        case 'bootstrap/play':
          return { inject: await this.#bootstrap(frame) };
        case 'collector/report':
          return { stop: !(await this.#report(frame, message)) };
        case 'collector/gone':
          this.#gone(frame);
          return { stop: true };
      }
    } catch (error: unknown) {
      void this.#steps.log('content.failed', { type: message.type, error: errorName(error) });
      return message.type === 'bootstrap/play' ? { inject: false } : { stop: false };
    }
  }

  /** The sender's tab and frame, or why it is refused. The message's own fields name nothing. */
  #frameOf(sender: ContentSender): FrameOrigin | string {
    const ids = senderIds(sender, this.#platform.extensionId);
    if (typeof ids === 'string') return ids;
    const { tabId, frameId } = ids;
    const isTop = frameId === 0;
    const { url, hostname } = frameAddress(sender, isTop);
    if (hostname === null) return 'no_site';
    const top = isTop
      ? { hostname, pathname: url?.pathname ?? null }
      : this.#topOf(tabId, httpUrl(sender.tab?.url));
    if (top.hostname === null) return 'no_top';
    return {
      tabId,
      frameId,
      documentId: documentIdOf(sender),
      isTop,
      incognito: sender.tab?.incognito === true,
      hostname,
      url,
      topHostname: top.hostname,
      topPathname: top.pathname,
    };
  }

  /**
   * A subframe's tab's top frame: Chrome's own word on the tab's URL first (visible on every site
   * the extension has access to); the top frame's last report only where Chrome does not say.
   */
  #topOf(
    tabId: number,
    tabUrl: URL | null,
  ): { readonly hostname: string | null; readonly pathname: string | null } {
    const known = this.#frames.get(tabId);
    const hostname = tabUrl?.hostname ?? known?.topHostname ?? null;
    const pathname =
      tabUrl !== null && tabUrl.hostname === hostname
        ? tabUrl.pathname
        : (known?.frames.get(0)?.pathname ?? null);
    return { hostname, pathname };
  }

  /** Both the frame's site and its tab's are tracked: the tab's site decides the service. */
  #tracked(frame: FrameOrigin, settings: SettingsValue): Decision {
    const top = decide(frame.topHostname, settings);
    if (top.kind === 'refused' || frame.isTop) return top;
    const own = decide(frame.hostname, settings);
    return own.kind === 'refused' ? own : top;
  }

  /**
   * The first `play` of a document: inject the collector when its site is tracked.
   * An embedded player's tab gets one in its top frame too, which knows the title.
   */
  async #bootstrap(frame: FrameOrigin): Promise<boolean> {
    const settings = await this.#platform.settings.get();
    if (
      this.#tracked(frame, settings).kind === 'refused' ||
      (frame.incognito && !settings.trackIncognito)
    ) {
      // The tab reported and is not tracked: its icon says so, and why.
      if (frame.isTop) {
        this.#frames.ensure(frame);
        await this.#status.refreshTab(frame.tabId);
      }
      return false;
    }
    const table = this.#frames.ensure(frame);
    // A video just started playing in the tab: a top frame without one is wanted from now.
    table.lastSampleAt = this.#platform.clock.now();
    const injected = await this.#platform.injector.inject({
      tabId: frame.tabId,
      frameId: frame.frameId,
      documentId: frame.documentId,
    });
    if (!frame.isTop) await this.#injectTop(table);
    // A tracked page, nothing recording yet: the outline mark.
    await this.#status.refreshTab(frame.tabId);
    return injected;
  }

  /**
   * A collector in the tab's top frame, when none reports, for a player in another frame: the
   * top frame is where the title is. Tried at most once per `TOP_RETRY_MS`; a collector that
   * runs reports well within it, and one that already runs is not doubled.
   */
  async #injectTop(table: TabFrames): Promise<void> {
    const now = this.#platform.clock.now();
    if (table.frames.has(0) || now < table.topRetryAt) return;
    table.topRetryAt = now + TOP_RETRY_MS;
    await this.#platform.injector.inject({ tabId: table.tabId, frameId: 0, documentId: null });
  }

  /** A frame's report into the tab's table; `false` when the collector must stop. */
  async #report(frame: FrameOrigin, message: CollectorReport): Promise<boolean> {
    const seq = (this.#seq += 1);
    const { clock, settings: settingsPort } = this.#platform;
    const settings = await settingsPort.get();
    const decision = this.#tracked(frame, settings);
    if (decision.kind === 'refused') return false;
    if (frame.incognito && !settings.trackIncognito) return false;
    // While paused nothing is observed, and the collector is kept for when tracking resumes.
    if (isPaused(settings.pausedUntil, clock.now())) return true;

    const table = this.#frames.ensure(frame);
    // A frame without a video is there to name what another frame plays: once nothing in the
    // tab has played for a while, its collector stops (the next sample brings one back).
    if (message.sample === null && clock.now() - table.lastSampleAt > SNAPSHOT_ONLY_IDLE_MS) {
      table.frames.delete(frame.frameId);
      return false;
    }
    const read = await this.#read(message.snapshot, frame, decision.site);
    // The tab closed (or was reset) while this report waited: it belongs to nothing now.
    if (!this.#frames.isCurrent(table)) return true;
    this.#keep(table, frame, { seq, sample: message.sample, site: decision.site, read });
    return true;
  }

  /**
   * What the worker reads of a report's snapshot: the snapshot as Chrome places it, with the
   * module's page state; its entry verdict on a site without a module; and, where the frame may
   * name a viewing, the generic readings and the module's.
   */
  async #read(reported: Snapshot | null, frame: FrameOrigin, site: SiteData | null): Promise<Read> {
    const pathname = frame.url?.pathname ?? '';
    const none: Read = { pathname, snapshot: null, reading: null, generic: [], verdict: null };
    if (reported === null) return none;
    const authoritative = this.#authoritative(reported, frame, site);
    // A snapshot the collector built on another path than the one Chrome now gives (built before
    // a same-document navigation, delivered after it) is about what the page showed there: it
    // names nothing, and the report's sample still counts.
    if (reported.url.pathname !== pathname.slice(0, SNAPSHOT_LIMITS.pathname)) {
      return { ...none, snapshot: authoritative };
    }
    const moduleSite = site?.module != null && siteForHostname(frame.hostname)?.id === site.id;
    if (site === null || !moduleSite) {
      // What may start a viewing on a site without a module: a page that says it is a film or
      // an episode. Any other frame's samples count; its readings do not, and its verdict says
      // why.
      const verdict = site?.module != null ? null : entryVerdict(authoritative);
      const generic = verdict === 'passes' ? readGeneric(authoritative) : [];
      return { ...none, snapshot: authoritative, generic, verdict };
    }
    // On a module's site, its frame names a viewing only on a player route.
    const snapshot = await this.#withPageState(authoritative, frame, site, pathname);
    if (!isPlayerRoute(site, pathname)) return { ...none, snapshot };
    const reading = await this.#interpret(site.id, snapshot);
    return { ...none, snapshot, reading, generic: readGeneric(snapshot) };
  }

  /**
   * The report in the tab's table, once its snapshot was read: the tab's facts, the frame's entry,
   * and the tab's next observation when the report brought a sample. Synchronous, so nothing else
   * runs between the table's facts and the entry they go with.
   */
  #keep(table: TabFrames, frame: FrameOrigin, report: Report): void {
    const now = this.#platform.clock.now();
    const { seq, site } = report;
    table.serviceId = site?.module != null ? site.id : null;
    table.incognito = frame.incognito;
    table.lastReportAt = now;
    if (frame.isTop) newPage(table, frame);
    const known = table.frames.get(frame.frameId);
    // A frame that loaded another document is a new frame: nothing of the old one carries over.
    const previous = known?.documentId === frame.documentId ? known : undefined;
    if (known === undefined && table.frames.size >= MAX_FRAMES_PER_TAB) return;
    const offRoute = offPlayerRoute(site, frame);
    const plausible = this.#plausible(report.sample, now);
    // Something plays there all the same: the popup says why it is not tracked.
    if (offRoute && plausible !== null && !plausible.paused && !plausible.ended) {
      this.#ignore(frame.tabId, 'not_player_page');
    }
    const sample = offRoute ? null : plausible;
    const entry = nextEntry(frame, previous, { seq, now, sample, read: report.read });
    table.frames.set(frame.frameId, entry);
    if (sample !== null) {
      table.lastSampleAt = now;
      // The player is in another frame: the top frame's collector names what it plays.
      if (!frame.isTop) void this.#injectTop(table);
      // A sample this report brought, not one a later report already replaced, is observed.
      if (entry.sampleSeq === seq) this.#frames.schedule(table);
    }
  }

  /**
   * The snapshot with its URL as Chrome reports the frame's (the site from `sender.url`): the
   * host and path, the query a snapshot keeps (`keptQuery`) and the hash. Its page state is the
   * worker's own reading alone (`#withPageState`), never the content script's.
   */
  #authoritative(snapshot: Snapshot, frame: FrameOrigin, site: SiteData | null): Snapshot {
    const url = frame.url;
    return {
      ...snapshot,
      url: {
        hostname: frame.hostname,
        pathname: (url?.pathname ?? '').slice(0, SNAPSHOT_LIMITS.pathname),
        query: url === null ? {} : keptQuery(url, site?.module ?? null),
        hash: (url?.hash ?? '').slice(0, SNAPSHOT_LIMITS.hash),
      },
      pageState: {},
    };
  }

  /**
   * The module's declared page state, read by the worker's reader in the frame — on a player
   * route only, the route's capture groups handed to it — within the bounds. `snapshot` carries
   * none of its own (`#authoritative`).
   */
  async #withPageState(
    snapshot: Snapshot,
    frame: FrameOrigin,
    site: SiteData,
    pathname: string,
  ): Promise<Snapshot> {
    const module = site.module;
    const paths = module?.collect.pageState;
    if (module === null || paths === undefined || Object.keys(paths).length === 0) return snapshot;
    const routeGroups = playerRouteGroups(site, pathname);
    if (routeGroups === null) return snapshot;
    let read: Readonly<Record<string, unknown>>;
    try {
      read = await this.#platform.pageState.read(
        { tabId: frame.tabId, frameId: frame.frameId, documentId: frame.documentId },
        paths,
        module.allowedCalls,
        routeGroups,
      );
    } catch {
      return snapshot;
    }
    const pageState: Record<string, unknown> = {};
    for (const name of Object.keys(paths)) {
      if (!Object.hasOwn(read, name)) continue;
      const value = read[name];
      const fits = withinJsonBudget(value, {
        maxDepth: SNAPSHOT_LIMITS.pageStateDepth,
        maxNodes: SNAPSHOT_LIMITS.jsonNodes,
        maxChars: SNAPSHOT_LIMITS.pageStateChars,
      });
      if (fits) pageState[name] = value;
    }
    return { ...snapshot, pageState };
  }

  /** The module's reading of a snapshot; one it read before is not asked again. */
  async #interpret(serviceId: string, snapshot: Snapshot): Promise<ServiceReading | null> {
    const key = await this.#interpretations.keyOf(serviceId, snapshot);
    const known = this.#interpretations.get(key);
    if (known !== undefined) return known;
    try {
      const reading = await this.#platform.interpreter.interpret(serviceId, snapshot);
      if (reading !== null) this.#interpretations.set(key, reading);
      return reading;
    } catch (error: unknown) {
      void this.#steps.log('interpret.failed', { serviceId, error: errorName(error) });
      return null;
    }
  }

  /** A sample whose clock is far from the worker's (a frozen page, a skewed clock) is none. */
  #plausible(sample: PlaybackSample | null, now: EpochMs): PlaybackSample | null {
    if (sample === null) return null;
    return sample.at < now - SAMPLE_MAX_AGE_MS || sample.at > now + SAMPLE_MAX_LEAD_MS
      ? null
      : sample;
  }

  #gone(frame: FrameOrigin): void {
    this.#frames.get(frame.tabId)?.frames.delete(frame.frameId);
  }
}

/**
 * The sender's tab and frame as Chrome names them, or why the sender is refused: another
 * extension, no tab or frame, or a document no longer active (in the back/forward cache).
 */
function senderIds(
  sender: ContentSender,
  extensionId: string,
): { readonly tabId: number; readonly frameId: number } | string {
  if (sender.id !== extensionId) return 'foreign';
  const tabId = sender.tab?.id;
  if (tabId === undefined || !Number.isInteger(tabId) || tabId < 0) return 'no_tab';
  const frameId = sender.frameId;
  if (frameId === undefined || !Number.isInteger(frameId) || frameId < 0) return 'no_frame';
  if (sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active') {
    return 'inactive';
  }
  return { tabId, frameId };
}

/**
 * The frame's address and its site. `sender.url` is the address the document's script context
 * was created at: it stays put across a same-document navigation (`history.pushState` —
 * Netflix's browse → watch, its autoplay into the next episode). The top frame's current address
 * is the tab's, Chrome's word too, taken only on the document's own origin: the site never comes
 * from anywhere else. A subframe stays at its first address: following its in-page navigation
 * would need the `webNavigation` permission, and no module's player route lives in a subframe
 * yet. A frame with no web address of its own (`about:blank`, `blob:`) is its origin's site.
 */
function frameAddress(
  sender: ContentSender,
  isTop: boolean,
): { readonly url: URL | null; readonly hostname: string | null } {
  const own = httpUrl(sender.url);
  const current = isTop ? httpUrl(sender.tab?.url) : null;
  const url = own !== null && current !== null && current.origin === own.origin ? current : own;
  return { url, hostname: url?.hostname ?? httpUrl(sender.origin)?.hostname ?? null };
}

/** Chrome's id of the sender's document, when it is one (bounded); else `null`. */
function documentIdOf(sender: ContentSender): string | null {
  const id = sender.documentId;
  return typeof id === 'string' && id.length <= 128 ? id : null;
}

/** What the worker read of a report's snapshot, on the frame's path now. */
interface Read {
  readonly pathname: string;
  /** `null`: the report brought none. */
  readonly snapshot: Snapshot | null;
  readonly reading: ServiceReading | null;
  readonly generic: readonly ServiceReading[];
  readonly verdict: EntryVerdict | null;
}

/** One report as the table keeps it: its order, its sample, the tab's site, what was read. */
interface Report {
  readonly seq: number;
  readonly sample: PlaybackSample | null;
  readonly site: SiteData | null;
  readonly read: Read;
}

/**
 * A top frame that loaded another document is a new page in the tab: the other frames were the
 * previous page's, readings and all.
 */
function newPage(table: TabFrames, frame: FrameOrigin): void {
  if (frame.documentId === null || frame.documentId === table.topDocumentId) return;
  if (table.topDocumentId !== null) {
    for (const id of [...table.frames.keys()]) if (id !== 0) table.frames.delete(id);
  }
  table.topDocumentId = frame.documentId;
}

/**
 * On a module site a sample counts only while the tab's top frame is on a player route: off it
 * (Netflix's /browse, a title page) a billboard or a hover preview plays what nobody chose to
 * watch, often of an episode's own length. Every frame's sample is dropped before the core then;
 * a frame inside a player page still counts.
 */
function offPlayerRoute(site: SiteData | null, frame: FrameOrigin): boolean {
  return (
    site !== null &&
    site.module !== null &&
    (frame.topPathname === null || !isPlayerRoute(site, frame.topPathname))
  );
}

/**
 * The frame's entry after report `seq`. A report overtaken by a later one of the same frame (its
 * interpretation took longer) changes only what is older than itself.
 */
function nextEntry(
  frame: FrameOrigin,
  previous: FrameEntry | undefined,
  report: {
    readonly seq: number;
    readonly now: EpochMs;
    readonly sample: PlaybackSample | null;
    readonly read: Read;
  },
): FrameEntry {
  const { seq, now, sample, read } = report;
  const olderSample = previous !== undefined && seq <= previous.sampleSeq;
  return {
    frameId: frame.frameId,
    documentId: frame.documentId,
    isTop: frame.isTop,
    hostname: frame.hostname,
    pathname: read.pathname,
    receivedAt: now,
    sample: olderSample ? previous.sample : sample,
    sampleSeq: olderSample ? previous.sampleSeq : seq,
    observedSeq: previous?.observedSeq ?? 0,
    ...snapshotAfter(previous, seq, read),
  };
}

/** The entry's snapshot and what was read of it after report `seq`. */
function snapshotAfter(
  previous: FrameEntry | undefined,
  seq: number,
  read: Read,
): Pick<FrameEntry, 'snapshot' | 'snapshotSeq' | 'snapshotPath' | 'reading' | 'generic' | 'entry'> {
  const { pathname, snapshot, reading } = read;
  if (previous === undefined || (snapshot !== null && seq > previous.snapshotSeq)) {
    // Hidden controls take the title area away, not the title: on the same path, a reading of
    // the same id keeps the identity the frame's previous reading had.
    return {
      snapshot,
      snapshotSeq: seq,
      snapshotPath: pathname,
      reading:
        reading !== null && previous?.snapshotPath === pathname
          ? keepIdentity(reading, previous.reading)
          : reading,
      generic: read.generic,
      entry: read.verdict,
    };
  }
  // An older snapshot than the one kept changes nothing — but readings of a snapshot taken on
  // another path (the page navigated since) name nothing.
  const stale = previous.snapshotPath !== pathname;
  return {
    snapshot: previous.snapshot,
    snapshotSeq: previous.snapshotSeq,
    snapshotPath: previous.snapshotPath,
    reading: stale ? null : previous.reading,
    generic: stale ? [] : previous.generic,
    entry: stale ? null : previous.entry,
  };
}

/**
 * The query a snapshot keeps, within the bounds: a module's declared parameters, by their exact
 * names; on a site without one, only what the address reader reads — its parameters, by name in
 * any case, with a whole number — so a search box's `?s=<words>` is never kept.
 */
function keptQuery(url: URL, module: SiteData['module']): Record<string, string> {
  const query: Record<string, string> = {};
  if (module !== null) {
    for (const name of (module.collect.queryParams ?? []).slice(0, SNAPSHOT_LIMITS.queryParams)) {
      const value = url.searchParams.get(name);
      if (value !== null) query[name] = value.slice(0, SNAPSHOT_LIMITS.queryValue);
    }
    return query;
  }
  for (const [name, value] of url.searchParams) {
    if (Object.keys(query).length >= SNAPSHOT_LIMITS.queryParams) break;
    const read = ADDRESS_PARAMS.has(name.toLowerCase()) && DIGITS.test(value);
    if (read && value.length <= SNAPSHOT_LIMITS.queryValue) query[name] ??= value;
  }
  return query;
}
