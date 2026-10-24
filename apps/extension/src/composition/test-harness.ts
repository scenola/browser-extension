/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The composition root's test harness, imported by the root-*.test.ts files only: the root over
// in-memory ports and a fake interpreter, and what a collector sends, the way Chrome hands it to
// the worker — a message and its sender. Each test file calls `useRootTestEnvironment()` once.

import 'fake-indexeddb/auto';

import { DEFAULT_RULE, uuidv7 } from '@mt/core';
import type {
  AccountRule,
  ConnectionCheckResult,
  ConnectionGateway,
  ConnectionState,
  Ids,
  PlaybackSample,
  ServiceReading,
  Snapshot,
} from '@mt/core';
import {
  FakeClock,
  FakeInterpreter,
  FakePlaysGateway,
  FakeScheduler,
  InMemoryAccountData,
  InMemoryConnectionRepo,
  InMemoryOutbox,
  InMemoryPlayHistory,
  InMemorySettings,
  InMemoryViewingStore,
  RecordingStatusDisplay,
} from '@mt/core/testing';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, vi } from 'vitest';

import type { SitePermissions } from '../platform/site-permissions';
import type {
  AccountRuleRecord,
  AccountRuleStore,
  AppSettings,
  BootstrapInjector,
  ConnectionCheckRecord,
  ConnectionCheckStore,
  FrameTarget,
  OpenFrame,
} from './ports';
import { createRoot } from './root';
import type { PlatformDeps, Root } from './root';

const EXTENSION_ID = 'test-extension-id';
export const T0 = Date.UTC(2026, 9, 20, 19, 40);
export const DAY = 86_400_000;
export const API = 'http://localhost:8000';

// ── fakes ──────────────────────────────────────────────────────────────────────────────────

export class TestSettings extends InMemorySettings implements AppSettings {
  reset(): Promise<void> {
    return this.patch({
      pausedUntil: null,
      trackIncognito: false,
      disabledServices: [],
      excludedHosts: [],
      allowedHosts: [],
      allSites: false,
      diagnostics: false,
    });
  }
}

/** `SitePermissions` (platform/site-permissions.ts), every member a mock. */
function fakePermissions(granted: readonly string[] = []) {
  const permissions = {
    request: vi.fn(() => Promise.resolve(false)),
    allSites: vi.fn(() => Promise.resolve(false)),
    has: vi.fn((origin: string) => Promise.resolve(granted.includes(origin))),
    hasAllSites: vi.fn(() => Promise.resolve(false)),
    forget: vi.fn(() => Promise.resolve()),
    forgetAll: vi.fn(() => Promise.resolve()),
    reconcile: vi.fn(() => Promise.resolve()),
  };
  return permissions satisfies SitePermissions;
}

const diagnosticsLog = () => ({
  log: vi.fn(() => Promise.resolve()),
  list: vi.fn(() => Promise.resolve([])),
  clear: vi.fn(() => Promise.resolve()),
  prune: vi.fn(() => Promise.resolve()),
});

/** UUIDv7 play ids (the real gateway refuses any other), on the test's clock. */
export function uuidIds(clock: FakeClock): Ids {
  let n = 0;
  const bytes = (size: number) => {
    n += 1;
    return new Uint8Array(size).fill(n % 256);
  };
  return { playId: () => uuidv7(clock.now(), bytes), viewingId: () => uuidv7(clock.now(), bytes) };
}

export const CONNECTED_ID = 'conn-1';

export const CONNECTED: Extract<ConnectionState, { kind: 'connected' }> = {
  kind: 'connected',
  id: CONNECTED_ID,
  strategy: 'personal_token',
  connectedAt: T0 - DAY,
  expiresAt: T0 + 80 * DAY,
};

/** The account the connection acts for, as its checks name it. */
export const ROOT_ACCOUNT = 'a1:0000000000000000000000000000000a';

/** `ConnectionCheckStore` in memory: what `storage.session` holds across one worker's restart. */
export class MemoryCheckStore implements ConnectionCheckStore {
  record: ConnectionCheckRecord | null = null;

  get(): Promise<ConnectionCheckRecord | null> {
    return Promise.resolve(this.record);
  }

  set(record: ConnectionCheckRecord | null): Promise<void> {
    this.record = record;
    return Promise.resolve();
  }
}

/** `AccountRuleStore` in memory: what `storage.local` holds across restarts. */
class MemoryRuleStore implements AccountRuleStore {
  record: AccountRuleRecord | null = null;

  get(): Promise<AccountRuleRecord | null> {
    return Promise.resolve(this.record);
  }

  set(record: AccountRuleRecord | null): Promise<void> {
    this.record = record;
    return Promise.resolve();
  }
}

/** `GET /v1/integrations/connection` answering `answer` (or what it computes), counted. */
function fakeCheck(answer: ConnectionCheckResult | (() => Promise<ConnectionCheckResult>)) {
  return {
    check: vi.fn(() => (typeof answer === 'function' ? answer() : Promise.resolve(answer))),
  } satisfies ConnectionGateway;
}

export interface Harness {
  readonly root: Root;
  readonly clock: FakeClock;
  readonly status: RecordingStatusDisplay;
  readonly checker: ReturnType<typeof fakeCheck>;
  readonly checks: MemoryCheckStore;
  readonly rules: MemoryRuleStore;
  readonly diagnostics: ReturnType<typeof diagnosticsLog>;
  readonly viewings: InMemoryViewingStore;
  readonly outbox: InMemoryOutbox;
  readonly history: InMemoryPlayHistory;
  readonly connection: InMemoryConnectionRepo;
  readonly account: InMemoryAccountData;
  readonly settings: TestSettings;
  readonly gateway: FakePlaysGateway;
  readonly interpreter: FakeInterpreter;
  readonly permissions: ReturnType<typeof fakePermissions>;
  readonly injector: { inject: ReturnType<typeof vi.fn> };
  readonly bootstrap: ReturnType<typeof fakeBootstrap>;
  readonly wipe: ReturnType<typeof vi.fn>;
  readonly deps: PlatformDeps;
}

/** A tab open before the extension could run in it, with its frames' origins. */
export interface OpenTab {
  readonly tabId: number;
  readonly url: string;
  readonly frames: readonly OpenFrame[];
}

/**
 * `BootstrapInjector` over `tabs`: the URL patterns match as Chrome's `https://host/*` do, by
 * prefix (all a test here asks of them).
 */
function fakeBootstrap(tabs: readonly OpenTab[]) {
  const matches = (url: string, patterns: readonly string[]): boolean =>
    patterns.some((pattern) => url.startsWith(pattern.replace(/\*$/u, '')));
  return {
    openTabs: vi.fn((patterns?: readonly string[]) =>
      Promise.resolve(
        tabs
          .filter((tab) => patterns === undefined || matches(tab.url, patterns))
          .map(({ tabId, url }) => ({ tabId, url })),
      ),
    ),
    framesOf: vi.fn((tabId: number) =>
      Promise.resolve(tabs.find((tab) => tab.tabId === tabId)?.frames ?? []),
    ),
    inject: vi.fn((target: FrameTarget) => Promise.resolve(target.tabId >= 0)),
  } satisfies BootstrapInjector;
}

export interface HarnessOptions {
  readonly settings?: Partial<Parameters<InMemorySettings['patch']>[0]>;
  readonly interpret?: (serviceId: string, snapshot: Snapshot) => ServiceReading | null;
  readonly pageState?: Readonly<Record<string, unknown>>;
  readonly strategies?: PlatformDeps['strategies'];
  readonly granted?: readonly string[];
  readonly openTabs?: readonly OpenTab[];
  /** The URL Chrome shows of every tab (`tabs.get`): with `activeTab`, the popup's own. */
  readonly tabUrl?: string | null;
  /** What `GET /v1/integrations/connection` answers; no answer by default. */
  readonly check?: ConnectionCheckResult | (() => Promise<ConnectionCheckResult>);
  readonly checks?: MemoryCheckStore;
  /** The account's rule an earlier check kept for the connection; `null`: none was read. */
  readonly ruleKept?: AccountRule | null;
  readonly overrides?: Partial<PlatformDeps>;
}

/**
 * The root's tests run at a 50 % finish line, the lowest an account may choose,
 * so the 150 s fixture film — whose first 15 s pass before the tab binds — counts when it is
 * watched to the end. The lines themselves are core's to test.
 */
const ROOT_RULE: AccountRule = { ...DEFAULT_RULE, finishThresholdPercent: 50 };

export function harness(options: HarnessOptions = {}): Harness {
  const clock = new FakeClock(T0, 120);
  const viewings = new InMemoryViewingStore();
  const outbox = new InMemoryOutbox();
  const history = new InMemoryPlayHistory();
  const connection = new InMemoryConnectionRepo(CONNECTED, { kind: 'read', key: ROOT_ACCOUNT });
  const account = new InMemoryAccountData({ connection, outbox, history, viewings });
  const settings = new TestSettings(options.settings ?? {});
  const gateway = new FakePlaysGateway();
  const interpreter = new FakeInterpreter(options.interpret ?? (() => null));
  const permissions = fakePermissions(options.granted);
  const injector = { inject: vi.fn(() => Promise.resolve(true)) };
  const bootstrap = fakeBootstrap(options.openTabs ?? []);
  const wipe = vi.fn(() => Promise.resolve());
  const status = new RecordingStatusDisplay();
  const checker = fakeCheck(options.check ?? { kind: 'unavailable', detail: 'not_scripted' });
  const checks = options.checks ?? new MemoryCheckStore();
  const rules = new MemoryRuleStore();
  if (options.ruleKept !== null) {
    rules.record = { connectionId: CONNECTED_ID, rule: options.ruleKept ?? ROOT_RULE };
  }
  const diagnostics = diagnosticsLog();
  const tabUrl = options.tabUrl ?? null;
  const deps: PlatformDeps = {
    clock,
    ids: uuidIds(clock),
    random: () => 0.5,
    viewings,
    outbox,
    history,
    connection,
    account,
    scheduler: new FakeScheduler(clock),
    status,
    settings,
    permissions,
    interpreter,
    gateway,
    connectionGateway: checker,
    connectionChecks: checks,
    accountRules: rules,
    strategies: options.strategies ?? [],
    pageState: { read: vi.fn(() => Promise.resolve(options.pageState ?? {})) },
    injector,
    bootstrap,
    tabs: {
      active: () => Promise.resolve(null),
      get: () => Promise.resolve({ url: tabUrl, audible: false, incognito: false }),
    },
    diagnostics,
    wipe,
    extensionId: EXTENSION_ID,
    webAppBaseUrl: 'http://localhost:3000',
    buildMode: 'development',
    ...options.overrides,
  };
  return {
    root: createRoot(deps),
    clock,
    status,
    checker,
    checks,
    rules,
    diagnostics,
    viewings,
    outbox,
    history,
    connection,
    account,
    settings,
    gateway,
    interpreter,
    permissions,
    injector,
    bootstrap,
    wipe,
    deps,
  };
}

// ── what a collector sends ─────────────────────────────────────────────────────────────────

/** A 150 s film (a film must run at least 120 s), played at 1× with sound, most of the viewport. */
export const FILM_SECONDS = 150;

export function sampleAt(
  clock: FakeClock,
  position: number,
  extra: Partial<PlaybackSample> = {},
): PlaybackSample {
  return {
    at: clock.now(),
    position,
    duration: FILM_SECONDS,
    paused: false,
    ended: false,
    rate: 1,
    adPlaying: false,
    muted: false,
    visibleArea: 0.8,
    ...extra,
  };
}

export function snapshotOf(url: string, extra: Partial<Snapshot> = {}): Snapshot {
  const u = new URL(url);
  return {
    url: { hostname: u.hostname, pathname: u.pathname, query: {}, hash: '' },
    lang: 'en',
    documentTitle: '',
    selectors: {},
    jsonLd: [],
    mediaSession: null,
    openGraph: {},
    pageState: {},
    signals: { endOfContent: false, adPlaying: false },
    ...extra,
  };
}

/** JSON-LD `Movie` passes the entry rule. */
const ARRIVAL_JSON_LD = [
  {
    '@context': 'https://schema.org',
    '@type': 'Movie',
    name: 'Arrival',
    datePublished: '2016-11-11',
  },
];

export const PRIME_FILM = 'https://www.primevideo.com/detail/arrival';
export const NETFLIX_WATCH = 'https://www.netflix.com/watch/70196253';

export const filmSnapshot = (url: string): Snapshot =>
  snapshotOf(url, { jsonLd: ARRIVAL_JSON_LD, documentTitle: 'Arrival' });

export interface FrameAt {
  readonly tabId: number;
  readonly frameId: number;
  /** The frame's current address: where its document is now. */
  readonly url: string;
  /** The tab's URL as Chrome reports it; the frame's own address by default. */
  readonly tabUrl?: string;
  readonly senderId?: string;
  /** Another document in the same frame (a cross-document navigation); one per frame by default. */
  readonly documentId?: string;
}

/** Each document's first address, as Chrome keeps it in `sender.url` (reset for every test). */
const firstAddresses = new Map<string, string>();

/**
 * The sender as Chrome builds it: `url` is the address the document's script
 * context was created at, and stays put across a same-document navigation
 * (`history.pushState`); `tab.url` follows the frame's current address.
 */
export function sender(frame: FrameAt) {
  const documentId = frame.documentId ?? `doc-${String(frame.tabId)}-${String(frame.frameId)}`;
  const first = firstAddresses.get(documentId) ?? frame.url;
  firstAddresses.set(documentId, first);
  return {
    id: frame.senderId ?? EXTENSION_ID,
    url: first,
    origin: new URL(first).origin,
    frameId: frame.frameId,
    documentId,
    documentLifecycle: 'active',
    tab: { id: frame.tabId, url: frame.tabUrl ?? frame.url, incognito: false },
  };
}

export function report(
  h: Harness,
  frame: FrameAt,
  sample: PlaybackSample | null,
  snapshot: Snapshot | null,
): ReturnType<Root['onContentMessage']> {
  return h.root.onContentMessage(
    { v: 1, type: 'collector/report', isTop: frame.frameId === 0, sample, snapshot },
    sender(frame),
  );
}

/** Lets the 250 ms coalescing window close and what it started run. */
export async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(300);
  for (let i = 0; i < 30; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** One sample of a film every 15 s at `positions`, each observed on its own. */
export async function playFilm(
  h: Harness,
  frame: FrameAt,
  positions: readonly number[],
  snapshot: Snapshot = filmSnapshot(frame.url),
  startAt = 0,
): Promise<void> {
  for (const [i, position] of positions.entries()) {
    h.clock.set(T0 + (startAt + i * 15) * 1000);
    const sample = sampleAt(h.clock, position, { ended: position >= FILM_SECONDS });
    await report(h, frame, sample, snapshot);
    await settle();
  }
}

/** Positions 0, 15, …, 150: the whole film, at 1×. */
export const WHOLE_FILM = Array.from({ length: 11 }, (_, i) => i * 15);

/** Positions every 15 s, from 0 to `last` seconds. */
export const everyFifteen = (last: number): number[] =>
  Array.from({ length: last / 15 + 1 }, (_, i) => i * 15);

/** Fake timers, a fresh IndexedDB, and Chrome's first addresses forgotten, for every test. */
export function useRootTestEnvironment(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.stubGlobal('indexedDB', new IDBFactory());
    firstAddresses.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
}

// ── a Netflix-like site ──────────────────────────────────────────────────────────────────────

export const NETFLIX_BROWSE = 'https://www.netflix.com/browse';
export const EPISODE_A = 'https://www.netflix.com/watch/80000003';
export const EPISODE_B = 'https://www.netflix.com/watch/80000004';
export const KEY_A = 'svc:netflix:80000003';
export const KEY_B = 'svc:netflix:80000004';

const moduleField = <T>(value: T) => ({ value, confidence: 0.8, source: 'module' as const });

/**
 * A stand-in for the Netflix module, which the worker never imports: the route's id
 * is the title's own; the title area's heading names an episode of that show; without the title
 * area the reading names nothing of its own.
 */
export function netflixLike(_serviceId: string, snapshot: Snapshot): ServiceReading | null {
  const id = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?watch\/(\d+)/u.exec(snapshot.url.pathname)?.[1];
  if (id === undefined) return null;
  const show = snapshot.selectors.titleHeading?.[0];
  return {
    ...(show === undefined
      ? {}
      : { kind: moduleField('episode' as const), showTitle: moduleField(show) }),
    providerIds: [{ level: 'title', key: 'videoId', value: id }],
    contentEnded: false,
  };
}

/** A Netflix player page with its title area: the show, the label, the episode's title. */
export function episodeSnapshot(url: string, label = 'Еп. 3', title = 'Де моя трава?'): Snapshot {
  return snapshotOf(url, {
    documentTitle: 'Netflix',
    selectors: { titleHeading: ['Джентльмени'], titleParts: [label, title] },
  });
}

export const keysOf = (h: Harness): string[] => h.viewings.all().map((v) => v.key);

// ── a site without a module whose page names nothing ─────────────────────────────────────────

/** What Chrome says of a tab without the `tabs` permission; a test changes it as it goes. */
export interface Facts {
  url: string | null;
  audible: boolean;
  incognito: boolean;
}

export const tabFacts = (facts: Facts): Partial<PlatformDeps> => ({
  tabs: { active: () => Promise.resolve(null), get: () => Promise.resolve(facts) },
});

export const COURSES = 'https://courses.example/lecture-3';
/** A page whose video the extension may track, and which names no film or episode. */
export const lectureSnapshot = (): Snapshot =>
  snapshotOf(COURSES, {
    documentTitle: 'Lecture 3: Calculus',
    openGraph: { 'og:type': 'video.other', 'og:title': 'Lecture 3: Calculus' },
  });
export const COURSES_SETTINGS = { allowedHosts: ['courses.example'] } as const;

// ── asking and reading back ──────────────────────────────────────────────────────────────────

/** One `ui` request (`v: 1`, id 1), answered as the protocol answers. */
export async function askUi(h: Harness, request: Record<string, unknown>) {
  const answer = await h.root.onUiRequest({ v: 1, id: 1, ...request });
  if (answer === null) throw new Error('no answer');
  return answer.response;
}

/** `ui/disconnect` (deleting what is left) or `ui/clear`: the two ways the account leaves. */
export function leaving(type: string): Record<string, unknown> {
  return type === 'ui/disconnect' ? { type, sendFirst: false } : { type };
}

/** Lets the work a call started in the background run (the fake timers do not hold it). */
export async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** The diagnostics entries of one event, as the [event, detail] pairs they were logged with. */
export function loggedAs(h: Harness, event: string): [string, unknown][] {
  const calls = h.diagnostics.log.mock.calls as unknown as [string, unknown][];
  return calls.filter(([name]) => name === event);
}

/** The icon last shown for a tab (`null`: every tab's default), as the display recorded it. */
export const shownFor = (h: Harness, tabId: number | null) =>
  h.status.shown.filter((s) => s.tabId === tabId).at(-1)?.status;
