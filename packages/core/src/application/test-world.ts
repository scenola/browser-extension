/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The use cases wired over the in-memory ports, for core's own tests.

import type { AccountRule } from '../domain/account-rule';
import type { ConnectionState } from '../domain/connection';
import type { PlaybackSample } from '../domain/coverage';
import type { FrameReport } from '../domain/frames';
import type { Field, ServiceReading } from '../domain/reading';
import type { SettingsValue } from '../domain/settings';
import { DAY_MS } from '../domain/time';
import type { EpochMs } from '../domain/time';
import { ClearHistory } from './clear-history';
import { ConfirmAccount, keyOf } from './confirm-account';
import { Connect } from './connect';
import { Disconnect } from './disconnect';
import { DrainOutbox } from './drain-outbox';
import { ExpireStale } from './expire-stale';
import { IngestObservation } from './ingest-observation';
import type { ObservationInput, ObservationResult } from './ingest-observation';
import { PauseTracking } from './pause-tracking';
import type { AccountKnown } from './ports';
import { RefreshReceipts } from './refresh-receipts';
import { ReportViewing } from './report-viewing';
import { SkipViewing } from './skip-viewing';
import { ViewingLock } from './viewing-lock';
import {
  FakeClock,
  FakePlaysGateway,
  FakeScheduler,
  InMemoryAccountData,
  InMemoryAccountRules,
  InMemoryConnectionRepo,
  InMemoryDiagnostics,
  InMemoryOutbox,
  InMemoryPlayHistory,
  InMemorySettings,
  InMemoryViewingStore,
  SequentialIds,
} from './testing/in-memory';

export const T0: EpochMs = Date.parse('2026-10-20T19:00:00Z');

export const CONNECTED: Extract<ConnectionState, { kind: 'connected' }> = {
  kind: 'connected',
  id: 'c1',
  strategy: 'pkce_dpop',
  connectedAt: T0 - DAY_MS,
  expiresAt: T0 + 30 * DAY_MS,
};

/** The account the world's connection acts for, as its check read it. */
export const ACCOUNT = 'a1:00000000000000000000000000000001';
/** Another person's account. */
export const OTHER_ACCOUNT = 'a1:00000000000000000000000000000002';

export function makeWorld(
  o: {
    settings?: Partial<SettingsValue>;
    /** The account's lines; the never-read rule (finish at 70 %, starts off) by default. */
    rule?: Partial<AccountRule>;
    connection?: ConnectionState;
    /** What the connection is known to act for; `ACCOUNT`, read, for a connected one. */
    known?: AccountKnown;
    now?: EpochMs;
    /** The wait *Send first* is bounded by; by default it never ends, so the pass decides. */
    delay?: (ms: number) => Promise<void>;
  } = {},
) {
  const clock = new FakeClock(o.now ?? T0, 120);
  const ids = new SequentialIds();
  const viewings = new InMemoryViewingStore();
  const outbox = new InMemoryOutbox();
  const history = new InMemoryPlayHistory();
  const state = o.connection ?? CONNECTED;
  const connection = new InMemoryConnectionRepo(
    state,
    o.known ?? (state.kind === 'none' ? { kind: 'none' } : { kind: 'read', key: ACCOUNT }),
  );
  const accountKey = async () => keyOf(await connection.account());
  const gateway = new FakePlaysGateway();
  const scheduler = new FakeScheduler(clock);
  const settings = new InMemorySettings(o.settings);
  const rules = new InMemoryAccountRules(o.rule);
  const diagnostics = new InMemoryDiagnostics();
  const lock = new ViewingLock();
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
  const ingest = new IngestObservation({
    viewings,
    settings,
    rules,
    clock,
    ids,
    report,
    lock,
    accountKey,
  });
  const account = new InMemoryAccountData({ connection, outbox, history, viewings });
  const confirm = new ConfirmAccount({ connection, account, lock });
  const unread = { count: 0 };
  const notCounted = { count: 0 };
  const drainWith = () =>
    new DrainOutbox({
      outbox,
      history,
      connection,
      gateway,
      clock,
      scheduler,
      random: () => 0.5,
      onNotCounted: () => {
        notCounted.count += 1;
      },
      onAccountUnread: () => {
        unread.count += 1;
      },
    });
  const drain = drainWith();
  // Every pass a disconnect waits for: the tests' own drains, which they await themselves.
  const inflight = new Set<Promise<unknown>>();
  const connect: Connect = new Connect({
    connection,
    outbox,
    clock,
    scheduler,
    leftovers: { finish: () => disconnect.finish() },
  });
  const disconnect: Disconnect = new Disconnect({
    connection,
    account,
    outbox,
    scheduler,
    lock,
    drainAll: () => drain.execute({ early: true }),
    settled: async () => {
      await Promise.allSettled([...inflight]);
    },
    connecting: () => connect.idle(),
    delay: o.delay ?? (() => new Promise<void>(() => undefined)),
  });
  return {
    account,
    accountKey,
    confirm,
    unread,
    inflight,
    rules,
    notCounted,
    clock,
    ids,
    viewings,
    outbox,
    history,
    connection,
    gateway,
    scheduler,
    settings,
    diagnostics,
    lock,
    report,
    ingest,
    drainWith,
    drain,
    refresh: new RefreshReceipts({ history, gateway, connection, outbox, clock, scheduler }),
    connect,
    disconnect,
    expire: new ExpireStale({
      viewings,
      history,
      outbox,
      diagnostics,
      settings,
      rules,
      clock,
      scheduler,
      report,
      lock,
    }),
    skip: new SkipViewing({ viewings, lock }),
    pause: new PauseTracking({ settings, clock }),
    clearHistory: new ClearHistory({ history, report, lock }),
  };
}

export type World = ReturnType<typeof makeWorld>;

function sample(at: EpochMs, position: number, o: Partial<PlaybackSample> = {}): PlaybackSample {
  return {
    at,
    position,
    duration: 1000,
    paused: false,
    ended: false,
    rate: 1,
    adPlaying: false,
    muted: false,
    visibleArea: 1,
    ...o,
  };
}

const mod = <T>(value: T): Field<T> => ({ value, confidence: 1, source: 'module' });

export const episodeReading = (episode: number, o: ServiceReading = {}): ServiceReading => ({
  kind: mod('episode'),
  showTitle: mod('Show'),
  season: mod(1),
  episode: mod(episode),
  episodeTitle: mod(`Chapter ${String(episode)}`),
  ...o,
});

export const filmReading = (title: string, year?: number): ServiceReading => ({
  kind: mod('movie'),
  title: mod(title),
  ...(year === undefined ? {} : { year: mod(year) }),
});

const frameOf = (
  s: PlaybackSample | null,
  reading: ServiceReading | null,
): readonly FrameReport[] => [{ frameId: 0, isTop: true, sample: s, reading, generic: [] }];

export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value');
  return value;
}

const STEP_S = 15;

interface ObserveOptions {
  readonly tabId?: number;
  readonly sample?: Partial<PlaybackSample>;
  readonly serviceId?: string | null;
  readonly incognito?: boolean;
}

/** One observation's input at the clock's current time; the clock does not move. */
export function observation(
  w: World,
  reading: ServiceReading | null,
  position: number,
  o: ObserveOptions = {},
): ObservationInput {
  return {
    tabId: o.tabId ?? 1,
    incognito: o.incognito ?? false,
    serviceId: o.serviceId ?? null,
    frames: frameOf(sample(w.clock.now(), position, o.sample), reading),
  };
}

/** One observation at the clock's current time, then the clock moves on by one sample interval. */
export async function observe(
  w: World,
  reading: ServiceReading | null,
  position: number,
  o: ObserveOptions = {},
): Promise<ObservationResult> {
  const result = await w.ingest.execute(observation(w, reading, position, o));
  w.clock.advance(STEP_S * 1000);
  return result;
}

/** Plays `from`..`to` (inclusive) in `STEP_S` steps of continuous playback. */
export async function watch(
  w: World,
  reading: ServiceReading,
  from: number,
  to: number,
  o: ObserveOptions = {},
): Promise<ObservationResult[]> {
  const results: ObservationResult[] = [];
  for (let p = from; p <= to; p += STEP_S) results.push(await observe(w, reading, p, o));
  return results;
}
